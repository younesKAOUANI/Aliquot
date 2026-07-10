import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { canonicalize } from '../common/canonical-json';
import { buildPage, decodeCursor } from '../common/cursor';
import type { Page } from '../common/cursor';
import { digestCanonical, digestOfDigestSet } from '../common/digest';
import { ConflictError, NotFoundError, ValidationError } from '../common/problem-details';
import { isUuid, uuidv7 } from '../common/uuid';
import { DatabaseService } from '../database/database.service';
import type { Trx } from '../database/database.service';
import type { RequestContext } from '../database/request-context';

/**
 * The record that a processing activity consumed some artifacts and produced
 * others.
 *
 * A derivation's identity is
 * `(inputs_digest, processor_name, processor_version, parameters_digest)` and
 * the unique constraint on those four columns *is* the worker's idempotency
 * guarantee (ADR-008). Nothing in this file locks, checks-then-acts, or
 * deduplicates in application code; it inserts and lets the constraint decide,
 * because the constraint is the only participant in that decision that
 * concurrent transactions agree on.
 *
 * Identity is taken over input *digests* rather than input artifact ids, and
 * over a set rather than a list. The set part is load-bearing immediately: the
 * same inputs listed in a different order are the same inputs, and a positional
 * digest would let an identical job run twice. The digest part is insurance --
 * `artifact_digest_unique_per_tenant` makes ids and digests interchangeable
 * today, so the two agree until artifact rows are ever minted again for content
 * that already existed, by a restore or an import, at which point an id-based
 * identity quietly stops recognising work it has already done.
 */

export interface DerivationOutputSpec {
  artifactId: string;
  logicalName: string;
}

export interface RecordDerivationInput {
  processorName: string;
  processorVersion: string;
  parameters: Record<string, unknown>;
  inputArtifactIds: string[];
  outputs: DerivationOutputSpec[];
  /** Run whose sealing triggered this work, for the "what did this run produce" query. */
  sourceRunId: string | null;
}

export interface RecordDerivationResult {
  derivationId: string;
  /** `false` when an identical derivation already existed. Not an error. */
  created: boolean;
}

/** A derivation as the API renders it, with the edges it is defined by. */
export interface DerivationView {
  id: string;
  processorName: string;
  processorVersion: string;
  parameters: Record<string, unknown>;
  parametersDigest: string;
  inputsDigest: string;
  startedAt: Date;
  completedAt: Date | null;
  sourceRunId: string | null;
  inputs: { artifactId: string; role: string }[];
  outputs: { artifactId: string; logicalName: string }[];
}

export interface DerivationListQuery {
  limit: number;
  cursor?: string;
}

