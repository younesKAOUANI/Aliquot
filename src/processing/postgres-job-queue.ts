import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { uuidv7 } from '../common/uuid';
import { DatabaseService } from '../database/database.service';
import type { Trx } from '../database/database.service';
import type { RequestContext } from '../database/request-context';
import type { JobState } from '../database/schema';
import { CORRELATION_PAYLOAD_KEY, JobQueue } from './job-queue';
import type { ClaimedJob, EnqueueRequest } from './job-queue';

/**
 * The PostgreSQL implementation of the queue.
 *
 * Two roles run against `aliquot.job` and the asymmetry between them is the
 * whole design (migration 0007):
 *
 *   enqueue                 runs in the caller's tenant-scoped transaction, as
 *                           `aliquot_app`. The RLS policy confines it to its own
 *                           tenant exactly like every other write.
 *
 *   claim/complete/fail     run through `withoutTenantScope('aliquot_worker')`,
 *                           because claiming is how the worker discovers whose
 *                           work is next -- there is no tenant to scope to until
 *                           after the claim returns. That cross-tenant
 *                           visibility is a policy on the `job` table granted to
 *                           `aliquot_worker`, not `BYPASSRLS` on the role: it
 *                           reaches exactly one table, and every domain table
 *                           the worker touches afterwards is scoped by
 *                           `app.tenant_id` taken from the claimed row.
 */

/** Long errors are truncated: a dead-letter reason has to be readable, and a stack per retry is not. */
const MAX_ERROR_LENGTH = 2000;

interface JobRow {
  id: string;
  tenant_id: string;
  queue: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/** Outcome of releasing a failed job: `DEAD` means the attempt budget is spent. */
export interface ReleaseOutcome {
  state: JobState;
  attempts: number;
}

@Injectable()
export class PostgresJobQueue extends JobQueue {
  constructor(private readonly database: DatabaseService) {
    super();
  }

  /**
   * Insert the job in the caller's transaction.
   *
   * A conflict on the dedupe index resolves to `null` rather than an error
   * because "this work is already scheduled" is the outcome the caller asked
   * for. Sealing a run is itself idempotent -- the same seal replayed through an
   * idempotency key must produce one processing job, not two -- so an enqueue
   * that finds its own earlier row has succeeded. Raising here would force every
   * caller to catch a unique violation and decide it was fine, which is the same
   * decision made in a worse place.
   */
  async enqueue(trx: Trx, ctx: RequestContext, request: EnqueueRequest): Promise<string | null> {
    const inserted = await trx
      .insertInto('aliquot.job')
      .values({
        id: uuidv7(),
        tenant_id: ctx.tenantId,
        queue: request.queue,
        // The context's correlation id wins over anything of the same name in
        // the payload: it names the request that actually caused this job, which
        // is the only thing a log reader can join against.
        payload: { ...request.payload, [CORRELATION_PAYLOAD_KEY]: ctx.correlationId },
        dedupe_key: request.dedupeKey ?? null,
        max_attempts: request.maxAttempts,
        run_after: request.runAfter,
      })
      // The conflict target has to name the index predicate as well as the
      // columns, because `job_dedupe_idx` is partial. Rows with a null
      // dedupe_key are outside the index and cannot conflict at all, which is
      // the intended behaviour for work that is not deduplicated.
      .onConflict((oc) =>
        oc
          .columns(['tenant_id', 'queue', 'dedupe_key'])
          .where('dedupe_key', 'is not', null)
          .doNothing(),
      )
      .returning('id')
      .executeTakeFirst();

    return inserted?.id ?? null;
  }

