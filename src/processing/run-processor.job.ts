import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';

import { sha256Hex, storageKeyForDigest } from '../common/digest';
import { IllegalTransitionError, NotFoundError, ValidationError } from '../common/problem-details';
import { uuidv7 } from '../common/uuid';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import type { Trx } from '../database/database.service';
import { systemContext } from '../database/request-context';
import type { RequestContext } from '../database/request-context';
import { Logger } from '../observability/logger';
import { DerivationService } from '../provenance/derivation.service';
import { ObjectStore } from '../storage/object-store';
import type { ClaimedJob, JobHandler } from './job-queue';
import { PROCESSORS, Processor } from './processor';
import type { ProcessorInputArtifact } from './processor';

/**
 * The run-processing handler: take a sealed run, run every configured processor
 * over its verified artifacts, and record what happened as a derivation.
 *
 * Every step is written to converge under redelivery, because redelivery is not
 * an exceptional path here -- it is how the queue retries, and it is what happens
 * whenever a worker dies between doing the work and acknowledging it. Three
 * things carry that:
 *
 *   - the run transition is conditional, so a second delivery finds the run
 *     already `PROCESSING` and proceeds rather than failing;
 *   - output bytes are written to a key derived from their own digest, so the
 *     second write produces the same object at the same key;
 *   - the derivation's unique constraint means identical work cannot record a
 *     second derivation, and a conflict is treated as success.
 *
 * The transaction boundaries are chosen so that no transaction is held open
 * across object-store I/O: one to claim the run and read its manifest, none at
 * all while bytes move, and one to commit every artifact row, every derivation
 * and the audit events together. Objects are written before that final commit,
 * which means a rollback leaves an orphaned object rather than an artifact row
 * pointing at bytes that are not there. That direction is the safe one and it is
 * the reason for the ordering.
 */

/**
 * The queue sealing writes to.
 *
 * The same literal appears as `RUN_PROCESSING_QUEUE` in
 * `src/ingestion/run.service.ts`, which is one literal too many: a producer and
 * a consumer that disagree about a queue name do not fail, they simply never
 * meet, and the run sits `SEALED` while the job sits `PENDING`. The name belongs
 * to the handler that serves it, so the duplicate should collapse into an import
 * of this constant.
 */
export const RUN_PROCESSING_QUEUE = 'run.process';

const payloadSchema = z.object({ runId: z.uuid() });

/** `processing_error` and audit payloads are for humans; a full stack in a column is not. */
const MAX_ERROR_LENGTH = 1000;

interface ResolvedArtifact {
  artifactId: string;
  logicalName: string;
  digest: string;
  sizeBytes: bigint;
  mediaType: string;
  storageKey: string;
}

interface PreparedOutput {
  logicalName: string;
  mediaType: string;
  bytes: Uint8Array;
  digest: string;
  storageKey: string;
}

interface ProcessorResult {
  processor: Processor;
  parameters: Record<string, unknown>;
  outputs: PreparedOutput[];
}

type StartOutcome =
  { outcome: 'proceed'; artifacts: ResolvedArtifact[] } | { outcome: 'already-processed' };

@Injectable()
export class RunProcessorJob implements JobHandler {
  readonly queue = RUN_PROCESSING_QUEUE;

  constructor(
    private readonly database: DatabaseService,
    private readonly objectStore: ObjectStore,
    private readonly audit: AuditService,
    private readonly derivations: DerivationService,
    @Inject(PROCESSORS) private readonly processors: Processor[],
    private readonly logger: Logger,
  ) {}