@Injectable()
export class DerivationService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Record a derivation inside the caller's transaction.
   *
   * The conflict path is the interesting one, and treating it as success is the
   * whole point: a worker that wrote its output bytes and then crashed before
   * recording the derivation retries the entire job, recomputes byte-identical
   * output to a digest-derived storage key, and arrives back here with the same
   * four identity columns. Reporting that as an error would turn a converging
   * retry into a permanently failed job; reporting it as `created: false`
   * converges. This is why the constraint exists, and why nothing in the worker
   * needs to ask "have I already done this?" before starting.
   */
  async record(
    trx: Trx,
    ctx: RequestContext,
    input: RecordDerivationInput,
  ): Promise<RecordDerivationResult> {
    // The set digest already collapses duplicates; the join tables have a
    // (derivation_id, artifact_id) primary key that would raise on them.
    const inputArtifactIds = [...new Set(input.inputArtifactIds)];
    const outputs = dedupeOutputs(input.outputs);

    const digests = await this.digestsOf(trx, inputArtifactIds);
    await this.assertArtifactsExist(
      trx,
      outputs.map((output) => output.artifactId),
    );

    const inputsDigest = digestOfDigestSet(digests);
    const parametersDigest = digestCanonical(input.parameters);

    const inserted = await trx
      .insertInto('aliquot.derivation')
      .values({
        id: uuidv7(),
        tenant_id: ctx.tenantId,
        processor_name: input.processorName,
        processor_version: input.processorVersion,
        // Stored as the same bytes that were digested. jsonb renormalises key
        // order on the way in, so this is not a byte-for-byte guarantee -- but
        // it does mean the stored value and the digested value never differ by
        // anything except that renormalisation.
        parameters: sql<Record<string, unknown>>`${canonicalize(input.parameters)}::jsonb`,
        parameters_digest: parametersDigest,
        inputs_digest: inputsDigest,
        // `record` is called once the work is done, so start and completion are
        // the same instant from this transaction's point of view. Both come
        // from the database clock; a worker's own clock is not something the
        // provenance record should depend on.
        completed_at: sql<Date>`clock_timestamp()`,
        source_run_id: input.sourceRunId,
      })
      .onConflict((oc) => oc.constraint('derivation_identity_unique').doNothing())
      .returning('id')
      .executeTakeFirst();

    if (inserted) {
      await this.recordEdges(trx, ctx, inserted.id, inputArtifactIds, outputs);
      return { derivationId: inserted.id, created: true };
    }

    const derivationId = await this.existingId(trx, ctx, input, inputsDigest, parametersDigest);
    return { derivationId, created: false };
  }

  /**
   * The study a run belongs to, for authorising a read of its derivations.
   *
   * A separate call rather than a field on the listing because authorisation
   * has to precede the data it is authorising, and because row-level security
   * makes "not yours" and "does not exist" the same 404 either way.
   */
  async studyOfRun(ctx: RequestContext, runId: string): Promise<string> {
    return this.database.withTenant(ctx, async (trx) => {
      const run = await trx
        .selectFrom('aliquot.run')
        .select('study_id')
        .where('id', '=', runId)
        .executeTakeFirst();

      if (!run) {
        throw new NotFoundError('run', runId);
      }
      return run.study_id;
    });
  }

  /**
   * Derivations attributed to a run, newest first.
   *
   * Paged on `id` rather than on `started_at`. Ids are UUIDv7, so id order is
   * creation order, and a timestamp cursor would be worse than it looks:
   * `timestamptz` carries microseconds and a JavaScript `Date` carries
   * milliseconds, so a cursor built from one would silently skip rows that
   * shared a millisecond with the last row of the previous page.
   *
   * `source_run_id` is denormalised precisely so this question does not require
   * walking the artifact graph. A derivation with no source run -- work not
   * triggered by an acquisition -- is by definition not part of this answer.
   */
  async listForRun(
    ctx: RequestContext,
    runId: string,
    query: DerivationListQuery,
  ): Promise<Page<DerivationView>> {
    const before = query.cursor === undefined ? undefined : cursorId(query.cursor);

    return this.database.withTenant(ctx, async (trx) => {
      let statement = trx
        .selectFrom('aliquot.derivation')
        .select([
          'id',
          'processor_name',
          'processor_version',
          'parameters',
          'parameters_digest',
          'inputs_digest',
          'started_at',
          'completed_at',
          'source_run_id',
        ])
        // Redundant with the row-level security policy, and kept because it
        // makes derivation_source_run_idx usable rather than a filter.
        .where('tenant_id', '=', ctx.tenantId)
        .where('source_run_id', '=', runId)
        .orderBy('id', 'desc')
        .limit(query.limit + 1);

      if (before !== undefined) {
        statement = statement.where('id', '<', before);
      }

      const page = buildPage(await statement.execute(), query.limit, (row) => [row.id]);
      const ids = page.items.map((row) => row.id);

      const inputs = ids.length === 0 ? [] : await this.inputsOf(trx, ids);
      const outputs = ids.length === 0 ? [] : await this.outputsOf(trx, ids);

      return {
        items: page.items.map((row) => ({
          id: row.id,
          processorName: row.processor_name,
          processorVersion: row.processor_version,
          parameters: row.parameters,
          parametersDigest: row.parameters_digest,
          inputsDigest: row.inputs_digest,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          sourceRunId: row.source_run_id,
          inputs: inputs
            .filter((input) => input.derivation_id === row.id)
            .map((input) => ({ artifactId: input.artifact_id, role: input.role })),
          outputs: outputs
            .filter((output) => output.derivation_id === row.id)
            .map((output) => ({
              artifactId: output.artifact_id,
              logicalName: output.logical_name,
            })),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  private async inputsOf(
    trx: Trx,
    derivationIds: string[],
  ): Promise<{ derivation_id: string; artifact_id: string; role: string }[]> {
    return trx
      .selectFrom('aliquot.derivation_input')
      .select(['derivation_id', 'artifact_id', 'role'])
      .where('derivation_id', 'in', derivationIds)
      .execute();
  }

  private async outputsOf(
    trx: Trx,
    derivationIds: string[],
  ): Promise<{ derivation_id: string; artifact_id: string; logical_name: string }[]> {
    return trx
      .selectFrom('aliquot.derivation_output')
      .select(['derivation_id', 'artifact_id', 'logical_name'])
      .where('derivation_id', 'in', derivationIds)
      .execute();
  }

  /**
   * Digests of the input artifacts, in no particular order.
   *
   * A missing id is a 404 rather than a foreign key violation because under
   * row-level security the two are the same event: an artifact belonging to
   * another tenant is not visible here, and saying so would confirm it exists.
   */
  private async digestsOf(trx: Trx, artifactIds: string[]): Promise<string[]> {
    // A derivation with no inputs is legitimate -- a generator, a fixture
    // loader -- and its identity then rests on processor and parameters alone.
    if (artifactIds.length === 0) return [];

    const rows = await trx
      .selectFrom('aliquot.artifact')
      .select(['id', 'digest'])
      .where('id', 'in', artifactIds)
      .execute();

    const byId = new Map(rows.map((row) => [row.id, row.digest]));
    return artifactIds.map((id) => {
      const digest = byId.get(id);
      if (digest === undefined) {
        throw new NotFoundError('artifact', id);
      }
      return digest;
    });
  }

  private async assertArtifactsExist(trx: Trx, artifactIds: string[]): Promise<void> {
    if (artifactIds.length === 0) return;

    const rows = await trx
      .selectFrom('aliquot.artifact')
      .select('id')
      .where('id', 'in', artifactIds)
      .execute();

    const present = new Set(rows.map((row) => row.id));
    for (const id of artifactIds) {
      if (!present.has(id)) {
        throw new NotFoundError('artifact', id);
      }
    }
  }

  private async recordEdges(
    trx: Trx,
    ctx: RequestContext,
    derivationId: string,
    inputArtifactIds: string[],
    outputs: DerivationOutputSpec[],
  ): Promise<void> {
    if (inputArtifactIds.length > 0) {
      await trx
        .insertInto('aliquot.derivation_input')
        .values(
          inputArtifactIds.map((artifactId) => ({
            tenant_id: ctx.tenantId,
            derivation_id: derivationId,
            artifact_id: artifactId,
          })),
        )
        .execute();
    }

    if (outputs.length > 0) {
      await trx
        .insertInto('aliquot.derivation_output')
        .values(
          outputs.map((output) => ({
            tenant_id: ctx.tenantId,
            derivation_id: derivationId,
            artifact_id: output.artifactId,
            logical_name: output.logicalName,
          })),
        )
        .execute();
    }
  }

  /**
   * The id of the derivation we collided with.
   *
   * `ON CONFLICT DO NOTHING` does not wait for a concurrent inserter the way
   * `DO UPDATE` does -- it declines to take the speculative insertion lock and
   * simply inserts nothing -- so under READ COMMITTED this select can find no
   * row at all: the winner exists but has not committed. That is a genuine
   * outcome, not an impossible one, and it is reported as a retryable conflict
   * rather than papered over. The alternative, a no-op `DO UPDATE` purely to
   * acquire the lock, writes a new row version to every derivation that was
   * already correct.
   */
  private async existingId(
    trx: Trx,
    ctx: RequestContext,
    input: RecordDerivationInput,
    inputsDigest: string,
    parametersDigest: string,
  ): Promise<string> {
    const existing = await trx
      .selectFrom('aliquot.derivation')
      .select('id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('inputs_digest', '=', inputsDigest)
      .where('processor_name', '=', input.processorName)
      .where('processor_version', '=', input.processorVersion)
      .where('parameters_digest', '=', parametersDigest)
      .executeTakeFirst();

    if (!existing) {
      throw new ConflictError(
        `An identical derivation by ${input.processorName} ${input.processorVersion} is being ` +
          'recorded by another transaction. Retry once it commits.',
        { processorName: input.processorName, processorVersion: input.processorVersion },
      );
    }

    return existing.id;
  }
}

/**
 * Collapse repeated outputs, and refuse the case the schema cannot express.
 *
 * `derivation_output` is keyed on `(derivation_id, artifact_id)`, so one
 * activity cannot record the same content under two logical names. That is
 * reachable in practice -- two output files that happen to be byte-identical
 * deduplicate to a single artifact row -- and the honest response is to fail
 * rather than silently keep one name and drop the other, which would leave a
 * provenance record that is quietly incomplete.
 */
function cursorId(cursor: string): string {
  const [id] = decodeCursor(cursor, 1);
  if (id === undefined || !isUuid(id)) {
    throw new ValidationError('cursor is not a valid pagination cursor');
  }
  return id;
}

function dedupeOutputs(outputs: DerivationOutputSpec[]): DerivationOutputSpec[] {
  const byArtifact = new Map<string, DerivationOutputSpec>();

  for (const output of outputs) {
    const seen = byArtifact.get(output.artifactId);
    if (seen === undefined) {
      byArtifact.set(output.artifactId, output);
      continue;
    }
    if (seen.logicalName !== output.logicalName) {
      throw new ConflictError(
        `Outputs ${seen.logicalName} and ${output.logicalName} are byte-identical, and a ` +
          'derivation cannot record one artifact under two logical names.',
        { artifactId: output.artifactId, logicalNames: [seen.logicalName, output.logicalName] },
      );
    }
  }

  return [...byArtifact.values()];
}