  /**
   * Claim up to `limit` jobs, taking a lease on each.
   *
   * `aliquot.claim_jobs()` does the interesting part: `FOR UPDATE SKIP LOCKED`
   * over the ready set, and expired leases reclaimed by the same statement, with
   * `attempts` already incremented so a job that reliably kills its worker walks
   * its budget down to `DEAD` instead of looping forever.
   */
  async claim(
    queue: string,
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<ClaimedJob[]> {
    return this.database.withoutTenantScope('aliquot_worker', async (trx) => {
      const claimed = await sql<JobRow>`
        select id, tenant_id, queue, payload, attempts, max_attempts
          from aliquot.claim_jobs(
            ${queue},
            ${workerId},
            ${limit}::integer,
            ${leaseSeconds}::integer
          )
      `.execute(trx);

      return claimed.rows.map(toClaimedJob);
    });
  }

  /**
   * Acknowledge a job.
   *
   * Fenced on `claimed_by`: if this worker's lease expired mid-job and another
   * worker has since claimed the row, the update matches nothing and returns
   * false rather than stamping COMPLETED over an attempt that is still running.
   * The duplicated work is harmless -- every handler here converges -- but
   * silently retiring somebody else's job would not be.
   */
  async complete(jobId: string, workerId: string): Promise<boolean> {
    return this.database.withoutTenantScope('aliquot_worker', async (trx) => {
      const result = await trx
        .updateTable('aliquot.job')
        .set({
          state: 'COMPLETED',
          completed_at: sql<Date>`clock_timestamp()`,
          // Only the lease is cleared. `claimed_by` and `last_error` are left
          // standing because they are the only record of who ran the job and
          // what went wrong on the attempts before this one; a COMPLETED row
          // with three attempts and an error text is exactly the row an operator
          // wants to find, and clearing them would erase it to make the table
          // look tidier.
          lease_expires_at: null,
        })
        .where('id', '=', jobId)
        .where('claimed_by', '=', workerId)
        .where('state', '=', 'ACTIVE')
        .executeTakeFirst();

      return result.numUpdatedRows > 0n;
    });
  }

  /**
   * Release a failed job back to the queue with its backoff applied.
   *
   * Returns null when the lease was lost, for the same reason `complete` does.
   * The ownership check and the release are one transaction so that the row
   * cannot change owner between them.
   */
  async fail(jobId: string, workerId: string, error: string): Promise<ReleaseOutcome | null> {
    return this.database.withoutTenantScope('aliquot_worker', async (trx) => {
      const owner = await trx
        .selectFrom('aliquot.job')
        .select(['claimed_by', 'state'])
        .where('id', '=', jobId)
        .forUpdate()
        .executeTakeFirst();

      if (owner === undefined || owner.claimed_by !== workerId || owner.state !== 'ACTIVE') {
        return null;
      }

      const released = await sql<{ state: JobState; attempts: number }>`
        select state, attempts
          from aliquot.release_job(${jobId}::uuid, ${error.slice(0, MAX_ERROR_LENGTH)})
      `.execute(trx);

      const row = released.rows[0];
      return row === undefined ? null : { state: row.state, attempts: row.attempts };
    });
  }

  /**
   * Extend the lease on a job that is still running.
   *
   * Without this a job that legitimately takes longer than the lease is
   * reclaimed while it is still working, and two workers process it
   * concurrently. False means the lease was already lost -- the work is
   * idempotent and the completion is fenced, so there is nothing to do about it
   * but say so.
   */
  async renewLease(jobId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    return this.database.withoutTenantScope('aliquot_worker', async (trx) => {
      const result = await trx
        .updateTable('aliquot.job')
        .set({
          lease_expires_at: sql<Date>`clock_timestamp() + make_interval(secs => ${leaseSeconds}::integer)`,
        })
        .where('id', '=', jobId)
        .where('claimed_by', '=', workerId)
        .where('state', '=', 'ACTIVE')
        .executeTakeFirst();

      return result.numUpdatedRows > 0n;
    });
  }
}

function toClaimedJob(row: JobRow): ClaimedJob {
  const carried = row.payload[CORRELATION_PAYLOAD_KEY];
  return {
    id: row.id,
    tenantId: row.tenant_id,
    queue: row.queue,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    // Falling back to the job id keeps every log line joinable even for a job
    // enqueued before this key existed, or by psql during an incident.
    correlationId: typeof carried === 'string' && carried.length > 0 ? carried : row.id,
  };
}