  async handle(job: ClaimedJob): Promise<void> {
    const { runId } = parsePayload(job);

    // The tenant comes from the claimed job row and nothing else. From this line
    // on the worker is scoped exactly like the API: `withTenant` sets
    // `app.tenant_id` and every policy applies.
    const ctx = systemContext(job.tenantId, job.correlationId, {
      label: 'worker',
      dbRole: 'aliquot_worker',
    });

    const log = this.logger.child({
      jobId: job.id,
      runId,
      tenantId: job.tenantId,
      correlationId: job.correlationId,
    });

    const started = await this.start(ctx, job, runId);
    if (started.outcome === 'already-processed') {
      // A redelivery of work that landed. Acknowledging is the whole response:
      // re-running would produce the same derivation and the same bytes, and
      // failing would retry something that is already correct.
      log.info('run is already processed; acknowledging redelivered job');
      return;
    }

    try {
      const results = await this.runProcessors(ctx, runId, started.artifacts);
      await this.commit(ctx, runId, started.artifacts, results, log);
    } catch (error) {
      const message = describeError(error);
      await this.recordFailure(ctx, runId, message, log);
      // Rethrown so the runtime releases the job: the backoff and the attempt
      // budget belong to the queue, not to this handler.
      throw error;
    }
  }

  /**
   * Move the run into `PROCESSING` and read its verified manifest.
   *
   * `SEALED` and `PROCESSING_FAILED` both transition; `PROCESSING` is left alone
   * and proceeds, which is what makes a redelivered job converge instead of
   * failing on a state it put the run in itself. Anything else -- `OPEN`,
   * `QUARANTINED`, `ABANDONED` -- is a job that should never have been enqueued,
   * and it is left to run its attempt budget down to `DEAD` with the reason on
   * the job row rather than being special-cased here: there is no retry that
   * fixes it and no other actor that can be told.
   */
  private async start(ctx: RequestContext, job: ClaimedJob, runId: string): Promise<StartOutcome> {
    return this.database.withTenant(ctx, async (trx) => {
      const run = await trx
        .selectFrom('aliquot.run')
        .select(['state'])
        .where('id', '=', runId)
        .executeTakeFirst();

      if (run === undefined) {
        throw new NotFoundError('run', runId);
      }
      if (run.state === 'PROCESSED') {
        return { outcome: 'already-processed' };
      }
      if (
        run.state !== 'SEALED' &&
        run.state !== 'PROCESSING' &&
        run.state !== 'PROCESSING_FAILED'
      ) {
        throw new IllegalTransitionError(runId, run.state, 'PROCESSING');
      }

      if (run.state !== 'PROCESSING') {
        const transitioned = await trx
          .updateTable('aliquot.run')
          .set({
            state: 'PROCESSING',
            processing_attempts: sql<number>`processing_attempts + 1`,
            processing_started_at: sql<Date>`clock_timestamp()`,
            processing_error: null,
          })
          .where('id', '=', runId)
          // Repeating the state in the predicate closes the window between the
          // read above and this update: a concurrent delivery that got there
          // first matches no rows here rather than transitioning twice.
          .where('state', 'in', ['SEALED', 'PROCESSING_FAILED'])
          .returning('processing_attempts')
          .executeTakeFirst();

        if (transitioned !== undefined) {
          await this.audit.append(trx, ctx, {
            action: 'run.processing_started',
            targetType: 'run',
            targetId: runId,
            payload: {
              jobId: job.id,
              attempt: transitioned.processing_attempts,
              deliveryAttempt: job.attempts,
              processors: this.processors.map((processor) => ({
                name: processor.name,
                version: processor.version,
              })),
            },
          });
        }
      }

      return { outcome: 'proceed', artifacts: await resolveArtifacts(trx, runId) };
    });
  }

