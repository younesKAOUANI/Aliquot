import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { IncomingHttpHeaders } from 'node:http';

import { digestCanonical } from '../common/digest';
import {
  ConflictError,
  IdempotencyKeyReusedError,
  IdempotentRequestInFlightError,
  ValidationError,
} from '../common/problem-details';
import { uuidv7 } from '../common/uuid';
import { AppConfig } from '../config/config';
import { DatabaseService } from '../database/database.service';
import type { Trx } from '../database/database.service';
import type { RequestContext } from '../database/request-context';
import type { IdempotencyState } from '../database/schema';
import { Logger } from '../observability/logger';

/**
 * Exactly-once semantics for mutating endpoints (R1).
 *
 * The unique constraint `idempotency_key_unique` is the entire concurrency
 * mechanism. There is no application lock, no check-then-act, and therefore no
 * window between the check and the act. What this class adds around it is the
 * ordering, which is where the guarantee is actually won or lost:
 *
 *   1. The `IN_FLIGHT` row commits *before* the work runs. If it were written in
 *      the same transaction as the work, a concurrent duplicate would not see it
 *      -- an uncommitted row is invisible -- and both callers would proceed to
 *      create two runs from one request. The second caller must be able to
 *      observe the first, and the only way to be observed is to commit.
 *   2. The response record is written *inside* the work transaction. The row it
 *      updates is already committed, so this costs nothing, and it removes the
 *      only remaining dual write: there is no instant at which a run exists and
 *      the key that names it does not.
 *   3. A failed request deletes its key. Otherwise a transient failure poisons
 *      that key for the full retention window, and the legitimate retry is
 *      rejected as a fingerprint match against a response that never existed.
 *
 * The fingerprint is what separates a retry from a mistake. Matching on the key
 * alone means a client that reuses a key with different content silently
 * receives the response to a request it did not make -- worse than an error,
 * because it looks like success.
 */

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Mirrors `check (length(key) between 8 and 255)` on the column. */
const KEY_MIN_LENGTH = 8;
const KEY_MAX_LENGTH = 255;

/**
 * How long to tell a caller to wait when an identical request is in flight. The
 * window is one database transaction, so this is short by construction; a client
 * that comes back early simply receives the same answer again.
 */
const IN_FLIGHT_RETRY_AFTER_SECONDS = 2;

/**
 * A concurrent caller can take over a key that expired between our insert and
 * our read, and another can delete one that failed. Both are single-step races
 * against a row that then has a fresh 24-hour lifetime, so a bounded retry
 * always converges; the bound exists so that a pathological loop surfaces as a
 * 409 rather than as a hung request.
 */
const CLAIM_ATTEMPTS = 3;

export interface IdempotentWork<T> {
  status: number;
  body: T;
  /** Recorded on the key row so an operator can find what a replay refers to. */
  resourceId: string | null;
}

export interface IdempotentOutcome<T> {
  status: number;
  body: T;
  /** True when this response was served from the record of an earlier request. */
  replayed: boolean;
}

interface KeyRow {
  id: string;
  request_fingerprint: string;
  state: IdempotencyState;
  response_status: number | null;
  response_body: unknown;
  expires_at: Date;
}

type Claim<T> = { kind: 'owned'; id: string } | { kind: 'replay'; outcome: IdempotentOutcome<T> };

