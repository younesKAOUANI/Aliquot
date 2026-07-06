import type { Trx } from '../database/database.service';
import type { RequestContext } from '../database/request-context';

/**
 * The queue seam (ADR-004).
 *
 * The queue lives in PostgreSQL, and the property that decision is protecting is
 * this one: `enqueue` takes the caller's transaction. Sealing a run and
 * scheduling the work that seal implies are the same commit. If the seal rolls
 * back the job goes with it; if the process dies between them there is no
 * "between them". No broker can offer that, because no broker shares our
 * transaction.
 *
 * This abstraction is the documented migration path rather than decoration. At
 * the volumes where `SKIP LOCKED` on one table stops being enough, a real broker
 * goes behind this interface -- and the implementation that does it has to keep
 * the transactional handoff, which means an outbox: `enqueue` writes a row in
 * the caller's transaction, a relay reads committed outbox rows and publishes
 * them, and delivery becomes at-least-once with a visible lag instead of
 * synchronous. That is a strictly larger system, and the reason it is not here
 * yet is that the throughput it buys is not needed. What matters is that the
 * seam is drawn where the guarantee is, so the swap is one implementation and
 * one relay rather than an audit of every caller.
 *
 * Only the producer side is abstract. Claiming, completing and failing are not,
 * because a broker replaces those wholesale with its own delivery loop -- an
 * interface over them would have exactly one plausible implementation and would
 * still be wrong for the second one.
 */

export interface EnqueueRequest {
  queue: string;
  payload: Record<string, unknown>;
  /**
   * Enqueue-time deduplication. Unique per (tenant, queue) while non-null; a
   * conflict means the work is already scheduled, which is success, not an
   * error.
   */
  dedupeKey?: string;
  maxAttempts?: number;
  runAfter?: Date;
}

/**
 * Reserved payload key carrying the correlation id across the queue boundary.
 *
 * The `job` table has no correlation column on purpose -- the payload is already
 * the place a job carries what it needs, and a column would have to be
 * back-filled by every future producer. The queue writes this key itself so that
 * stitching does not depend on each caller remembering to.
 */
export const CORRELATION_PAYLOAD_KEY = 'correlationId';

/** A job as delivered to a handler. `payload` is still untrusted: parse it. */
export interface ClaimedJob {
  id: string;
  tenantId: string;
  queue: string;
  payload: Record<string, unknown>;
  /** Attempt number of *this* delivery, already incremented by the claim. */
  attempts: number;
  maxAttempts: number;
  /** Restored from the payload, so worker logs join the request that caused the job. */
  correlationId: string;
}

/**
 * A handler for one queue.
 *
 * Throwing is how a handler reports failure: the runtime releases the job, the
 * database applies the backoff, and the attempt budget runs down to `DEAD`.
 * Returning normally acknowledges the job. A handler must therefore be safe to
 * run twice -- redelivery is not an edge case here, it is the retry mechanism.
 */
export interface JobHandler {
  readonly queue: string;
  handle(job: ClaimedJob): Promise<void>;
}

export abstract class JobQueue {
  /**
   * Enqueue inside the caller's transaction.
   *
   * Returns the new job id, or `null` when `dedupeKey` was already enqueued.
   * `null` is not an error condition and callers should not treat it as one.
   */
  abstract enqueue(trx: Trx, ctx: RequestContext, request: EnqueueRequest): Promise<string | null>;
}
