import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service';
import { buildPage, decodeCursor, isCursorNull } from '../common/cursor';
import type { Page } from '../common/cursor';
import {
  ConflictError,
  ForbiddenError,
  ManifestIncompleteError,
  NotFoundError,
  ValidationError,
} from '../common/problem-details';
import { isUuid, uuidv7 } from '../common/uuid';
import { DatabaseService } from '../database/database.service';
import type { Trx } from '../database/database.service';
import type { RequestContext } from '../database/request-context';
import type { ArtifactVerificationState, RunState, StudyRole } from '../database/schema';
import { AuthService } from '../identity/auth.service';
import { JobQueue } from '../processing/job-queue';
// The queue name is owned by the handler that serves it. Two literals that must
// match do not fail when they drift -- the producer and the consumer simply never
// meet, the run sits SEALED and the job sits PENDING, and nothing reports it.
import { RUN_PROCESSING_QUEUE } from '../processing/run-processor.job';
import type { IdempotentOutcome } from './idempotency.service';
import { IdempotencyService } from './idempotency.service';
import { ArtifactNotDeclaredError, assertWellFormedManifest, manifestDigest } from './manifest';
import type { ManifestEntry } from './manifest';
import { assertTransition } from './run-state-machine';

/**
 * Registration, sealing, abandonment, correction and search.
 *
 * Two rules shape almost every method here.
 *
 * The first is that authorisation happens *before* a transaction is opened, never
 * inside one. `AuthService.requireStudyRole` takes a connection of its own; called
 * from inside `withTenant`, a burst of concurrent requests would each hold a
 * connection while waiting for a free one, and a pool of ten deadlocks at ten
 * concurrent writers. The cost is an extra round trip to learn which study a run
 * belongs to, on a column that never moves after insert.
 *
 * The second is that the database owns the invariants. Sealing does not check
 * that a sealed run stays frozen -- the trigger does, and it does so for callers
 * this class has never heard of. What this class owes the trigger is ordering:
 * mark the manifest entry before the run leaves `OPEN`, because afterwards the
 * entry cannot be touched at all.
 */

/** Writes need an operator; an admin administers the study and is not excluded from it. */
const WRITE_ROLES: StudyRole[] = ['operator', 'admin'];
/** Anyone with a role on the study may read its runs. */
const READ_ROLES: StudyRole[] = ['operator', 'scientist', 'steward', 'admin'];

/**
 * A supersede chain is a handful of links in practice. The bound exists because
 * `supersedes_run_id` is only structurally acyclic while this service is the only
 * writer, and an unbounded recursive CTE over a cycle does not return.
 */
const MAX_SUPERSEDE_DEPTH = 64;

const SEARCH_CURSOR_ARITY = 2;

const RUN_SUMMARY_COLUMNS = [
  'id',
  'study_id',
  'instrument_id',
  'operator_id',
  'state',
  'acquired_at',
  'registered_at',
  'sealed_at',
  'quarantined_at',
  'abandoned_at',
  'supersedes_run_id',
  'supersede_reason',
  'manifest_digest',
  'quarantine_reason',
  'processing_attempts',
  'processing_started_at',
  'processing_completed_at',
  'processing_error',
] as const;

export interface RegisterRunInput {
  instrumentId: string;
  /** Defaults to the calling user. Required when an instrument credential registers. */
  operatorId?: string;
  /** ISO 8601. Client-declared and descriptive; never used for ordering. */
  acquiredAt?: string;
  protocol?: Record<string, unknown>;
  manifest: ManifestEntry[];
}

export interface SupersedeRunInput extends Partial<RegisterRunInput> {
  reason: string;
  manifest: ManifestEntry[];
}

export interface RunSummary {
  id: string;
  studyId: string;
  instrumentId: string;
  operatorId: string;
  state: RunState;
  acquiredAt: Date | null;
  registeredAt: Date;
  sealedAt: Date | null;
  quarantinedAt: Date | null;
  abandonedAt: Date | null;
  supersedesRunId: string | null;
  supersedeReason: string | null;
  manifestDigest: string;
  quarantineReason: string | null;
  processingAttempts: number;
  processingStartedAt: Date | null;
  processingCompletedAt: Date | null;
  processingError: string | null;
}

/**
 * A search result, which is a run summary plus the two names a human needs to
 * read a list.
 *
 * Only the list carries them. A caller fetching one run by id can afford a
 * lookup; a caller drawing twenty-five rows cannot afford fifty, and returning
 * a table of opaque identifiers pushes exactly that problem onto every client.
 */
export interface RunListItem extends RunSummary {
  studySlug: string;
  instrumentSlug: string;
}

