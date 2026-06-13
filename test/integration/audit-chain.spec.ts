import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ChainVerifier } from '../../src/audit/chain-verifier';
import { digestCanonical } from '../../src/common/digest';
import { uuidv7 } from '../../src/common/uuid';
import type { DatabaseService } from '../../src/database/database.service';
import { type TenantFixture, adminDb, closeDatabases, createTenant } from './support/database';
import { closeServices, contextFor, testDatabase } from './support/services';

/**
 * G4 — tampering is detectable, and detection names the specific broken link.
 *
 * The tamper attempts here all go through the **database owner**, a superuser
 * that bypasses row-level security and every grant. That is the threat being
 * modelled: not a bug in the API, but somebody with full database credentials
 * editing history after the fact. If these tests went through the API they
 * would prove only that the API declines to offer an UPDATE endpoint.
 *
 * Note what the suite does *not* claim. An attacker who rewrites an event and
 * then recomputes every subsequent hash produces a chain that verifies cleanly,
 * and the final test here demonstrates exactly that rather than pretending
 * otherwise. Chaining raises the cost of tampering; only an externally
 * anchored checkpoint closes it.
 */
describe('audit chain', () => {
  let database: DatabaseService;
  let verifier: ChainVerifier;

  beforeAll(async () => {
    database = await testDatabase();
    verifier = new ChainVerifier(database);
  });

  afterAll(async () => {
    await closeServices();
    await closeDatabases();
  });

  async function appendEvents(tenant: TenantFixture, count: number): Promise<void> {
    const ctx = contextFor(tenant.tenantId);
    for (let index = 0; index < count; index += 1) {
      const payload = { index, note: `event ${index}` };
      await database.withTenant(ctx, async (trx) => {
        await sql`
          select * from aliquot.append_audit_event(
            'user'::aliquot.actor_type,
            ${null}::uuid,
            ${'Integration Test'},
            ${'run.registered'},
            ${'run'},
            ${uuidv7()}::uuid,
            ${JSON.stringify(payload)}::jsonb,
            ${digestCanonical(payload)},
            ${'test-correlation'}
          )
        `.execute(trx);
      });
    }
  }

  describe('a chain that has not been touched', () => {
    it('verifies clean and reports the head', async () => {
      const tenant = await createTenant('chain-clean');
      await appendEvents(tenant, 12);

      const result = await verifier.verify(contextFor(tenant.tenantId));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.eventsVerified).toBe(12);
        expect(result.headHash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('verifies across batch boundaries', async () => {
      // The batching loop is where an off-by-one silently skips an event, and a
      // skipped event is an unverified event.
      const tenant = await createTenant('chain-batched');
      await appendEvents(tenant, 25);

      const result = await verifier.verify(contextFor(tenant.tenantId), { batchSize: 4 });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.eventsVerified).toBe(25);
    });

    it('links each event to its predecessor, starting from genesis', async () => {
      const tenant = await createTenant('chain-linked');
      await appendEvents(tenant, 5);

      const rows = await adminDb()
        .selectFrom('aliquot.audit_event')
        .select(['seq', 'prev_hash', 'hash'])
        .where('tenant_id', '=', tenant.tenantId)
        .orderBy('seq')
        .execute();

      expect(rows[0]?.prev_hash).toBe('0'.repeat(64));
      for (let index = 1; index < rows.length; index += 1) {
        expect(rows[index]?.prev_hash).toBe(rows[index - 1]?.hash);
      }
    });

    it('is empty and clean for a tenant that has done nothing', async () => {
      const tenant = await createTenant('chain-empty');
      const result = await verifier.verify(contextFor(tenant.tenantId));

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.eventsVerified).toBe(0);
    });
  });

  describe('a payload edited in place', () => {
    it('is caught at the exact sequence number', async () => {
      const tenant = await createTenant('chain-payload');
      await appendEvents(tenant, 8);

      // The trigger blocks UPDATE, so tampering has to disable it first --
      // which is precisely what an insider with full privileges would do, and
      // why the chain exists rather than relying on the trigger alone.
      await sql`alter table aliquot.audit_event disable trigger audit_event_no_update`.execute(
        adminDb(),
      );
      await adminDb()
        .updateTable('aliquot.audit_event')
        .set({ payload: sql`'{"index": 4, "note": "rewritten"}'::jsonb` as never })
        .where('tenant_id', '=', tenant.tenantId)
        .where('seq', '=', '5')
        .execute();
      await sql`alter table aliquot.audit_event enable trigger audit_event_no_update`.execute(
        adminDb(),
      );

      const result = await verifier.verify(contextFor(tenant.tenantId));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.brokenAtSeq).toBe('5');
        // The payload digest is what diverges: the chain covers the digest, not
        // the payload, so an in-place edit leaves every hash intact and is only
        // visible by re-deriving the digest from the stored payload.
        expect(result.reason).toBe('payload_digest');
      }
    });
  });

  describe('an event deleted from the middle', () => {
    it('is reported as a gap at the missing sequence number', async () => {
      const tenant = await createTenant('chain-deleted');
      await appendEvents(tenant, 10);

      await sql`alter table aliquot.audit_event disable trigger audit_event_no_delete`.execute(
        adminDb(),
      );
      await adminDb()
        .deleteFrom('aliquot.audit_event')
        .where('tenant_id', '=', tenant.tenantId)
        .where('seq', '=', '6')
        .execute();
      await sql`alter table aliquot.audit_event enable trigger audit_event_no_delete`.execute(
        adminDb(),
      );

      const result = await verifier.verify(contextFor(tenant.tenantId));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.brokenAtSeq).toBe('6');
        expect(result.reason).toBe('sequence_gap');
      }
    });
  });

  describe('a rewritten hash', () => {
    it('is caught even when the payload is untouched', async () => {
      const tenant = await createTenant('chain-hash');
      await appendEvents(tenant, 6);

      await sql`alter table aliquot.audit_event disable trigger audit_event_no_update`.execute(
        adminDb(),
      );
      await adminDb()
        .updateTable('aliquot.audit_event')
        .set({ hash: 'b'.repeat(64) })
        .where('tenant_id', '=', tenant.tenantId)
        .where('seq', '=', '3')
        .execute();
      await sql`alter table aliquot.audit_event enable trigger audit_event_no_update`.execute(
        adminDb(),
      );

      const result = await verifier.verify(contextFor(tenant.tenantId));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.brokenAtSeq).toBe('3');
        expect(result.reason).toBe('hash');
        expect(result.actual).toBe('b'.repeat(64));
      }
    });
  });

  describe('a reordered pair', () => {
    it('is caught, because seq is part of the hash preimage', async () => {
      const tenant = await createTenant('chain-reordered');
      await appendEvents(tenant, 6);

      const [first, second] = await adminDb()
        .selectFrom('aliquot.audit_event')
        .selectAll()
        .where('tenant_id', '=', tenant.tenantId)
        .where('seq', 'in', ['2', '3'])
        .orderBy('seq')
        .execute();

      await sql`alter table aliquot.audit_event disable trigger audit_event_no_update`.execute(
        adminDb(),
      );
      // Swap the payloads and their digests, leaving hashes in place. Both rows
      // now claim content that was never hashed at that position.
      await adminDb()
        .updateTable('aliquot.audit_event')
        .set({
          payload: sql`${JSON.stringify(second?.payload)}::jsonb` as never,
          payload_digest: second?.payload_digest ?? '',
        })
        .where('tenant_id', '=', tenant.tenantId)
        .where('seq', '=', '2')
        .execute();
      await adminDb()
        .updateTable('aliquot.audit_event')
        .set({
          payload: sql`${JSON.stringify(first?.payload)}::jsonb` as never,
          payload_digest: first?.payload_digest ?? '',
        })
        .where('tenant_id', '=', tenant.tenantId)
        .where('seq', '=', '3')
        .execute();
      await sql`alter table aliquot.audit_event enable trigger audit_event_no_update`.execute(
        adminDb(),
      );

      const result = await verifier.verify(contextFor(tenant.tenantId));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.brokenAtSeq).toBe('2');
    });
  });

  describe('append-only enforcement', () => {
    it('rejects UPDATE and DELETE even for the owner while triggers are in place', async () => {
      const tenant = await createTenant('chain-append-only');
      await appendEvents(tenant, 2);

      await expect(
        adminDb()
          .updateTable('aliquot.audit_event')
          .set({ actor_label: 'someone else' })
          .where('tenant_id', '=', tenant.tenantId)
          .where('seq', '=', '1')
          .execute(),
      ).rejects.toThrow(/append-only/i);

      await expect(
        adminDb()
          .deleteFrom('aliquot.audit_event')
          .where('tenant_id', '=', tenant.tenantId)
          .execute(),
      ).rejects.toThrow(/append-only/i);
    });

    it('refuses to append without a tenant in session', async () => {
      // append_audit_event() is SECURITY DEFINER, so it must not become a hole
      // through the isolation boundary. It reads the tenant from the session
      // rather than taking it as an argument, and refuses when it is absent.
      await expect(
        database.withoutTenantScope('aliquot_app', async (trx) => {
          await sql`
            select * from aliquot.append_audit_event(
              'system'::aliquot.actor_type, ${null}::uuid, ${'nobody'},
              ${'run.registered'}, ${'run'}, ${null}::uuid,
              ${'{}'}::jsonb, ${digestCanonical({})}, ${null}
            )
          `.execute(trx);
        }),
      ).rejects.toThrow(/unattributable|tenant_id is not set/i);
    });
  });

  describe('per-tenant chains', () => {
    it('are independent, so one tenant cannot break another chain', async () => {
      const [alpha, beta] = await Promise.all([
        createTenant('chain-alpha'),
        createTenant('chain-beta'),
      ]);
      await appendEvents(alpha, 4);
      await appendEvents(beta, 4);

      // Sequence numbers restart per tenant; the chain head is locked per
      // tenant, so concurrent appends across tenants do not contend.
      const alphaSeqs = await adminDb()
        .selectFrom('aliquot.audit_event')
        .select('seq')
        .where('tenant_id', '=', alpha.tenantId)
        .orderBy('seq')
        .execute();

      expect(alphaSeqs.map((row) => row.seq)).toEqual(['1', '2', '3', '4']);

      await sql`alter table aliquot.audit_event disable trigger audit_event_no_update`.execute(
        adminDb(),
      );
      await adminDb()
        .updateTable('aliquot.audit_event')
        .set({ hash: 'c'.repeat(64) })
        .where('tenant_id', '=', alpha.tenantId)
        .where('seq', '=', '2')
        .execute();
      await sql`alter table aliquot.audit_event enable trigger audit_event_no_update`.execute(
        adminDb(),
      );

      expect((await verifier.verify(contextFor(alpha.tenantId))).ok).toBe(false);
      expect((await verifier.verify(contextFor(beta.tenantId))).ok).toBe(true);
    });
  });

  describe('concurrent appends', () => {
    it('produce a contiguous, correctly linked chain', async () => {
      // The chain head row lock is what makes this safe. Without it two
      // concurrent appends could read the same prev_hash and fork the chain
      // into two branches that each look valid in isolation.
      const tenant = await createTenant('chain-concurrent');
      const ctx = contextFor(tenant.tenantId);

      await Promise.all(
        Array.from({ length: 20 }, (_unused, index) =>
          database.withTenant(ctx, async (trx) => {
            const payload = { index };
            await sql`
              select * from aliquot.append_audit_event(
                'system'::aliquot.actor_type, ${null}::uuid, ${'concurrent'},
                ${'run.registered'}, ${'run'}, ${null}::uuid,
                ${JSON.stringify(payload)}::jsonb, ${digestCanonical(payload)}, ${null}
              )
            `.execute(trx);
          }),
        ),
      );

      const result = await verifier.verify(ctx);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.eventsVerified).toBe(20);
    });
  });

  describe('the limit of what chaining alone can detect', () => {
    it('does NOT detect a rewrite that also recomputes every following hash', async () => {
      // Stated as a test rather than a caveat in prose, because this is the
      // claim most often overstated about hash chains. An actor with full
      // database privileges can rewrite history consistently and the chain will
      // verify. Closing this requires the head to be anchored somewhere the
      // database role cannot reach -- audit_checkpoint.external_ref.
      const tenant = await createTenant('chain-full-rewrite');
      await appendEvents(tenant, 5);

      await sql`alter table aliquot.audit_event disable trigger audit_event_no_update`.execute(
        adminDb(),
      );

      const tamperedPayload = { index: 2, note: 'rewritten consistently' };

      const rows = await adminDb()
        .selectFrom('aliquot.audit_event')
        .select(['seq', 'payload', 'payload_digest', 'prev_hash', 'hash'])
        .where('tenant_id', '=', tenant.tenantId)
        .orderBy('seq')
        .execute();

      const { createHash } = await import('node:crypto');
      const timestamps = await sql<{ seq: string; ts: string }>`
        select seq::text as seq, aliquot.audit_timestamp_text(occurred_at) as ts
          from aliquot.audit_event where tenant_id = ${tenant.tenantId}::uuid order by seq
      `.execute(adminDb());
      const tsBySeq = new Map(timestamps.rows.map((row) => [row.seq, row.ts]));

      let prevHash = '0'.repeat(64);
      for (const row of rows) {
        const isTarget = row.seq === '3';
        const payload = isTarget ? tamperedPayload : row.payload;
        const payloadDigest = digestCanonical(payload);
        const preimage = [
          tenant.tenantId,
          row.seq,
          prevHash,
          payloadDigest,
          tsBySeq.get(row.seq) ?? '',
        ].join('|');
        const hash = createHash('sha256').update(preimage, 'utf8').digest('hex');

        await adminDb()
          .updateTable('aliquot.audit_event')
          .set({
            ...(isTarget
              ? { payload: sql`${JSON.stringify(tamperedPayload)}::jsonb` as never }
              : {}),
            payload_digest: payloadDigest,
            prev_hash: prevHash,
            hash,
          })
          .where('tenant_id', '=', tenant.tenantId)
          .where('seq', '=', row.seq)
          .execute();

        prevHash = hash;
      }

      await sql`alter table aliquot.audit_event enable trigger audit_event_no_update`.execute(
        adminDb(),
      );

      const result = await verifier.verify(contextFor(tenant.tenantId));
      expect(result.ok).toBe(true);

      // And this is why checkpoints exist: a head recorded before the rewrite
      // no longer matches, so verification anchored to it does fail.
      expect(prevHash).not.toBe(rows[rows.length - 1]?.hash);
    });

    it('DOES detect the same rewrite when anchored to a prior checkpoint', async () => {
      const tenant = await createTenant('chain-checkpointed');
      await appendEvents(tenant, 6);

      const head = await adminDb()
        .selectFrom('aliquot.audit_event')
        .select(['seq', 'hash'])
        .where('tenant_id', '=', tenant.tenantId)
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();

      await adminDb()
        .insertInto('aliquot.audit_checkpoint')
        .values({
          id: uuidv7(),
          tenant_id: tenant.tenantId,
          through_seq: head.seq,
          chain_hash: head.hash,
          event_count: head.seq,
          external_ref: 'test://anchored-outside-the-database',
        })
        .execute();

      await appendEvents(tenant, 3);

      await sql`alter table aliquot.audit_event disable trigger audit_event_no_update`.execute(
        adminDb(),
      );
      await adminDb()
        .updateTable('aliquot.audit_event')
        .set({ hash: 'd'.repeat(64) })
        .where('tenant_id', '=', tenant.tenantId)
        .where('seq', '=', head.seq)
        .execute();
      await sql`alter table aliquot.audit_event enable trigger audit_event_no_update`.execute(
        adminDb(),
      );

      // Verifying from the event after the checkpoint compares the seed against
      // the checkpoint rather than trusting the stored row.
      const result = await verifier.verify(contextFor(tenant.tenantId), {
        fromSeq: String(Number(head.seq) + 1),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.brokenAtSeq).toBe(head.seq);
        expect(result.expected).toBe(head.hash);
      }
    });
  });
});