  private async runProcessors(
    ctx: RequestContext,
    runId: string,
    artifacts: ResolvedArtifact[],
  ): Promise<ProcessorResult[]> {
    // One read per artifact no matter how many processors want it. The manifest
    // processor never calls `read()` at all, so a run whose only processor is
    // that one costs no object-store traffic.
    const reads = new Map<string, Promise<Uint8Array>>();
    const input: ProcessorInputArtifact[] = artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      logicalName: artifact.logicalName,
      digest: artifact.digest,
      sizeBytes: artifact.sizeBytes,
      mediaType: artifact.mediaType,
      read: () => {
        const pending =
          reads.get(artifact.storageKey) ?? this.objectStore.getObject(artifact.storageKey);
        reads.set(artifact.storageKey, pending);
        return pending;
      },
    }));

    const results: ProcessorResult[] = [];

    for (const processor of this.processors) {
      const produced = await processor.run({ ctx, runId, artifacts: input });

      const outputs = produced.outputs.map((output) => {
        const digest = sha256Hex(output.bytes);
        return { ...output, digest, storageKey: storageKeyForDigest(digest) };
      });

      // Written before the rows that reference them, and outside any
      // transaction. Both are deliberate: a digest-derived key makes the write
      // idempotent -- identical bytes land at the identical key, so a retry
      // overwrites an object with itself -- and doing it here means a rollback
      // of the commit below leaves an unreferenced object rather than a row
      // pointing at bytes that were never stored.
      for (const output of outputs) {
        await this.objectStore.putObject(output.storageKey, output.bytes, output.mediaType);
      }

      results.push({ processor, parameters: produced.parameters, outputs });
    }

    return results;
  }

  /**
   * Commit everything the processors produced, in one transaction.
   *
   * The artifact rows, the derivations that explain them and the audit events
   * that attest to them commit together or not at all. Splitting them would
   * create the two failure shapes this service exists to prevent: an artifact
   * with no recorded provenance, and provenance for an artifact that is not
   * there.
   */
  private async commit(
    ctx: RequestContext,
    runId: string,
    inputs: ResolvedArtifact[],
    results: ProcessorResult[],
    log: Logger,
  ): Promise<void> {
    const inputArtifactIds = inputs.map((artifact) => artifact.artifactId);

    await this.database.withTenant(ctx, async (trx) => {
      for (const result of results) {
        const outputs: { artifactId: string; logicalName: string }[] = [];

        for (const output of result.outputs) {
          outputs.push({
            artifactId: await upsertArtifact(trx, ctx, runId, output),
            // Namespaced by processor: these are outputs of a derivation, not
            // entries in the run's manifest. A sealed run's manifest cannot grow
            // -- the trigger on run_artifact sees to that -- so derived
            // artifacts are reachable through the derivation graph instead.
            logicalName: `${result.processor.name}/${output.logicalName}`,
          });
        }

        const derivation = await this.derivations.record(trx, ctx, {
          processorName: result.processor.name,
          processorVersion: result.processor.version,
          parameters: result.parameters,
          inputArtifactIds,
          outputs,
          sourceRunId: runId,
        });

        await this.audit.append(trx, ctx, {
          action: 'derivation.recorded',
          targetType: 'derivation',
          targetId: derivation.derivationId,
          payload: {
            runId,
            processorName: result.processor.name,
            processorVersion: result.processor.version,
            // False means an identical derivation already existed and this
            // delivery converged on it. Worth recording: it is the observable
            // half of the idempotency guarantee.
            created: derivation.created,
            inputArtifactIds,
            outputs: result.outputs.map((output, index) => ({
              logicalName: outputs[index]?.logicalName ?? output.logicalName,
              digest: output.digest,
              sizeBytes: output.bytes.length.toString(),
              mediaType: output.mediaType,
            })),
          },
        });
      }

      const completed = await trx
        .updateTable('aliquot.run')
        .set({
          state: 'PROCESSED',
          processing_completed_at: sql<Date>`clock_timestamp()`,
          processing_error: null,
        })
        .where('id', '=', runId)
        .where('state', '=', 'PROCESSING')
        .returning('processing_attempts')
        .executeTakeFirst();

      if (completed === undefined) {
        // A concurrent delivery finished the run first. Its artifacts and ours
        // are the same content-addressed rows, so there is nothing to reconcile
        // and nothing to say in the audit trail that its own `run.processed`
        // has not already said.
        log.warn('run left PROCESSING before this attempt completed; skipping the processed event');
        return;
      }

      await this.audit.append(trx, ctx, {
        action: 'run.processed',
        targetType: 'run',
        targetId: runId,
        payload: {
          attempt: completed.processing_attempts,
          inputArtifactCount: inputs.length,
          derivations: results.map((result) => ({
            processorName: result.processor.name,
            processorVersion: result.processor.version,
            outputDigests: result.outputs.map((output) => output.digest),
          })),
        },
      });
    });
  }

  /**
   * Record the failure on the run, best effort.
   *
   * Guarded on `PROCESSING` because a run that never got there has nothing to
   * record -- and because a run in a terminal state would have the update
   * rejected by the immutability trigger, turning a reportable failure into a
   * second, less informative one.
   */
  private async recordFailure(
    ctx: RequestContext,
    runId: string,
    message: string,
    log: Logger,
  ): Promise<void> {
    try {
      await this.database.withTenant(ctx, async (trx) => {
        const failed = await trx
          .updateTable('aliquot.run')
          .set({
            state: 'PROCESSING_FAILED',
            processing_completed_at: sql<Date>`clock_timestamp()`,
            processing_error: message,
          })
          .where('id', '=', runId)
          .where('state', '=', 'PROCESSING')
          .returning('processing_attempts')
          .executeTakeFirst();

        if (failed === undefined) return;

        await this.audit.append(trx, ctx, {
          action: 'run.processing_failed',
          targetType: 'run',
          targetId: runId,
          payload: { attempt: failed.processing_attempts, error: message },
        });
      });
    } catch (error) {
      // Swallowed deliberately. The failure that brought us here is the one the
      // operator needs, it is about to be written to the job row by
      // release_job(), and it is already in this log line. Replacing it with
      // whatever went wrong while recording it would lose the original.
      log.error('could not record the processing failure on the run', {
        error: describeError(error),
        originalError: message,
      });
    }
  }
}