export interface ManifestEntryView {
  id: string;
  logicalName: string;
  declaredDigest: string;
  /** bigint: a decimal string, never a number. */
  declaredSize: string;
  declaredMediaType: string;
  verificationState: ArtifactVerificationState;
  artifactId: string | null;
  verifiedAt: Date | null;
  rejectionReason: string | null;
}

export interface RunLink {
  runId: string;
  state: RunState;
  /** Why *this* run superseded its own predecessor. Null only on an original. */
  reason: string | null;
  registeredAt: Date;
  /** 1 is the immediate neighbour. */
  distance: number;
}

export interface RunDetail extends RunSummary {
  protocol: Record<string, unknown>;
  manifest: ManifestEntryView[];
  /** Runs this one corrects, nearest first. */
  supersedes: RunLink[];
  /** Runs that correct this one. A branch is possible; the database does not forbid it. */
  supersededBy: RunLink[];
}

export interface RunMutationResult {
  run: RunSummary;
  /** Sequence number of the audit event this call appended. */
  auditSeq: string;
}

export interface SealResult extends RunMutationResult {
  /** Null when a job for this run was already queued. */
  processingJobId: string | null;
}

export interface QuarantineResult {
  runId: string;
  state: RunState;
  /** Null when the caller quarantined the run without naming an artifact. */
  logicalName: string | null;
  /** Null when the run was already quarantined and nothing was written. */
  auditSeq: string | null;
}

export interface RunSearchQuery {
  limit: number;
  cursor?: string;
  studyId?: string;
  instrumentId?: string;
  operatorId?: string;
  state?: RunState[];
  acquiredFrom?: string;
  acquiredTo?: string;
}

interface RunSummaryRow {
  id: string;
  study_id: string;
  instrument_id: string;
  operator_id: string;
  state: RunState;
  acquired_at: Date | null;
  registered_at: Date;
  sealed_at: Date | null;
  quarantined_at: Date | null;
  abandoned_at: Date | null;
  supersedes_run_id: string | null;
  supersede_reason: string | null;
  manifest_digest: string;
  quarantine_reason: string | null;
  processing_attempts: number;
  processing_started_at: Date | null;
  processing_completed_at: Date | null;
  processing_error: string | null;
}

interface CreateRunParams {
  studyId: string;
  instrumentId: string;
  operatorId: string;
  acquiredAt: string | null;
  protocol: Record<string, unknown>;
  entries: ManifestEntry[];
  supersedesRunId: string | null;
  supersedeReason: string | null;
}

interface ChainRow {
  direction: string;
  id: string;
  state: RunState;
  supersede_reason: string | null;
  registered_at: Date;
  depth: number;
}

