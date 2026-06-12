import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { buildPage, decodeCursor } from '../common/cursor';
import type { Page } from '../common/cursor';
import { ConflictError, ValidationError } from '../common/problem-details';
import { uuidv7 } from '../common/uuid';
import { AppConfig } from '../config/config';
import { DatabaseService } from '../database/database.service';
import type { Trx } from '../database/database.service';
import type { RequestContext } from '../database/request-context';
import { AuditService } from './audit.service';
import { ChainBrokenError, ChainVerifier } from './chain-verifier';

/**
 * Chain checkpoints: (through_seq, chain_hash, event_count) recorded periodically.
 *
 * What a checkpoint stored in this database buys, honestly:
 *
 *   - Verification cost. Full-history verification is O(all events) and gets
 *     slower every day. From a checkpoint it is O(events since the checkpoint),
 *     which is what makes verifying on a schedule realistic rather than
 *     aspirational.
 *   - A second place the head hash is written. `audit_checkpoint` is append-only
 *     and the application role has no UPDATE or DELETE on it, so a rewrite of
 *     history has to rewrite the checkpoints too or leave an obvious
 *     contradiction behind.
 *
 * What it does not buy: protection from anyone holding full database
 * privileges. They can rewrite an event, recompute every hash after it, and
 * rewrite the checkpoints in the same transaction. Chaining and checkpointing
 * raise the cost of tampering from one UPDATE to a coordinated rewrite; they do
 * not make it impossible, and claiming otherwise would be the kind of overclaim
 * that discredits the rest of the mechanism.
 *
 * The property that actually closes the gap arrives with `external_ref`: the
 * checkpoint mirrored to somewhere this database's role cannot reach -- an
 * object store version id under a different credential, a transparency log
 * index, a countersignature. From that point on, verification from the last
 * externally corroborated checkpoint forward is genuinely tamper-evident,
 * because the value being chained back to is no longer under the same authority
 * as the data. `external_ref` is null until such a mirror is configured, and a
 * null here should be read as "this checkpoint proves internal consistency and
 * nothing more".
 */

export interface CheckpointRecord {
  id: string;
  throughSeq: string;
  chainHash: string;
  eventCount: string;
  createdAt: Date;
  externalRef: string | null;
}

export interface CreateCheckpointOptions {
  /** Ignore the minimum-events threshold. */
  force?: boolean;
  /** Opaque handle produced by an external mirror. Stored verbatim, never interpreted. */
  externalRef?: string;
  /** Verify the chain since the previous checkpoint before recording a new one. Default true. */
  verify?: boolean;
}

export interface CheckpointListQuery {
  limit: number;
  cursor?: string;
}

const DECIMAL = /^\d+$/;