async function resolveArtifacts(trx: Trx, runId: string): Promise<ResolvedArtifact[]> {
  const rows = await trx
    .selectFrom('aliquot.run_artifact as ra')
    .innerJoin('aliquot.artifact as a', 'a.id', 'ra.artifact_id')
    .select(['ra.logical_name', 'a.id as artifact_id', 'a.digest', 'a.media_type', 'a.storage_key'])
    // bigint: the driver hands it back as a string and it becomes a BigInt here,
    // never a double. A 9 PB run is not the concern; a size that silently rounds
    // in a manifest that claims to be exact, is.
    .select(sql<string>`a.size_bytes::text`.as('size_bytes'))
    .where('ra.run_id', '=', runId)
    // Only verified entries. A rejected one means the run is quarantined and
    // never reaches processing at all; a declared-but-absent one cannot exist
    // after a successful seal.
    .where('ra.verification_state', '=', 'VERIFIED')
    // Deterministic order in, deterministic bytes out.
    .orderBy('ra.logical_name')
    .execute();

  return rows.map((row) => ({
    artifactId: row.artifact_id,
    logicalName: row.logical_name,
    digest: row.digest,
    sizeBytes: BigInt(row.size_bytes),
    mediaType: row.media_type,
    storageKey: row.storage_key,
  }));
}

/**
 * Insert the artifact row, or find the one that already describes these bytes.
 *
 * `DO NOTHING` rather than `DO UPDATE`: a trigger rejects every UPDATE on
 * `artifact`, because a row whose key is derived from its own content has
 * nothing that can legitimately change. So the conflict path re-reads instead,
 * which is also the correct answer for the ordinary case -- the same calibration
 * file uploaded with four hundred runs is one artifact row.
 */
async function upsertArtifact(
  trx: Trx,
  ctx: RequestContext,
  runId: string,
  output: PreparedOutput,
): Promise<string> {
  const inserted = await trx
    .insertInto('aliquot.artifact')
    .values({
      id: uuidv7(),
      tenant_id: ctx.tenantId,
      digest: output.digest,
      size_bytes: output.bytes.length,
      storage_key: output.storageKey,
      media_type: output.mediaType,
      first_seen_run_id: runId,
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'digest']).doNothing())
    .returning('id')
    .executeTakeFirst();

  if (inserted !== undefined) return inserted.id;

  const existing = await trx
    .selectFrom('aliquot.artifact')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('digest', '=', output.digest)
    .executeTakeFirstOrThrow();

  return existing.id;
}

function parsePayload(job: ClaimedJob): { runId: string } {
  const parsed = payloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    // Not retryable in any useful sense -- the payload will not improve -- but it
    // still goes through the ordinary failure path so the reason ends up on the
    // job row where an operator will look for it.
    throw new ValidationError(
      `job ${job.id} on ${job.queue} does not carry a run id`,
      parsed.error.issues,
    );
  }
  return { runId: parsed.data.runId };
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}
