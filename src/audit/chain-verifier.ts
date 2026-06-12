import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { digestCanonical, sha256Hex } from '../common/digest';
import { AliquotError, ProblemType, ValidationError } from '../common/problem-details';
import { DatabaseService } from '../database/database.service';
import type { Trx } from '../database/database.service';
import type { RequestContext } from '../database/request-context';

/**
 * Independent verification of the audit hash chain.
 *
 * The recomputation here deliberately shares nothing with the appender. It does
 * not call `aliquot.audit_hash_preimage()`, it does not call PostgreSQL's
 * `sha256()`, and it does not trust `audit_chain_head`: it reads the stored
 * columns and rebuilds the preimage in TypeScript. A verifier that reuses the
 * appender's implementation can only ever prove that the implementation agrees
 * with itself, which is exactly the class of bug -- a wrong preimage, a
 * timestamp rendered with the wrong precision -- that would otherwise sit
 * undetected until an auditor asked.
 *
 * The preimage is, byte for byte:
 *
 *   tenant_id | seq | prev_hash | payload_digest | occurred_at
 *
 * with `occurred_at` as `YYYY-MM-DDTHH:MM:SS.ffffffZ` in UTC. Six sub-second
 * digits, not three. A JavaScript `Date` carries milliseconds, so parsing the
 * timestamp and reformatting it would drop three digits and report every event
 * in the chain as tampered. The rendering is therefore selected as text from the
 * database, which is the one thing here that must be taken from the database
 * rather than recomputed -- the format is the contract, not the computation.
 */

export const GENESIS_HASH = '0'.repeat(64);

export type ChainBreakReason = 'payload_digest' | 'hash' | 'prev_hash_mismatch' | 'sequence_gap';

/**
 * `expected` is always what this verifier computed independently; `actual` is
 * always what the stored row claims. For `sequence_gap` they are sequence
 * numbers rather than digests, and `actual` is `absent` when the row is missing
 * outright.
 */
export type ChainVerificationResult =
  | { ok: true; eventsVerified: number; headHash: string }
  | {
      ok: false;
      brokenAtSeq: string;
      reason: ChainBreakReason;
      expected: string;
      actual: string;
    };

export interface VerifyOptions {
  /** Decimal sequence number to start from. Defaults to the beginning of the chain. */
  fromSeq?: string;
  batchSize?: number;
}

export class ChainBrokenError extends AliquotError {
  constructor(failure: Extract<ChainVerificationResult, { ok: false }>) {
    super(
      ProblemType.CHAIN_BROKEN,
      409,
      'Audit chain verification failed',
      `The chain diverges at seq ${failure.brokenAtSeq} (${failure.reason}).`,
      {
        brokenAtSeq: failure.brokenAtSeq,
        reason: failure.reason,
        expected: failure.expected,
        actual: failure.actual,
      },
    );
  }
}

const DEFAULT_BATCH = 500;
const MAX_BATCH = 5_000;
const DECIMAL = /^\d+$/;

interface ChainRow {
  seq: string;
  tenant_id: string;
  prev_hash: string;
  hash: string;
  payload: Record<string, unknown>;
  payload_digest: string;
  occurred_at_text: string;
}

@Injectable()
export class ChainVerifier {
  constructor(private readonly database: DatabaseService) {}

  async verify(ctx: RequestContext, options: VerifyOptions = {}): Promise<ChainVerificationResult> {
    // One transaction for the whole walk rather than one per batch: the tenant
    // and role are session settings that a new transaction would have to
    // re-establish, and a chain verified across several transactions is a chain
    // verified against several different snapshots. The cost is a long-lived
    // read transaction, which is acceptable for an operation that is invoked
    // deliberately rather than on every request.
    return this.database.withTenant(ctx, (trx) => this.verifyWithin(trx, ctx, options));
  }

  /**
   * The same walk inside a transaction the caller already holds, so that
   * checkpointing can verify and record in one atomic step.
   */
  async verifyWithin(
    trx: Trx,
    ctx: RequestContext,
    options: VerifyOptions = {},
  ): Promise<ChainVerificationResult> {
    const fromSeq = parseFromSeq(options.fromSeq);
    const batchSize = Math.min(Math.max(options.batchSize ?? DEFAULT_BATCH, 1), MAX_BATCH);

    const anchor = await this.anchorFor(trx, ctx, fromSeq);
    if (anchor.ok === false) return anchor;

    let prevHash = anchor.prevHash;
    let expectedSeq = fromSeq;
    let eventsVerified = 0;

    for (;;) {
      const batch = await this.fetchBatch(trx, ctx, expectedSeq, batchSize);
      if (batch.length === 0) break;

      for (const row of batch) {
        const failure = verifyRow(row, expectedSeq, prevHash);
        if (failure) return failure;

        prevHash = row.hash;
        expectedSeq += 1n;
        eventsVerified += 1;
      }

      if (batch.length < batchSize) break;
    }

    return { ok: true, eventsVerified, headHash: prevHash };
  }