@Injectable()
export class IdempotencyService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Run `work` at most once per (tenant, key, endpoint).
   *
   * `endpoint` is an opaque scope string, not a route pattern. Callers pass the
   * concrete path -- `POST /v1/runs/<id>/seal`, not `POST /v1/runs/{runId}/seal`
   * -- because a seal carries no body: with a templated scope, one key used to
   * seal two different runs would fingerprint identically, and the second run
   * would be handed the first run's response and never be sealed at all.
   *
   * `body` is the parsed request, not the bytes on the wire. Canonicalisation
   * already removes key order and whitespace; parsing additionally removes
   * fields that do not affect the outcome, so the fingerprint tracks what the
   * request means rather than how it was spelled.
   */
  async execute<T>(
    ctx: RequestContext,
    endpoint: string,
    key: string | undefined,
    body: unknown,
    work: (trx: Trx) => Promise<IdempotentWork<T>>,
  ): Promise<IdempotentOutcome<T>> {
    const validKey = requireKey(key);
    // A request with no body at all fingerprints as `null`, which is a value the
    // canonicaliser accepts; `undefined` is not.
    const fingerprint = digestCanonical(body ?? null);

    const claim = await this.claim<T>(ctx, endpoint, validKey, fingerprint);
    if (claim.kind === 'replay') {
      return claim.outcome;
    }

    try {
      const result = await this.database.withTenant(ctx, async (trx) => {
        const outcome = await work(trx);
        await complete(trx, claim.id, outcome);
        return outcome;
      });

      return { status: result.status, body: result.body, replayed: false };
    } catch (error) {
      await this.release(ctx, claim.id, validKey);
      throw error;
    }
  }

  /**
   * Delete expired records.
   *
   * Expiry is a real delete rather than a tombstone because a caller replaying a
   * key after the retention window must be treated as a first-time caller, and a
   * tombstone invites exactly the opposite behaviour to creep in at read time.
   */
  async sweepExpired(ctx: RequestContext): Promise<number> {
    return this.database.withTenant(ctx, async (trx) => {
      const result = await trx
        .deleteFrom('aliquot.idempotency_key')
        .where(sql<boolean>`expires_at <= clock_timestamp()`)
        .executeTakeFirst();

      return Number(result.numDeletedRows);
    });
  }

  /**
   * Take ownership of the key, or discover what already owns it.
   *
   * Each attempt is one transaction that commits before the caller proceeds. The
   * insert is what makes it a race the database arbitrates: `ON CONFLICT DO
   * NOTHING` blocks on a concurrent uncommitted insert of the same key rather
   * than failing past it, so by the time it returns, the other caller has either
   * committed -- and we read their row -- or rolled back, and ours went in.
   */
  private async claim<T>(
    ctx: RequestContext,
    endpoint: string,
    key: string,
    fingerprint: string,
  ): Promise<Claim<T>> {
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const claim = await this.database.withTenant(ctx, async (trx): Promise<Claim<T> | null> => {
        const inserted = await trx
          .insertInto('aliquot.idempotency_key')
          .values({
            id: uuidv7(),
            tenant_id: ctx.tenantId,
            key,
            endpoint,
            request_fingerprint: fingerprint,
            state: 'IN_FLIGHT',
            // Computed by the database so that the expiry written here and the
            // expiry the sweep compares against are read from one clock.
            expires_at: sql<Date>`clock_timestamp() + make_interval(hours => ${this.config.idempotency.retentionHours}::integer)`,
          })
          .onConflict((oc) => oc.constraint('idempotency_key_unique').doNothing())
          .returning('id')
          .executeTakeFirst();

        if (inserted) {
          return { kind: 'owned', id: inserted.id };
        }

        const existing = await trx
          .selectFrom('aliquot.idempotency_key')
          .select([
            'id',
            'request_fingerprint',
            'state',
            'response_status',
            'response_body',
            'expires_at',
          ])
          .where('tenant_id', '=', ctx.tenantId)
          .where('key', '=', key)
          .where('endpoint', '=', endpoint)
          .executeTakeFirst();

        // Deleted by a failing request between our insert and our read. Retrying
        // the insert is the whole recovery.
        if (!existing) return null;

        // Expiry is tested before the fingerprint on purpose. An expired record
        // is not a record of anything -- the response it describes is gone, and a
        // caller replaying after the retention window is documented to be treated
        // as a first-time caller -- so comparing fingerprints against it would
        // reject a legitimate new request that happened to reuse yesterday's key.
        //
        // This comparison runs against the local clock and the reclaim runs
        // against the database's. Disagreement at the boundary is harmless in
        // both directions: a reclaim that finds the row still live no-ops and we
        // re-read it, and a record judged live a second past its expiry is
        // replayed a second late.
        if (isExpired(existing)) {
          if (await this.takeOverIfExpired(trx, existing.id, fingerprint)) {
            return { kind: 'owned', id: existing.id };
          }
          // Another caller reclaimed it first. Their record is live now, and the
          // next attempt reads it as an ordinary conflict.
          return null;
        }

        return { kind: 'replay', outcome: replayOf<T>(existing, fingerprint, key, endpoint) };
      });

      if (claim) return claim;
    }

    throw new ConflictError(
      `Idempotency key ${key} is being contended for and could not be claimed. Retry.`,
      { idempotencyKey: key, endpoint },
    );
  }

  private async takeOverIfExpired(trx: Trx, id: string, fingerprint: string): Promise<boolean> {
    const taken = await trx
      .updateTable('aliquot.idempotency_key')
      .set({
        request_fingerprint: fingerprint,
        state: 'IN_FLIGHT',
        response_status: null,
        response_body: null,
        resource_id: null,
        completed_at: null,
        expires_at: sql<Date>`clock_timestamp() + make_interval(hours => ${this.config.idempotency.retentionHours}::integer)`,
      })
      .where('id', '=', id)
      // The predicate is evaluated by the database under a row lock, so two
      // callers cannot both conclude the record was theirs to reclaim.
      .where(sql<boolean>`expires_at <= clock_timestamp()`)
      .returning('id')
      .executeTakeFirst();

    return taken !== undefined;
  }

  private async release(ctx: RequestContext, id: string, key: string): Promise<void> {
    try {
      await this.database.withTenant(ctx, (trx) =>
        trx
          .deleteFrom('aliquot.idempotency_key')
          .where('id', '=', id)
          .where('state', '=', 'IN_FLIGHT')
          .execute(),
      );
    } catch (error) {
      // Swallowed because the caller is already carrying a more useful error and
      // this one would replace it. The consequence is bounded and self-healing:
      // the orphaned record blocks that one key until it expires, at which point
      // the next caller reclaims it.
      this.logger.warn('failed to release an in-flight idempotency key', {
        correlationId: ctx.correlationId,
        idempotencyKey: key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Characters an idempotency key may contain.
 *
 * Deliberately excludes the comma and all whitespace, and that is not
 * cosmetic. Node collapses a repeated request header into a single
 * comma-joined string rather than an array, so a client that sends
 * `Idempotency-Key: a` and `Idempotency-Key: b` arrives here as the one key
 * `"a, b"` -- a third key that neither caller believes it used. Both of that
 * client's requests would then be treated as one operation, which is precisely
 * the confusion idempotency exists to prevent. Rejecting the comma turns a
 * silent merge into a 400.
 */
const KEY_PATTERN = /^[A-Za-z0-9._:@+/=-]+$/;

/**
 * Read the header, tolerating the shapes Node's header map can produce.
 *
 * An array is treated as absent rather than resolved to its first value: two
 * keys on one request means the client does not know which key it used, and
 * guessing on its behalf is how one of the two requests gets lost.
 */
export function idempotencyKeyOf(headers: IncomingHttpHeaders): string | undefined {
  const header = headers[IDEMPOTENCY_HEADER];
  return typeof header === 'string' ? header : undefined;
}

function requireKey(key: string | undefined): string {
  if (
    key === undefined ||
    key.length < KEY_MIN_LENGTH ||
    key.length > KEY_MAX_LENGTH ||
    !KEY_PATTERN.test(key)
  ) {
    throw new ValidationError(
      `this endpoint requires exactly one Idempotency-Key header of ${KEY_MIN_LENGTH}-` +
        `${KEY_MAX_LENGTH} characters from [A-Za-z0-9._:@+/=-], unique to the request ` +
        'being made',
    );
  }
  return key;
}

async function complete<T>(trx: Trx, id: string, outcome: IdempotentWork<T>): Promise<void> {
  await trx
    .updateTable('aliquot.idempotency_key')
    .set({
      state: 'COMPLETED',
      response_status: outcome.status,
      response_body: outcome.body,
      resource_id: outcome.resourceId,
      completed_at: sql<Date>`clock_timestamp()`,
    })
    .where('id', '=', id)
    .execute();
}

function isExpired(row: KeyRow): boolean {
  return row.expires_at.getTime() <= Date.now();
}

/**
 * What a live record means for the caller that collided with it.
 *
 * The stored body is re-hydrated from `jsonb`, so this is the one place in the
 * module where a value is asserted rather than parsed. It is sound at the only
 * boundary that matters: the bytes stored are the bytes the first caller was
 * served, so the replayed response is byte-identical over HTTP. It is *not*
 * sound for an in-process caller inspecting the result -- a `Date` field comes
 * back as the ISO string it was serialised to -- which is why nothing downstream
 * of `execute()` reads the body, it only forwards it.
 */
function replayOf<T>(
  row: KeyRow,
  fingerprint: string,
  key: string,
  endpoint: string,
): IdempotentOutcome<T> {
  if (row.request_fingerprint !== fingerprint) {
    throw new IdempotencyKeyReusedError(key, endpoint);
  }

  if (row.state === 'IN_FLIGHT') {
    throw new IdempotentRequestInFlightError(key, IN_FLIGHT_RETRY_AFTER_SECONDS);
  }

  if (row.response_status === null) {
    // `idempotency_completed_has_response` makes this unreachable. Reached, it
    // means the constraint is gone, and guessing a status would hide that.
    throw new Error(`idempotency key ${row.id} is COMPLETED with no stored response status`);
  }

  return { status: row.response_status, body: row.response_body as T, replayed: true };
}