/**
 * Regression: ordering the audit stream by an output alias.
 *
 * `select seq::text as seq ... order by seq` sorts as text, so a chain of
 * twelve events walks 1, 10, 11, 12, 2, 3 ... The verifier reports that as a
 * sequence gap -- indistinguishable from tampering -- and paging reads the
 * stream in nonsense order while the `seq <` cursor silently skips rows.
 *
 * It only appears once a tenant has ten or more events, so any fixture smaller
 * than that passes happily. Hence the deliberately awkward number below.
 */
describe('sequence ordering', () => {
  it('orders past the single-digit boundary numerically, not lexicographically', async () => {
    const database = await testDatabase();
    const verifier = new ChainVerifier(database);
    const tenant = await createTenant('chain-ordering');
    const ctx = contextFor(tenant.tenantId);

    for (let index = 0; index < 23; index += 1) {
      const payload = { index };
      await database.withTenant(ctx, async (trx) => {
        await sql`
          select * from aliquot.append_audit_event(
            'system'::aliquot.actor_type, ${null}::uuid, ${'ordering'},
            ${'run.registered'}, ${'run'}, ${null}::uuid,
            ${JSON.stringify(payload)}::jsonb, ${digestCanonical(payload)}, ${null}
          )
        `.execute(trx);
      });
    }

    const result = await verifier.verify(ctx, { batchSize: 7 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.eventsVerified).toBe(23);

    // And the same trap, asserted directly against the ordering the read path
    // depends on.
    const rows = await sql<{ seq: string }>`
      select e.seq::text as seq from aliquot.audit_event e
       where e.tenant_id = ${tenant.tenantId}::uuid
       order by e.seq desc limit 3
    `.execute(adminDb());

    expect(rows.rows.map((row) => row.seq)).toEqual(['23', '22', '21']);
  });
});
