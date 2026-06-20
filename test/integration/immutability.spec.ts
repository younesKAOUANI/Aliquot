import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '../../src/common/uuid';
import {
  type TenantFixture,
  adminDb,
  closeDatabases,
  createTenant,
  insertRun,
} from './support/database';

/**
 * R4 — sealing is the immutability boundary, enforced below the application.
 *
 * Every mutation attempted here is made through the **database owner**, which is
 * a superuser and bypasses row-level security entirely. That is deliberate: the
 * claim is not "the API refuses to modify a sealed run", which any `if`
 * statement can achieve and any refactor can remove. The claim is that a sealed
 * run cannot be modified by anything short of dropping the trigger — including
 * by a maintenance script, a psql session, or an insider with full credentials.
 *
 * If these tests were written against the API they would pass just as happily
 * with the trigger deleted, and would therefore be testing nothing that matters.
 */
describe('immutability of sealed runs', () => {
  let tenant: TenantFixture;

  beforeAll(async () => {
    tenant = await createTenant('immutability');
  });

  afterAll(async () => {
    await closeDatabases();
  });

  describe('a sealed run', () => {
    it('rejects a change to every column outside the processing set', async () => {
      // Column by column rather than one representative field. The trigger
      // compares a jsonb projection minus an allow-list, so a mistake in that
      // allow-list would leave exactly one column quietly writable, and a
      // single-column test would have a 1-in-N chance of finding it.
      const other = await createTenant('immutability-other');
      const decoyRun = await insertRun(tenant, { state: 'SEALED' });

      const mutations: [string, Record<string, unknown>][] = [
        ['study_id', { study_id: other.studyId }],
        ['instrument_id', { instrument_id: other.instrumentId }],
        ['operator_id', { operator_id: other.userId }],
        ['manifest_digest', { manifest_digest: 'f'.repeat(64) }],
        ['acquired_at', { acquired_at: new Date('2001-01-01T00:00:00Z') }],
        ['registered_at', { registered_at: new Date('2001-01-01T00:00:00Z') }],
        ['sealed_at', { sealed_at: new Date('2001-01-01T00:00:00Z') }],
        ['protocol', { protocol: JSON.stringify({ tampered: true }) }],
        // A real value, not null. The fixture already has null here, and
        // setting a column to the value it already holds is not a mutation --
        // the trigger's jsonb diff correctly sees no change and permits it.
        ['supersedes_run_id', { supersedes_run_id: decoyRun, supersede_reason: 'retrofitted' }],
        ['quarantine_reason', { quarantine_reason: 'invented after the fact' }],
        ['tenant_id', { tenant_id: other.tenantId }],
      ];

      const permitted: string[] = [];

      for (const [column, change] of mutations) {
        const runId = await insertRun(tenant, { state: 'SEALED' });
        try {
          await adminDb()
            .updateTable('aliquot.run')
            .set(change as never)
            .where('id', '=', runId)
            .execute();
          permitted.push(column);
        } catch {
          /* rejected, which is the expected outcome */
        }
      }

      expect(permitted).toEqual([]);
    });

    it('names the run and says why', async () => {
      const runId = await insertRun(tenant, { state: 'SEALED' });

      await expect(
        adminDb()
          .updateTable('aliquot.run')
          .set({ manifest_digest: 'a'.repeat(64) })
          .where('id', '=', runId)
          .execute(),
      ).rejects.toThrow(new RegExp(`run ${runId} is sealed`, 'i'));
    });

    it('permits the processing columns, or nothing could ever be processed', async () => {
      // The guard against an over-broad trigger. A trigger that rejected every
      // update would pass all the tests above and break the worker.
      const runId = await insertRun(tenant, { state: 'SEALED' });

      await adminDb()
        .updateTable('aliquot.run')
        .set({
          state: 'PROCESSING',
          processing_started_at: new Date(),
          processing_attempts: 1,
        })
        .where('id', '=', runId)
        .execute();

      const after = await adminDb()
        .selectFrom('aliquot.run')
        .select(['state', 'processing_attempts'])
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();

      expect(after.state).toBe('PROCESSING');
      expect(after.processing_attempts).toBe(1);
    });

    it('cannot be deleted by the application role', async () => {
      const grants = await sql<{ can_delete: boolean }>`
        select has_table_privilege('aliquot_app', 'aliquot.run', 'DELETE') as can_delete
      `.execute(adminDb());

      expect(grants.rows[0]?.can_delete).toBe(false);
    });
  });

  describe('the state machine in the trigger', () => {
    it.each([
      ['SEALED', 'PROCESSING', true],
      ['PROCESSING', 'PROCESSED', true],
      ['PROCESSING', 'PROCESSING_FAILED', true],
      ['PROCESSING_FAILED', 'PROCESSING', true],
      ['SEALED', 'OPEN', false],
      ['SEALED', 'PROCESSED', false],
      ['SEALED', 'QUARANTINED', false],
      ['SEALED', 'ABANDONED', false],
      ['PROCESSED', 'PROCESSING', false],
      ['PROCESSED', 'OPEN', false],
    ])('%s -> %s is %s', async (from, to, allowed) => {
      const runId = uuidv7();
      await insertRun(tenant, { id: runId, state: 'SEALED' });

      // Walk to the starting state through legal transitions, since the trigger
      // will not let us fabricate it directly.
      const path: Record<string, string[]> = {
        SEALED: [],
        PROCESSING: ['PROCESSING'],
        PROCESSED: ['PROCESSING', 'PROCESSED'],
        PROCESSING_FAILED: ['PROCESSING', 'PROCESSING_FAILED'],
      };
      for (const step of path[from] ?? []) {
        await adminDb()
          .updateTable('aliquot.run')
          .set({ state: step as never })
          .where('id', '=', runId)
          .execute();
      }

      const attempt = adminDb()
        .updateTable('aliquot.run')
        .set({ state: to as never })
        .where('id', '=', runId)
        .execute();

      if (allowed) {
        await expect(attempt).resolves.toBeDefined();
      } else {
        await expect(attempt).rejects.toThrow(/illegal run transition|is sealed/i);
      }
    });
  });

  describe('terminal states', () => {
    it.each(['QUARANTINED', 'ABANDONED'])('%s runs reject every update', async (state) => {
      const runId = await insertRun(tenant, { state: state as 'QUARANTINED' });

      await expect(
        adminDb()
          .updateTable('aliquot.run')
          .set({ state: 'OPEN' })
          .where('id', '=', runId)
          .execute(),
      ).rejects.toThrow(/terminal state/i);

      // Even a processing column, which is writable on a sealed run.
      await expect(
        adminDb()
          .updateTable('aliquot.run')
          .set({ processing_error: 'retrying' })
          .where('id', '=', runId)
          .execute(),
      ).rejects.toThrow(/terminal state/i);
    });
  });

  describe('manifest bindings', () => {
    it('can be written while the run is OPEN', async () => {
      const runId = await insertRun(tenant, { state: 'OPEN' });

      await adminDb()
        .insertInto('aliquot.run_artifact')
        .values({
          id: uuidv7(),
          tenant_id: tenant.tenantId,
          run_id: runId,
          logical_name: 'ch0/stack.tif',
          declared_digest: 'a'.repeat(64),
          declared_size: 1024,
        })
        .execute();

      const rows = await adminDb()
        .selectFrom('aliquot.run_artifact')
        .select('id')
        .where('run_id', '=', runId)
        .execute();

      expect(rows).toHaveLength(1);
    });

    it('freeze when the run is sealed', async () => {
      const runId = await insertRun(tenant, { state: 'OPEN' });
      const artifactRowId = uuidv7();

      await adminDb()
        .insertInto('aliquot.run_artifact')
        .values({
          id: artifactRowId,
          tenant_id: tenant.tenantId,
          run_id: runId,
          logical_name: 'ch0/stack.tif',
          declared_digest: 'a'.repeat(64),
          declared_size: 1024,
        })
        .execute();

      await adminDb()
        .updateTable('aliquot.run')
        .set({ state: 'SEALED', sealed_at: new Date() })
        .where('id', '=', runId)
        .execute();

      // Update
      await expect(
        adminDb()
          .updateTable('aliquot.run_artifact')
          .set({ declared_digest: 'b'.repeat(64) })
          .where('id', '=', artifactRowId)
          .execute(),
      ).rejects.toThrow(/frozen/i);

      // Insert a new binding
      await expect(
        adminDb()
          .insertInto('aliquot.run_artifact')
          .values({
            id: uuidv7(),
            tenant_id: tenant.tenantId,
            run_id: runId,
            logical_name: 'ch1/smuggled.tif',
            declared_digest: 'c'.repeat(64),
            declared_size: 1,
          })
          .execute(),
      ).rejects.toThrow(/frozen/i);

      // Delete
      await expect(
        adminDb().deleteFrom('aliquot.run_artifact').where('id', '=', artifactRowId).execute(),
      ).rejects.toThrow(/frozen/i);
    });
  });

  describe('artifacts', () => {
    it('are immutable from the moment they exist', async () => {
      // Content-addressed rows describe bytes stored under a key derived from
      // their own digest. Nothing about them can legitimately change.
      const runId = await insertRun(tenant, { state: 'OPEN' });
      const artifactId = uuidv7();
      const digest = 'e'.repeat(64);

      await adminDb()
        .insertInto('aliquot.artifact')
        .values({
          id: artifactId,
          tenant_id: tenant.tenantId,
          digest,
          size_bytes: 4096,
          storage_key: `sha256/ee/ee/${digest}`,
          first_seen_run_id: runId,
        })
        .execute();

      // Raw SQL on purpose: the Kysely column type makes artifact columns
      // un-updatable at compile time, which is the right default and is also
      // why the runtime guarantee has to be tested from outside it.
      await expect(
        sql`update aliquot.artifact set size_bytes = 1 where id = ${artifactId}::uuid`.execute(
          adminDb(),
        ),
      ).rejects.toThrow(/immutable/i);

      await expect(
        adminDb().deleteFrom('aliquot.artifact').where('id', '=', artifactId).execute(),
      ).rejects.toThrow(/immutable/i);
    });

    it('deduplicate within a tenant by digest', async () => {
      const runId = await insertRun(tenant, { state: 'OPEN' });
      const digest = '1'.repeat(64);

      await adminDb()
        .insertInto('aliquot.artifact')
        .values({
          id: uuidv7(),
          tenant_id: tenant.tenantId,
          digest,
          size_bytes: 10,
          storage_key: `sha256/11/11/${digest}`,
          first_seen_run_id: runId,
        })
        .execute();

      await expect(
        adminDb()
          .insertInto('aliquot.artifact')
          .values({
            id: uuidv7(),
            tenant_id: tenant.tenantId,
            digest,
            size_bytes: 10,
            storage_key: `sha256/11/11/${digest}`,
            first_seen_run_id: runId,
          })
          .execute(),
      ).rejects.toThrow(/artifact_digest_unique_per_tenant/i);
    });

    it('do not deduplicate across tenants', async () => {
      // Deliberate. A shared digest namespace would make the existence of a
      // digest an oracle telling one tenant that another holds a particular
      // file (ADR-0017).
      const other = await createTenant('dedup-other');
      const otherRun = await insertRun(other, { state: 'OPEN' });
      const tenantRun = await insertRun(tenant, { state: 'OPEN' });
      const digest = '2'.repeat(64);

      for (const [fixture, runId] of [
        [tenant, tenantRun],
        [other, otherRun],
      ] as const) {
        await adminDb()
          .insertInto('aliquot.artifact')
          .values({
            id: uuidv7(),
            tenant_id: fixture.tenantId,
            digest,
            size_bytes: 10,
            storage_key: `sha256/22/22/${digest}`,
            first_seen_run_id: runId,
          })
          .execute();
      }

      const rows = await adminDb()
        .selectFrom('aliquot.artifact')
        .select('id')
        .where('digest', '=', digest)
        .execute();

      expect(rows).toHaveLength(2);
    });
  });

  describe('supersede', () => {
    it('leaves the predecessor byte-identical', async () => {
      // The entire argument for supersede-over-mutate (ADR-0010): an external
      // citation must keep pointing at exactly what it cited.
      const originalId = await insertRun(tenant, { state: 'SEALED' });
      const before = await adminDb()
        .selectFrom('aliquot.run')
        .selectAll()
        .where('id', '=', originalId)
        .executeTakeFirstOrThrow();

      await adminDb()
        .insertInto('aliquot.run')
        .values({
          id: uuidv7(),
          tenant_id: tenant.tenantId,
          study_id: tenant.studyId,
          instrument_id: tenant.instrumentId,
          operator_id: tenant.userId,
          state: 'OPEN',
          manifest_digest: '3'.repeat(64),
          supersedes_run_id: originalId,
          supersede_reason: 'channel 2 re-acquired after a focus drift',
        })
        .execute();

      const after = await adminDb()
        .selectFrom('aliquot.run')
        .selectAll()
        .where('id', '=', originalId)
        .executeTakeFirstOrThrow();

      expect(after).toEqual(before);
    });

    it('requires a reason', async () => {
      // A correction with no stated cause is not a correction, it is a second
      // version of the truth.
      await expect(
        adminDb()
          .insertInto('aliquot.run')
          .values({
            id: uuidv7(),
            tenant_id: tenant.tenantId,
            study_id: tenant.studyId,
            instrument_id: tenant.instrumentId,
            operator_id: tenant.userId,
            manifest_digest: '4'.repeat(64),
            supersedes_run_id: await insertRun(tenant, { state: 'SEALED' }),
          })
          .execute(),
      ).rejects.toThrow(/run_supersede_reason_present/i);
    });

    it('refuses a run that supersedes itself', async () => {
      const id = uuidv7();
      await expect(
        adminDb()
          .insertInto('aliquot.run')
          .values({
            id,
            tenant_id: tenant.tenantId,
            study_id: tenant.studyId,
            instrument_id: tenant.instrumentId,
            operator_id: tenant.userId,
            manifest_digest: '5'.repeat(64),
            supersedes_run_id: id,
            supersede_reason: 'nonsense',
          })
          .execute(),
      ).rejects.toThrow(/run_no_self_supersede/i);
    });
  });
});