  /**
   * The hash the first examined event must chain back to.
   *
   * Starting mid-chain is what makes verification affordable once the log is
   * large, and it is also where verification quietly gets weaker: the seed is
   * read from the same database as the events, so a rewrite that also rewrote
   * the seed is invisible from here. Where a checkpoint covers the seed we
   * compare against it, because a checkpoint is the value that can have been
   * mirrored somewhere this database's role cannot reach.
   */
  private async anchorFor(
    trx: Trx,
    ctx: RequestContext,
    fromSeq: bigint,
  ): Promise<{ ok: true; prevHash: string } | Extract<ChainVerificationResult, { ok: false }>> {
    if (fromSeq === 1n) {
      return { ok: true, prevHash: GENESIS_HASH };
    }

    const priorSeq = fromSeq - 1n;
    const prior = await sql<{ hash: string }>`
      select hash
        from aliquot.audit_event
       where tenant_id = ${ctx.tenantId}::uuid
         and seq = ${priorSeq.toString()}::bigint
    `.execute(trx);

    const priorHash = prior.rows[0]?.hash;
    if (priorHash === undefined) {
      return {
        ok: false,
        brokenAtSeq: priorSeq.toString(),
        reason: 'sequence_gap',
        expected: priorSeq.toString(),
        actual: 'absent',
      };
    }

    const checkpoint = await sql<{ chain_hash: string }>`
      select chain_hash
        from aliquot.audit_checkpoint
       where tenant_id = ${ctx.tenantId}::uuid
         and through_seq = ${priorSeq.toString()}::bigint
    `.execute(trx);

    const checkpointHash = checkpoint.rows[0]?.chain_hash;
    if (checkpointHash !== undefined && checkpointHash !== priorHash) {
      return {
        ok: false,
        brokenAtSeq: priorSeq.toString(),
        reason: 'hash',
        expected: checkpointHash,
        actual: priorHash,
      };
    }

    return { ok: true, prevHash: priorHash };
  }

  private async fetchBatch(
    trx: Trx,
    ctx: RequestContext,
    fromSeq: bigint,
    batchSize: number,
  ): Promise<ChainRow[]> {
    // `order by e.seq`, qualified, and not `order by seq`.
    //
    // PostgreSQL resolves a bare name in ORDER BY against the output column
    // list first, and the output column named `seq` here is `seq::text`. An
    // unqualified ORDER BY therefore sorts the chain as text -- 1, 10, 11, 2 --
    // and the walk reports a sequence gap at the second event of any chain
    // longer than nine. The failure is indistinguishable from tampering, which
    // makes it about the worst possible bug for this particular query.
    const result = await sql<ChainRow>`
      select e.seq::text                                  as seq,
             e.tenant_id::text                            as tenant_id,
             e.prev_hash,
             e.hash,
             e.payload,
             e.payload_digest,
             aliquot.audit_timestamp_text(e.occurred_at)  as occurred_at_text
        from aliquot.audit_event e
       where e.tenant_id = ${ctx.tenantId}::uuid
         and e.seq >= ${fromSeq.toString()}::bigint
       order by e.seq
       limit ${batchSize}
    `.execute(trx);

    return result.rows;
  }
}

function verifyRow(
  row: ChainRow,
  expectedSeq: bigint,
  prevHash: string,
): Extract<ChainVerificationResult, { ok: false }> | null {
  // Contiguity first. A deleted middle event shows up both as a gap here and as
  // a prev_hash mismatch on the row after it; the gap is the earlier divergence
  // and the more precise description of what happened.
  if (BigInt(row.seq) !== expectedSeq) {
    return {
      ok: false,
      brokenAtSeq: expectedSeq.toString(),
      reason: 'sequence_gap',
      expected: expectedSeq.toString(),
      actual: row.seq,
    };
  }

  // Re-derived rather than trusted, because the chain covers `payload_digest`
  // and not the payload itself. An UPDATE that edited the payload in place and
  // left the digest alone would leave every hash in the chain intact.
  //
  // The one false positive this can produce: jsonb keeps numeric precision that
  // the driver's JSON.parse does not, so a payload containing an integer beyond
  // 2^53 would come back rounded and digest differently. Payloads are ours to
  // construct, and none of them carry numbers that large.
  const recomputedDigest = digestCanonical(row.payload);
  if (recomputedDigest !== row.payload_digest) {
    return {
      ok: false,
      brokenAtSeq: row.seq,
      reason: 'payload_digest',
      expected: recomputedDigest,
      actual: row.payload_digest,
    };
  }

  if (row.prev_hash !== prevHash) {
    return {
      ok: false,
      brokenAtSeq: row.seq,
      reason: 'prev_hash_mismatch',
      expected: prevHash,
      actual: row.prev_hash,
    };
  }

  // tenant_id comes from the row rather than from the session context: the
  // preimage was built from the database's rendering of that uuid, and a
  // differently-cased identifier carried in a token would produce a mismatch on
  // an untouched event.
  const preimage = [
    row.tenant_id,
    row.seq,
    row.prev_hash,
    row.payload_digest,
    row.occurred_at_text,
  ].join('|');

  const recomputedHash = sha256Hex(preimage);
  if (recomputedHash !== row.hash) {
    return {
      ok: false,
      brokenAtSeq: row.seq,
      reason: 'hash',
      expected: recomputedHash,
      actual: row.hash,
    };
  }

  return null;
}

function parseFromSeq(fromSeq: string | undefined): bigint {
  if (fromSeq === undefined) return 1n;
  if (!DECIMAL.test(fromSeq)) {
    throw new ValidationError('fromSeq must be a decimal sequence number');
  }
  const parsed = BigInt(fromSeq);
  if (parsed < 1n) {
    throw new ValidationError('fromSeq must be at least 1');
  }
  return parsed;
}