@Injectable()
export class CheckpointService {
  constructor(
    private readonly database: DatabaseService,
    private readonly verifier: ChainVerifier,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Record a checkpoint at the current head of the tenant's chain.
   *
   * Returns `created: false` with the existing checkpoint when the chain has not
   * moved far enough to be worth another one. Checkpointing appends an audit
   * event of its own, so the head is always one ahead of the checkpoint that
   * covers it -- without a threshold, two consecutive requests would each find
   * new events and checkpoint forever.
   */
  async create(
    ctx: RequestContext,
    options: CreateCheckpointOptions = {},
  ): Promise<{ checkpoint: CheckpointRecord; created: boolean }> {
    return this.database.withTenant(ctx, async (trx) => {
      // The head is read from `audit_event`, not from `audit_chain_head`: the
      // application role has no privileges on the head table at all, precisely
      // so that it cannot rewind the chain. Reading the last event gets the same
      // answer from data the role is allowed to see.
      // ORDER BY is qualified because the output column `seq` is `seq::text`,
      // and PostgreSQL resolves a bare name in ORDER BY against the output list
      // before the table. Unqualified, this sorts as text and picks event 9 as
      // the head of a twelve-event chain -- a checkpoint anchored to the wrong
      // place, which is worse than no checkpoint at all.
      const head = await sql<{ seq: string; hash: string }>`
        select e.seq::text as seq, e.hash
          from aliquot.audit_event e
         where e.tenant_id = ${ctx.tenantId}::uuid
         order by e.seq desc
         limit 1
      `.execute(trx);

      const headRow = head.rows[0];
      if (!headRow) {
        throw new ConflictError(
          'This tenant has no audit events, so there is nothing to checkpoint.',
        );
      }

      const previous = await this.latestWithin(trx, ctx);
      const headSeq = BigInt(headRow.seq);
      const previousSeq = previous ? BigInt(previous.throughSeq) : 0n;

      if (
        previous !== null &&
        options.force !== true &&
        headSeq - previousSeq < BigInt(this.config.checkpoint.minEvents)
      ) {
        return { checkpoint: previous, created: false };
      }

      if (options.verify !== false) {
        // Checkpointing a chain that is already broken launders the break: every
        // later verification starts from a corroborated-looking value that was
        // computed over corrupted history.
        const result = await this.verifier.verifyWithin(trx, ctx, {
          fromSeq: (previousSeq + 1n).toString(),
        });
        if (!result.ok) {
          throw new ChainBrokenError(result);
        }
      }

      // count(*) rather than through_seq. They are equal for an intact chain, so
      // recording both means a later reader can spot a deleted event by
      // comparing two numbers, without rehashing anything.
      const counted = await sql<{ event_count: string }>`
        select count(*)::text as event_count
          from aliquot.audit_event
         where tenant_id = ${ctx.tenantId}::uuid
           and seq <= ${headRow.seq}::bigint
      `.execute(trx);

      const eventCount = counted.rows[0]?.event_count ?? '0';
      const id = uuidv7();

      const inserted = await trx
        .insertInto('aliquot.audit_checkpoint')
        .values({
          id,
          tenant_id: ctx.tenantId,
          through_seq: headRow.seq,
          chain_hash: headRow.hash,
          event_count: eventCount,
          external_ref: options.externalRef ?? null,
        })
        .returning(['id', 'chain_hash', 'created_at', 'external_ref'])
        .executeTakeFirstOrThrow();

      await this.audit.append(trx, ctx, {
        action: 'audit.checkpointed',
        targetType: 'audit_checkpoint',
        targetId: id,
        payload: {
          throughSeq: headRow.seq,
          chainHash: headRow.hash,
          eventCount,
          externalRef: options.externalRef ?? null,
        },
      });

      return {
        checkpoint: {
          id: inserted.id,
          throughSeq: headRow.seq,
          chainHash: inserted.chain_hash,
          eventCount,
          createdAt: inserted.created_at,
          externalRef: inserted.external_ref,
        },
        created: true,
      };
    });
  }

  async latest(ctx: RequestContext): Promise<CheckpointRecord | null> {
    return this.database.withTenant(ctx, (trx) => this.latestWithin(trx, ctx));
  }

  /** Newest first, paged on `through_seq`, which is unique per tenant. */
  async list(ctx: RequestContext, query: CheckpointListQuery): Promise<Page<CheckpointRecord>> {
    const before = query.cursor === undefined ? undefined : cursorSeq(query.cursor);

    return this.database.withTenant(ctx, async (trx) => {
      let statement = trx
        .selectFrom('aliquot.audit_checkpoint')
        .select(['id', 'chain_hash', 'created_at', 'external_ref'])
        .select(sql<string>`through_seq::text`.as('through_seq'))
        .select(sql<string>`event_count::text`.as('event_count'))
        .where('tenant_id', '=', ctx.tenantId)
        .orderBy('through_seq', 'desc')
        .limit(query.limit + 1);

      if (before !== undefined) {
        statement = statement.where(sql<boolean>`through_seq < ${before}::bigint`);
      }

      const rows = await statement.execute();
      return buildPage(rows.map(toRecord), query.limit, (checkpoint) => [checkpoint.throughSeq]);
    });
  }

  private async latestWithin(trx: Trx, ctx: RequestContext): Promise<CheckpointRecord | null> {
    const row = await trx
      .selectFrom('aliquot.audit_checkpoint')
      .select(['id', 'chain_hash', 'created_at', 'external_ref'])
      .select(sql<string>`through_seq::text`.as('through_seq'))
      .select(sql<string>`event_count::text`.as('event_count'))
      .where('tenant_id', '=', ctx.tenantId)
      .orderBy('through_seq', 'desc')
      .limit(1)
      .executeTakeFirst();

    return row === undefined ? null : toRecord(row);
  }
}

function toRecord(row: {
  id: string;
  through_seq: string;
  chain_hash: string;
  event_count: string;
  created_at: Date;
  external_ref: string | null;
}): CheckpointRecord {
  return {
    id: row.id,
    throughSeq: row.through_seq,
    chainHash: row.chain_hash,
    eventCount: row.event_count,
    createdAt: row.created_at,
    externalRef: row.external_ref,
  };
}

function cursorSeq(cursor: string): string {
  const [seq] = decodeCursor(cursor, 1);
  if (seq === undefined || !DECIMAL.test(seq)) {
    throw new ValidationError('cursor is not a valid pagination cursor');
  }
  return seq;
}