@Injectable()
export class RunService {
  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly jobs: JobQueue,
  ) {}

  /**
   * Register a run and its declared manifest.
   *
   * Everything that can be rejected without touching the database is rejected
   * before the idempotency key is claimed, so a malformed request does not
   * consume a key and does not have to be cleaned up after.
   */
  async register(
    ctx: RequestContext,
    studyId: string,
    input: RegisterRunInput,
    idempotencyKey: string | undefined,
  ): Promise<IdempotentOutcome<RunMutationResult>> {
    assertWellFormedManifest(input.manifest);
    const operatorId = resolveOperator(ctx, input.operatorId);
    await this.auth.requireStudyRole(ctx, studyId, WRITE_ROLES);

    return this.idempotency.execute(
      ctx,
      `POST /v1/studies/${studyId}/runs`,
      idempotencyKey,
      input,
      async (trx) => {
        const result = await this.createRun(trx, ctx, {
          studyId,
          instrumentId: input.instrumentId,
          operatorId,
          acquiredAt: input.acquiredAt ?? null,
          protocol: input.protocol ?? {},
          entries: input.manifest,
          supersedesRunId: null,
          supersedeReason: null,
        });

        return { status: 201, body: result, resourceId: result.run.id };
      },
    );
  }

  /**
   * Correct a run that can no longer be corrected in place (ADR-010).
   *
   * The predecessor is read and never written: a `superseded_by` column would
   * mean mutating a sealed run to record that it had been corrected, which is the
   * one thing sealing exists to forbid. The link points backwards only, and the
   * reverse direction is an index.
   */
  async supersede(
    ctx: RequestContext,
    runId: string,
    input: SupersedeRunInput,
    idempotencyKey: string | undefined,
  ): Promise<IdempotentOutcome<RunMutationResult>> {
    assertWellFormedManifest(input.manifest);
    const predecessor = await this.requireRunAccess(ctx, runId, WRITE_ROLES);

    // OPEN is excluded because an open run is still mutable -- there is nothing
    // to correct, only something to finish or abandon. ABANDONED is excluded
    // because an abandoned run never became a record of anything, so a correction
    // of it would assert a history that did not happen.
    if (predecessor.state === 'OPEN' || predecessor.state === 'ABANDONED') {
      throw new ConflictError(
        `Run ${runId} is ${predecessor.state}; only a run that has been sealed or quarantined ` +
          'can be superseded.',
        { runId, state: predecessor.state },
      );
    }

    const operatorId = resolveOperator(ctx, input.operatorId ?? predecessor.operatorId);

    return this.idempotency.execute(
      ctx,
      `POST /v1/runs/${runId}/supersede`,
      idempotencyKey,
      input,
      async (trx) => {
        const result = await this.createRun(trx, ctx, {
          studyId: predecessor.studyId,
          instrumentId: input.instrumentId ?? predecessor.instrumentId,
          operatorId,
          acquiredAt: input.acquiredAt ?? null,
          protocol: input.protocol ?? {},
          entries: input.manifest,
          supersedesRunId: runId,
          supersedeReason: input.reason,
        });

        // Recorded against the predecessor as well as the successor. Reading the
        // trail of the run that was cited in a paper has to show that it was
        // later corrected, and the predecessor's row cannot say so itself.
        const correction = await this.audit.append(trx, ctx, {
          action: 'run.superseded',
          targetType: 'run',
          targetId: runId,
          payload: {
            supersededRunId: runId,
            supersededByRunId: result.run.id,
            reason: input.reason,
            manifestDigest: result.run.manifestDigest,
          },
        });

        return {
          status: 201,
          body: { run: result.run, auditSeq: correction.seq },
          resourceId: result.run.id,
        };
      },
    );
  }

  /**
   * Seal a run: freeze it, and dispatch processing in the same transaction.
   *
   * The manifest digest is recomputed from the `run_artifact` rows and compared
   * with the one fixed at registration. Nothing in the schema lets those rows
   * change while the run is open -- the check is here because "nothing lets it
   * change" is a claim about code, and this is the last moment at which it can be
   * tested against the data.
   */
  async seal(
    ctx: RequestContext,
    runId: string,
    idempotencyKey: string | undefined,
  ): Promise<IdempotentOutcome<SealResult>> {
    await this.requireRunAccess(ctx, runId, WRITE_ROLES);

    return this.idempotency.execute(
      ctx,
      `POST /v1/runs/${runId}/seal`,
      idempotencyKey,
      {},
      async (trx) => {
        const body = await this.sealWithin(trx, ctx, runId);
        return { status: 200, body, resourceId: runId };
      },
    );
  }

  /**
   * Give up on an open run.
   *
   * The reason lives only in the audit event: `run` has no `abandoned_reason`
   * column, and inventing one would put an explanation on the row while the
   * account of who abandoned it and when is in the chain anyway.
   */
  async abandon(ctx: RequestContext, runId: string, reason: string): Promise<RunMutationResult> {
    await this.requireRunAccess(ctx, runId, WRITE_ROLES);

    return this.database.withTenant(ctx, async (trx) => {
      const current = await lockRun(trx, runId);
      assertTransition(runId, current.state, 'ABANDONED');

      const row = await trx
        .updateTable('aliquot.run')
        .set({ state: 'ABANDONED', abandoned_at: sql<Date>`clock_timestamp()` })
        .where('id', '=', runId)
        .returning(RUN_SUMMARY_COLUMNS)
        .executeTakeFirstOrThrow();

      const event = await this.audit.append(trx, ctx, {
        action: 'run.abandoned',
        targetType: 'run',
        targetId: runId,
        payload: { runId, reason },
      });

      return { run: toSummary(row), auditSeq: event.seq };
    });
  }

  /**
   * Quarantine a run whose stored bytes contradicted its declaration.
   *
   * Takes the caller's transaction because the upload module calls it as the
   * last statement of the verification that found the fault: the rejection, the
   * quarantine and the audit events are one commit, or the run is quarantined
   * with no record of why.
   *
   * `logicalName` is optional, and the difference matters. Supplied, this marks
   * the manifest entry `REJECTED` *before* moving the run, because
   * `enforce_run_artifact_immutability()` permits touching a manifest binding
   * only while the run is `OPEN` -- reversed, the rejection fails, rolls back the
   * quarantine, and the operator's first question has no answer. Omitted, the
   * caller has already marked the entry itself and this only moves the run.
   *
   * Authorisation is the caller's. This is an internal collaborator reached from
   * an endpoint that has already checked, and it has to work for a context with
   * no study membership at all.
   */
  async quarantine(
    trx: Trx,
    ctx: RequestContext,
    runId: string,
    reason: string,
    logicalName?: string,
  ): Promise<QuarantineResult> {
    const current = await lockRun(trx, runId);
    const entry =
      logicalName === undefined ? null : await this.findEntry(trx, ctx, runId, logicalName);

    // A retried upload completion finds the run already quarantined. That is the
    // same request arriving twice, not a second fault, and nothing further can be
    // recorded against a frozen run anyway. Answering with the state it produced
    // is more useful than a 409 the caller cannot act on.
    if (current.state === 'QUARANTINED' && (entry === null || entry.rejected)) {
      return { runId, state: current.state, logicalName: logicalName ?? null, auditSeq: null };
    }

    assertTransition(runId, current.state, 'QUARANTINED');

    if (entry !== null) {
      await trx
        .updateTable('aliquot.run_artifact')
        .set({
          verification_state: 'REJECTED',
          rejection_reason: reason,
          // Cleared with the state: `run_artifact_verified_has_artifact` ties the
          // binding to VERIFIED, so a rejected entry that kept its artifact
          // reference violates the constraint.
          artifact_id: null,
          verified_at: null,
        })
        .where('id', '=', entry.id)
        .execute();
    }

    await trx
      .updateTable('aliquot.run')
      .set({
        state: 'QUARANTINED',
        quarantine_reason: reason,
        quarantined_at: sql<Date>`clock_timestamp()`,
      })
      .where('id', '=', runId)
      .execute();

    const event = await this.audit.append(trx, ctx, {
      action: 'run.quarantined',
      targetType: 'run',
      targetId: runId,
      payload: { runId, logicalName: logicalName ?? null, reason },
    });

    return {
      runId,
      state: 'QUARANTINED',
      logicalName: logicalName ?? null,
      auditSeq: event.seq,
    };
  }

  /** The manifest entry, with the one fact quarantine needs about it. */
  private async findEntry(
    trx: Trx,
    ctx: RequestContext,
    runId: string,
    logicalName: string,
  ): Promise<{ id: string; rejected: boolean }> {
    const entry = await trx
      .selectFrom('aliquot.run_artifact')
      .select(['id', 'verification_state'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('run_id', '=', runId)
      .where('logical_name', '=', logicalName)
      .executeTakeFirst();

    if (!entry) {
      throw new ArtifactNotDeclaredError(runId, logicalName);
    }

    return { id: entry.id, rejected: entry.verification_state === 'REJECTED' };
  }

  /** A run with its manifest, its verification states, and its correction chain in both directions. */
  async get(ctx: RequestContext, runId: string): Promise<RunDetail> {
    const loaded = await this.database.withTenant(ctx, async (trx) => {
      const run = await trx
        .selectFrom('aliquot.run')
        .select(RUN_SUMMARY_COLUMNS)
        .select('protocol')
        .where('id', '=', runId)
        .executeTakeFirst();

      if (!run) {
        throw new NotFoundError('run', runId);
      }

      const manifest = await this.loadManifest(trx, ctx, runId);
      const chain = await this.loadSupersedeChain(trx, runId);
      return { run, manifest, chain };
    });

    // After the read rather than before it, for the pool reason in the class
    // comment. Nothing has left the process: the check throws before the caller
    // sees a byte, and row-level security has already confined the read to the
    // caller's own tenant.
    await this.auth.requireStudyRole(ctx, loaded.run.study_id, READ_ROLES);

    return {
      ...toSummary(loaded.run),
      protocol: loaded.run.protocol,
      manifest: loaded.manifest,
      supersedes: loaded.chain.supersedes,
      supersededBy: loaded.chain.supersededBy,
    };
  }

  /**
   * Search runs, newest acquisition first (R9).
   *
   * Ordered by `(acquired_at desc, id desc)`, which is the physical order of
   * `run_search_idx`, and paged on exactly that pair. `acquired_at` is nullable,
   * so the cursor has to survive the boundary between the runs that declared an
   * acquisition time and the runs that did not; PostgreSQL sorts nulls first
   * under `desc`, and the cursor carries the null marker so the second page
   * resumes on the correct side of it.
   *
   * The tie-break is the id, which is a UUIDv7 and therefore orders by
   * registration time. Two runs sharing an acquisition millisecond are still
   * strictly ordered, which is what stops one of them being skipped.
   */
  async search(ctx: RequestContext, query: RunSearchQuery): Promise<Page<RunListItem>> {
    if (query.studyId !== undefined) {
      await this.auth.requireStudyRole(ctx, query.studyId, READ_ROLES);
    }

    return this.database.withTenant(ctx, async (trx) => {
      let statement = trx
        .selectFrom('aliquot.run')
        .innerJoin('aliquot.study as s', 's.id', 'aliquot.run.study_id')
        .innerJoin('aliquot.instrument as i', 'i.id', 'aliquot.run.instrument_id')
        .select(RUN_SUMMARY_COLUMNS.map((column) => `aliquot.run.${column}` as const))
        .select(['s.slug as study_slug', 'i.slug as instrument_slug'])
        .where('aliquot.run.tenant_id', '=', ctx.tenantId)
        .where(this.visibleStudies(ctx))
        .orderBy('aliquot.run.acquired_at', 'desc')
        .orderBy('aliquot.run.id', 'desc')
        .limit(query.limit + 1);

      if (query.studyId !== undefined) {
        statement = statement.where('aliquot.run.study_id', '=', query.studyId);
      }
      if (query.instrumentId !== undefined) {
        statement = statement.where('aliquot.run.instrument_id', '=', query.instrumentId);
      }
      if (query.operatorId !== undefined) {
        statement = statement.where('aliquot.run.operator_id', '=', query.operatorId);
      }
      if (query.state !== undefined && query.state.length > 0) {
        statement = statement.where('aliquot.run.state', 'in', query.state);
      }
      // Parsed to Date rather than passed through as text. acquired_at is a
      // timestamptz, and comparing it against a string leaves the coercion to
      // the server's DateStyle -- which is a setting, not a contract.
      if (query.acquiredFrom !== undefined) {
        statement = statement.where('aliquot.run.acquired_at', '>=', new Date(query.acquiredFrom));
      }
      if (query.acquiredTo !== undefined) {
        statement = statement.where('aliquot.run.acquired_at', '<=', new Date(query.acquiredTo));
      }
      if (query.cursor !== undefined) {
        statement = statement.where(searchCursorPredicate(query.cursor));
      }

      const rows = await statement.execute();
      const items = rows.map((row) => ({
        ...toSummary(row),
        studySlug: row.study_slug,
        instrumentSlug: row.instrument_slug,
      }));
      return buildPage(items, query.limit, (run) => [run.acquiredAt, run.id]);
    });
  }

  private async sealWithin(trx: Trx, ctx: RequestContext, runId: string): Promise<SealResult> {
    const current = await lockRun(trx, runId);
    assertTransition(runId, current.state, 'SEALED');

    const entries = await this.loadManifest(trx, ctx, runId);
    const declared: ManifestEntry[] = entries.map((entry) => ({
      logicalName: entry.logicalName,
      digest: entry.declaredDigest,
      sizeBytes: entry.declaredSize,
      mediaType: entry.declaredMediaType,
    }));

    assertWellFormedManifest(declared);
    const recomputed = manifestDigest(declared);
    if (recomputed !== current.manifestDigest) {
      throw new ConflictError(
        `Run ${runId} declared manifest ${current.manifestDigest} at registration but its ` +
          `manifest now digests to ${recomputed}. The run cannot be sealed.`,
        { runId, registeredDigest: current.manifestDigest, currentDigest: recomputed },
      );
    }

    const outstanding = entries
      .filter((entry) => entry.verificationState !== 'VERIFIED')
      .map((entry) => ({ logicalName: entry.logicalName, state: entry.verificationState }));

    if (outstanding.length > 0) {
      throw new ManifestIncompleteError(runId, outstanding);
    }

    const row = await trx
      .updateTable('aliquot.run')
      .set({ state: 'SEALED', sealed_at: sql<Date>`clock_timestamp()` })
      .where('id', '=', runId)
      .returning(RUN_SUMMARY_COLUMNS)
      .executeTakeFirstOrThrow();

    // Same transaction as the state change, which is the entire argument for
    // keeping the queue in PostgreSQL (ADR-004). If the seal rolls back so does
    // the job; there is no window in which a run is sealed and nothing will ever
    // process it.
    const processingJobId = await this.jobs.enqueue(trx, ctx, {
      queue: RUN_PROCESSING_QUEUE,
      // Just the run id. The correlation id is added by the queue itself, and
      // anything else the worker needs it reads from the run under the tenant the
      // job row names -- a payload that duplicates row state is a payload that
      // can disagree with it.
      payload: { runId },
      dedupeKey: `run:${runId}`,
    });

    const totalBytes = declared.reduce((sum, entry) => sum + BigInt(entry.sizeBytes), 0n);

    const event = await this.audit.append(trx, ctx, {
      action: 'run.sealed',
      targetType: 'run',
      targetId: runId,
      payload: {
        runId,
        manifestDigest: current.manifestDigest,
        artifactCount: entries.length,
        totalBytes: totalBytes.toString(),
        processingJobId,
      },
    });

    return { run: toSummary(row), auditSeq: event.seq, processingJobId };
  }

  private async createRun(
    trx: Trx,
    ctx: RequestContext,
    params: CreateRunParams,
  ): Promise<RunMutationResult> {
    await this.assertReferencesResolve(trx, ctx, params);

    const digest = manifestDigest(params.entries);
    const runId = uuidv7();

    const row = await trx
      .insertInto('aliquot.run')
      .values({
        id: runId,
        tenant_id: ctx.tenantId,
        study_id: params.studyId,
        instrument_id: params.instrumentId,
        operator_id: params.operatorId,
        state: 'OPEN',
        acquired_at: params.acquiredAt,
        protocol: params.protocol,
        manifest_digest: digest,
        supersedes_run_id: params.supersedesRunId,
        supersede_reason: params.supersedeReason,
      })
      .returning(RUN_SUMMARY_COLUMNS)
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('aliquot.run_artifact')
      .values(
        params.entries.map((entry) => ({
          id: uuidv7(),
          tenant_id: ctx.tenantId,
          run_id: runId,
          logical_name: entry.logicalName,
          declared_digest: entry.digest,
          declared_size: entry.sizeBytes,
          declared_media_type: entry.mediaType,
        })),
      )
      .execute();

    const totalBytes = params.entries.reduce((sum, entry) => sum + BigInt(entry.sizeBytes), 0n);

    // The manifest itself is not in the payload: it is already a row per entry in
    // `run_artifact`, and a thousand-file acquisition would put a megabyte into
    // every audit event and into its digest. The digest names it exactly.
    const event = await this.audit.append(trx, ctx, {
      action: 'run.registered',
      targetType: 'run',
      targetId: runId,
      payload: {
        runId,
        studyId: params.studyId,
        instrumentId: params.instrumentId,
        operatorId: params.operatorId,
        acquiredAt: params.acquiredAt,
        manifestDigest: digest,
        artifactCount: params.entries.length,
        totalBytes: totalBytes.toString(),
        supersedesRunId: params.supersedesRunId,
      },
    });

    return { run: toSummary(row), auditSeq: event.seq };
  }

  /**
   * Check every foreign key by hand before inserting.
   *
   * Not defensive duplication of the constraints: a foreign key violation from
   * our own INSERT surfaces as a 500, because an unresolvable reference in a
   * request we accepted is an application bug in every other case. Checking here
   * turns "the study does not exist" into an answer the caller can act on, and
   * leaves the constraint to catch the case where a row disappears underneath us.
   */
  private async assertReferencesResolve(
    trx: Trx,
    ctx: RequestContext,
    params: CreateRunParams,
  ): Promise<void> {
    const study = await trx
      .selectFrom('aliquot.study')
      .select(['id', 'closed_at'])
      .where('id', '=', params.studyId)
      .executeTakeFirst();

    if (!study) {
      throw new NotFoundError('study', params.studyId);
    }
    if (study.closed_at !== null) {
      throw new ConflictError(`Study ${params.studyId} is closed and accepts no further runs.`, {
        studyId: params.studyId,
      });
    }

    // An instrument credential may only register runs as itself. Otherwise a
    // long-lived secret sitting on a shared acquisition workstation could
    // attribute data to any instrument in the tenant, and attribution is the
    // thing this service exists to keep honest.
    if (ctx.actorType === 'instrument' && ctx.actorId !== params.instrumentId) {
      throw new ForbiddenError(
        `Instrument credentials may only register runs for instrument ${ctx.actorId ?? 'unknown'}.`,
      );
    }

    const instrument = await trx
      .selectFrom('aliquot.instrument')
      .select(['id', 'disabled_at'])
      .where('id', '=', params.instrumentId)
      .executeTakeFirst();

    if (!instrument || instrument.disabled_at !== null) {
      throw new ValidationError(
        `instrumentId ${params.instrumentId} is not an active instrument in this tenant`,
      );
    }

    const grant = await trx
      .selectFrom('aliquot.instrument_study_grant')
      .select('instrument_id')
      .where('instrument_id', '=', params.instrumentId)
      .where('study_id', '=', params.studyId)
      .executeTakeFirst();

    if (!grant) {
      throw new ForbiddenError(
        `Instrument ${params.instrumentId} is not granted study ${params.studyId}.`,
        'instrument_study_grant',
      );
    }

    const operator = await trx
      .selectFrom('aliquot.app_user')
      .select(['id', 'disabled_at'])
      .where('id', '=', params.operatorId)
      .executeTakeFirst();

    if (!operator || operator.disabled_at !== null) {
      throw new ValidationError(
        `operatorId ${params.operatorId} is not an active user in this tenant`,
      );
    }
  }

  /**
   * Resolve the run's study and authorise against it, outside any transaction.
   *
   * Reading the run first also gives the 404 for an id that does not exist or
   * belongs to another tenant -- which are the same answer on purpose.
   */
  private async requireRunAccess(
    ctx: RequestContext,
    runId: string,
    roles: StudyRole[],
  ): Promise<{ studyId: string; state: RunState; instrumentId: string; operatorId: string }> {
    const run = await this.database.withTenant(ctx, (trx) =>
      trx
        .selectFrom('aliquot.run')
        .select(['study_id', 'state', 'instrument_id', 'operator_id'])
        .where('id', '=', runId)
        .executeTakeFirst(),
    );

    if (!run) {
      throw new NotFoundError('run', runId);
    }

    await this.auth.requireStudyRole(ctx, run.study_id, roles);

    return {
      studyId: run.study_id,
      state: run.state,
      instrumentId: run.instrument_id,
      operatorId: run.operator_id,
    };
  }

  /**
   * Restrict a search to studies the caller is entitled to.
   *
   * Row-level security bounds the query to the tenant; it says nothing about
   * study membership, and `requireStudyRole` cannot help when no study was named.
   * Expressing the rule here duplicates a decision that belongs to identity, and
   * the alternative -- listing every run in the tenant to anyone holding any role
   * in it -- is not a defensible default for blinded arms and competing
   * programmes.
   */
  private visibleStudies(ctx: RequestContext) {
    switch (ctx.actorType) {
      case 'user':
        return sql<boolean>`study_id in (
          select m.study_id from aliquot.membership m
           where m.user_id = ${ctx.actorId}::uuid and m.revoked_at is null
        )`;

      case 'instrument':
        return sql<boolean>`study_id in (
          select g.study_id from aliquot.instrument_study_grant g
           where g.instrument_id = ${ctx.actorId}::uuid
        )`;

      case 'system':
        // The service acting on its own behalf inside one tenant. There is no
        // membership to consult, and row-level security still bounds it.
        return sql<boolean>`true`;
    }
  }

  private async loadManifest(
    trx: Trx,
    ctx: RequestContext,
    runId: string,
  ): Promise<ManifestEntryView[]> {
    const rows = await trx
      .selectFrom('aliquot.run_artifact')
      .select([
        'id',
        'logical_name',
        'declared_digest',
        'declared_media_type',
        'artifact_id',
        'verification_state',
        'verified_at',
        'rejection_reason',
      ])
      .select(sql<string>`declared_size::text`.as('declared_size'))
      .where('tenant_id', '=', ctx.tenantId)
      .where('run_id', '=', runId)
      .orderBy('logical_name')
      .execute();

    return rows.map((row) => ({
      id: row.id,
      logicalName: row.logical_name,
      declaredDigest: row.declared_digest,
      declaredSize: row.declared_size,
      declaredMediaType: row.declared_media_type,
      verificationState: row.verification_state,
      artifactId: row.artifact_id,
      verifiedAt: row.verified_at,
      rejectionReason: row.rejection_reason,
    }));
  }

  /**
   * Walk the correction chain in both directions.
   *
   * Two recursive CTEs rather than one with a direction flag, because a recursive
   * term may reference its own CTE exactly once. The forward direction can branch
   * -- nothing forbids two runs superseding the same predecessor -- so it is a
   * tree, not a list.
   */
  private async loadSupersedeChain(
    trx: Trx,
    runId: string,
  ): Promise<{ supersedes: RunLink[]; supersededBy: RunLink[] }> {
    const result = await sql<ChainRow>`
      with recursive ancestors as (
        select r.id, r.state, r.supersedes_run_id, r.supersede_reason, r.registered_at, 1 as depth
          from aliquot.run r
         where r.id = (select p.supersedes_run_id from aliquot.run p where p.id = ${runId}::uuid)
        union all
        select r.id, r.state, r.supersedes_run_id, r.supersede_reason, r.registered_at, a.depth + 1
          from aliquot.run r
          join ancestors a on a.supersedes_run_id = r.id
         where a.depth < ${MAX_SUPERSEDE_DEPTH}
      ),
      descendants as (
        select r.id, r.state, r.supersedes_run_id, r.supersede_reason, r.registered_at, 1 as depth
          from aliquot.run r
         where r.supersedes_run_id = ${runId}::uuid
        union all
        select r.id, r.state, r.supersedes_run_id, r.supersede_reason, r.registered_at, d.depth + 1
          from aliquot.run r
          join descendants d on r.supersedes_run_id = d.id
         where d.depth < ${MAX_SUPERSEDE_DEPTH}
      )
      select 'ancestor' as direction, a.id, a.state, a.supersede_reason, a.registered_at, a.depth
        from ancestors a
      union all
      select 'descendant' as direction, d.id, d.state, d.supersede_reason, d.registered_at, d.depth
        from descendants d
       order by depth, id
    `.execute(trx);

    const supersedes: RunLink[] = [];
    const supersededBy: RunLink[] = [];

    for (const row of result.rows) {
      const link: RunLink = {
        runId: row.id,
        state: row.state,
        reason: row.supersede_reason,
        registeredAt: row.registered_at,
        distance: row.depth,
      };
      if (row.direction === 'ancestor') {
        supersedes.push(link);
      } else {
        supersededBy.push(link);
      }
    }

    return { supersedes, supersededBy };
  }
}

/**
 * Lock the run for the rest of the transaction.
 *
 * Two concurrent seals of the same run would otherwise both read `OPEN`, both
 * pass the transition check, and one would fail on the trigger with an error that
 * describes the symptom rather than the cause. Serialising them here means the
 * second sees `SEALED` and gets the state machine's answer.
 */
async function lockRun(
  trx: Trx,
  runId: string,
): Promise<{ state: RunState; manifestDigest: string }> {
  const run = await trx
    .selectFrom('aliquot.run')
    .select(['state', 'manifest_digest'])
    .where('id', '=', runId)
    .forUpdate()
    .executeTakeFirst();

  if (!run) {
    throw new NotFoundError('run', runId);
  }

  return { state: run.state, manifestDigest: run.manifest_digest };
}

/**
 * Who the run is attributed to.
 *
 * `operator_id` is a user, always: "attributable" in ALCOA+ means a person is
 * accountable for the record, and an instrument is not a person. A user
 * registering on someone else's behalf is allowed and is visible -- the audit
 * event records the actor, the run records the operator, and they differ.
 */
function resolveOperator(ctx: RequestContext, declared: string | undefined): string {
  if (declared !== undefined) return declared;

  if (ctx.actorType === 'user' && ctx.actorId !== null) {
    return ctx.actorId;
  }

  throw new ValidationError(
    'operatorId is required: the accountable operator cannot be inferred from a non-user credential',
  );
}

/**
 * Keyset predicate for `(acquired_at desc, id desc)` with nulls first.
 *
 * Written out rather than expressed as a row comparison because `(a, b) < (x, y)`
 * has no meaning when `a` is null, and the null group is a real page boundary:
 * runs whose acquisition time was never declared sort ahead of every run that has
 * one.
 */
function searchCursorPredicate(cursor: string) {
  const fields = decodeCursor(cursor, SEARCH_CURSOR_ARITY);
  const acquiredAt = fields[0];
  const id = fields[1];

  if (acquiredAt === undefined || id === undefined || !isUuid(id)) {
    throw new ValidationError('cursor is not a valid pagination cursor');
  }

  if (isCursorNull(acquiredAt)) {
    return sql<boolean>`(acquired_at is not null or (acquired_at is null and id < ${id}::uuid))`;
  }

  if (Number.isNaN(new Date(acquiredAt).getTime())) {
    throw new ValidationError('cursor is not a valid pagination cursor');
  }

  return sql<boolean>`(
    acquired_at is not null
    and (acquired_at < ${acquiredAt}::timestamptz
         or (acquired_at = ${acquiredAt}::timestamptz and id < ${id}::uuid))
  )`;
}

function toSummary(row: RunSummaryRow): RunSummary {
  return {
    id: row.id,
    studyId: row.study_id,
    instrumentId: row.instrument_id,
    operatorId: row.operator_id,
    state: row.state,
    acquiredAt: row.acquired_at,
    registeredAt: row.registered_at,
    sealedAt: row.sealed_at,
    quarantinedAt: row.quarantined_at,
    abandonedAt: row.abandoned_at,
    supersedesRunId: row.supersedes_run_id,
    supersedeReason: row.supersede_reason,
    manifestDigest: row.manifest_digest,
    quarantineReason: row.quarantine_reason,
    processingAttempts: row.processing_attempts,
    processingStartedAt: row.processing_started_at,
    processingCompletedAt: row.processing_completed_at,
    processingError: row.processing_error,
  };
}
