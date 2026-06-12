import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { canonicalize } from '../common/canonical-json';
import { buildPage, decodeCursor } from '../common/cursor';
import type { Page } from '../common/cursor';
import { digestCanonical } from '../common/digest';
import { ValidationError } from '../common/problem-details';
import { DatabaseService } from '../database/database.service';
import type { Trx } from '../database/database.service';
import type { RequestContext } from '../database/request-context';
import type { ActorType } from '../database/schema';

export interface AuditAppendResult {
  seq: string;
  hash: string;
  occurredAt: Date;
}

export interface AuditEventInput {
  /** `run.registered`, `artifact.rejected`. Matched by a CHECK constraint too. */
  action: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
}

/** An event as the API renders it. `seq` is a string because it is a bigint. */
export interface AuditEventView {
  seq: string;
  id: string;
  actorType: ActorType;
  actorId: string | null;
  actorLabel: string;
  action: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  payloadDigest: string;
  prevHash: string;
  hash: string;
  /**
   * The database's own canonical rendering, to microsecond precision. This is
   * the exact string that goes into the hash preimage, so a client verifying the
   * chain offline can reproduce it without knowing our formatting rules -- and
   * without being defeated by a JSON date that rounds to milliseconds.
   */
  occurredAt: string;
  correlationId: string | null;
}

export interface AuditListQuery {
  limit: number;
  cursor?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
}

const ACTION_PATTERN = /^[a-z_]+\.[a-z_]+$/;
const DECIMAL = /^\d+$/;

@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Append one event to the caller's chain, inside the caller's transaction.
   *
   * Taking a `Trx` rather than opening one is the whole design. An audit event
   * that commits separately from the change it describes is a dual write: the
   * run is sealed and the record of who sealed it is lost, or the record exists
   * for a seal that rolled back. Both are worse than failing.
   *
   * `seq`, `prev_hash`, `hash` and `occurred_at` are returned by the database
   * because they are chosen there. Four of the five hash inputs are values this
   * process must not be able to pick -- if it could, its own tamper-evidence
   * would be self-certified -- and `occurred_at` in particular comes from
   * `clock_timestamp()` inside the same statement, so it is the time the row was
   * actually written rather than the time this process thought it was. The fifth
   * input, `payload_digest`, is ours: RFC 8785 in plpgsql is not a thing to
   * maintain, and that digest is itself covered by the chain.
   */
  async append(trx: Trx, ctx: RequestContext, event: AuditEventInput): Promise<AuditAppendResult> {
    if (!ACTION_PATTERN.test(event.action)) {
      // The column has the same CHECK. Failing here turns what would surface as
      // an opaque constraint violation into a named programming error, because
      // every action string in this service is a compile-time constant.
      throw new Error(`audit action ${JSON.stringify(event.action)} must match <noun>.<verb>`);
    }

    // The bytes that are digested and the bytes that are stored are the same
    // string. Storing a differently-serialised payload would leave a digest that
    // is correct about something nobody can reconstruct.
    const canonicalPayload = canonicalize(event.payload);
    const payloadDigest = digestCanonical(event.payload);

    const result = await sql<{ seq: string; hash: string; occurred_at: Date }>`
      select seq::text as seq, hash, occurred_at
        from aliquot.append_audit_event(
          ${ctx.actorType}::aliquot.actor_type,
          ${ctx.actorId}::uuid,
          ${ctx.actorLabel},
          ${event.action},
          ${event.targetType},
          ${event.targetId}::uuid,
          ${canonicalPayload}::jsonb,
          ${payloadDigest},
          ${ctx.correlationId}
        )
    `.execute(trx);

    const row = result.rows[0];
    if (!row) {
      throw new Error('append_audit_event returned no row');
    }

    return { seq: row.seq, hash: row.hash, occurredAt: row.occurred_at };
  }

  /** Newest first, paged on `seq`. Row-level security scopes this to the tenant. */
  async list(ctx: RequestContext, query: AuditListQuery): Promise<Page<AuditEventView>> {
    const before = query.cursor === undefined ? undefined : cursorSeq(query.cursor);

    return this.database.withTenant(ctx, async (trx) => {
      let statement = trx
        .selectFrom('aliquot.audit_event')
        .select([
          'id',
          'actor_type',
          'actor_id',
          'actor_label',
          'action',
          'target_type',
          'target_id',
          'payload',
          'payload_digest',
          'prev_hash',
          'hash',
          'correlation_id',
        ])
        // Rendered by the database in both cases: `seq` is a bigint that must
        // never round-trip through a double, and `occurred_at` must be the
        // canonical microsecond text the hash was taken over.
        .select(sql<string>`seq::text`.as('seq'))
        .select(sql<string>`aliquot.audit_timestamp_text(occurred_at)`.as('occurred_at'))
        // Redundant with the RLS policy, and kept because it makes the
        // (tenant_id, seq) primary key a range scan rather than a filter.
        .where('tenant_id', '=', ctx.tenantId)
        // Qualified deliberately. The selected output column `seq` is
        // `seq::text`, and PostgreSQL resolves a bare ORDER BY name against the
        // output list before the table -- so `order by "seq"` would sort the
        // audit stream as text (1, 10, 11, 2, ...). Pages would come back in
        // nonsense order and the `seq <` cursor would skip events, which for an
        // append-only log is a correctness failure rather than a display bug.
        // A qualified reference cannot match an output alias.
        .orderBy(sql`aliquot.audit_event.seq`, 'desc')
        .limit(query.limit + 1);

      if (before !== undefined) {
        statement = statement.where(sql<boolean>`seq < ${before}::bigint`);
      }
      if (query.action !== undefined) {
        statement = statement.where('action', '=', query.action);
      }
      if (query.targetType !== undefined) {
        statement = statement.where('target_type', '=', query.targetType);
      }
      if (query.targetId !== undefined) {
        statement = statement.where('target_id', '=', query.targetId);
      }

      const rows = await statement.execute();
      return buildPage(rows.map(toView), query.limit, (event) => [event.seq]);
    });
  }
}

function toView(row: {
  seq: string;
  id: string;
  actor_type: ActorType;
  actor_id: string | null;
  actor_label: string;
  action: string;
  target_type: string;
  target_id: string | null;
  payload: Record<string, unknown>;
  payload_digest: string;
  prev_hash: string;
  hash: string;
  occurred_at: string;
  correlation_id: string | null;
}): AuditEventView {
  return {
    seq: row.seq,
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorLabel: row.actor_label,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    payload: row.payload,
    payloadDigest: row.payload_digest,
    prevHash: row.prev_hash,
    hash: row.hash,
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
  };
}

function cursorSeq(cursor: string): string {
  const [seq] = decodeCursor(cursor, 1);
  if (seq === undefined || !DECIMAL.test(seq)) {
    throw new ValidationError('cursor is not a valid pagination cursor');
  }
  return seq;
}
