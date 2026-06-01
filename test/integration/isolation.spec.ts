import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type TenantFixture,
  adminDb,
  appDb,
  asTenant,
  closeDatabases,
  createTenant,
  insertRun,
  tenantScopedTables,
} from './support/database';

/**
 * G5 — tenants are isolated by construction.
 *
 * The claim being tested is not "the application filters by tenant". It is that
 * isolation holds *when the application is wrong*, because the application will
 * eventually be wrong. So every query here is deliberately unscoped: no
 * `where tenant_id = ?` anywhere. If row-level security is doing its job these
 * queries return the caller's rows and nothing else; if it is not, they return
 * everybody's, and that is the leak this whole layer exists to prevent.
 */
describe('tenant isolation', () => {
  let acme: TenantFixture;
  let umbrella: TenantFixture;

  beforeAll(async () => {
    [acme, umbrella] = await Promise.all([createTenant('acme'), createTenant('umbrella')]);
    await Promise.all([insertRun(acme), insertRun(umbrella), insertRun(umbrella)]);
  });

  afterAll(async () => {
    await closeDatabases();
  });

  describe('an unscoped query under a tenant-scoped role', () => {
    it('returns only the caller tenant rows, on every readable tenant-scoped table', async () => {
      // Driven from the catalogue rather than a hard-coded list, so a table
      // added by a future migration is covered the moment it exists.
      //
      // A tenant-scoped table is safe by one of two mechanisms, and the suite
      // insists on one or the other: it is protected by a forced policy, or the
      // application role cannot read it at all. audit_chain_head is the second
      // kind -- it is reachable only through append_audit_event().
      const tables = await tenantScopedTables();
      expect(tables.length).toBeGreaterThan(10);

      const leaking: string[] = [];
      let readable = 0;

      for (const table of tables) {
        if (!(await appRoleCanSelect(table))) continue;
        readable += 1;

        const foreign = await asTenant(acme.tenantId, async (trx) => {
          const result = await sql<{ count: string }>`
            select count(*) as count from aliquot.${sql.raw(`"${table}"`)}
             where tenant_id <> ${acme.tenantId}::uuid
          `.execute(trx);
          return Number(result.rows[0]?.count ?? '0');
        });

        if (foreign !== 0) leaking.push(`${table} (${foreign} foreign rows visible)`);
      }

      expect(leaking).toEqual([]);
      expect(readable).toBeGreaterThan(10);
    });

    it('leaves no tenant-scoped table both readable and unprotected', async () => {
      // The complement of the check above. Without this, a table could be made
      // to pass by revoking SELECT and nobody would notice it had lost its
      // policy.
      const tables = await tenantScopedTables();
      const unprotected: string[] = [];

      for (const table of tables) {
        const forced = await rlsForced(table);
        const readable = await appRoleCanSelect(table);
        if (readable && !forced) unprotected.push(table);
      }

      expect(unprotected).toEqual([]);
    });

    it('sees its own rows, so the previous assertion is not vacuous', async () => {
      // A policy of `USING (false)` would pass every leak check and break the
      // product. This is the guard against testing nothing.
      const visible = await asTenant(acme.tenantId, async (trx) => {
        const result = await sql<{
          count: string;
        }>`select count(*) as count from aliquot.run`.execute(trx);
        return Number(result.rows[0]?.count ?? '0');
      });

      expect(visible).toBe(1);
    });
  });

  describe('deny by default', () => {
    it('returns zero rows when app.tenant_id was never set', async () => {
      // current_tenant_id() returns NULL when the setting is absent, and
      // `tenant_id = NULL` is NULL, which RLS treats as false. A request that
      // forgets to set the tenant must see nothing rather than everything.
      const visible = await asTenant(null, async (trx) => {
        const result = await sql<{
          count: string;
        }>`select count(*) as count from aliquot.run`.execute(trx);
        return Number(result.rows[0]?.count ?? '0');
      });

      expect(visible).toBe(0);
    });

    it('returns zero rows when app.tenant_id is set to an unknown tenant', async () => {
      const visible = await asTenant('00000000-0000-7000-8000-000000000000', async (trx) => {
        const result = await sql<{
          count: string;
        }>`select count(*) as count from aliquot.study`.execute(trx);
        return Number(result.rows[0]?.count ?? '0');
      });

      expect(visible).toBe(0);
    });
  });

  describe('writes', () => {
    it('refuses an insert carrying another tenant id', async () => {
      // The WITH CHECK half of the policy. Without it a caller could read only
      // its own rows but write into anybody's.
      await expect(
        asTenant(acme.tenantId, async (trx) => {
          await trx
            .insertInto('aliquot.study')
            .values({
              id: '00000000-0000-7000-8000-00000000dead',
              tenant_id: umbrella.tenantId,
              slug: 'smuggled',
              title: 'should not exist',
            })
            .execute();
        }),
      ).rejects.toThrow(/row-level security/i);
    });

    it('cannot update another tenant row even by primary key', async () => {
      const target = await adminDb()
        .selectFrom('aliquot.study')
        .select('id')
        .where('tenant_id', '=', umbrella.tenantId)
        .executeTakeFirstOrThrow();

      const updated = await asTenant(acme.tenantId, async (trx) => {
        const result = await trx
          .updateTable('aliquot.study')
          .set({ title: 'renamed by a competitor' })
          .where('id', '=', target.id)
          .executeTakeFirst();
        return Number(result.numUpdatedRows);
      });

      // Zero rows updated rather than an error: the row is simply not visible,
      // which is also why a caller cannot use the response to probe for the
      // existence of another tenant's identifiers.
      expect(updated).toBe(0);

      const after = await adminDb()
        .selectFrom('aliquot.study')
        .select('title')
        .where('id', '=', target.id)
        .executeTakeFirstOrThrow();
      expect(after.title).not.toBe('renamed by a competitor');
    });
  });

  describe('the role the service actually connects as', () => {
    it('is not a superuser and does not have BYPASSRLS', async () => {
      // If this ever became false, every test above would still pass and
      // isolation would be gone. The service asserts the same thing at startup
      // and refuses to boot.
      const result = await sql<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolinherit: boolean;
      }>`
        select rolsuper, rolbypassrls, rolinherit
          from pg_roles where rolname = current_user
      `.execute(appDb());

      const role = result.rows[0];
      expect(role?.rolsuper).toBe(false);
      expect(role?.rolbypassrls).toBe(false);
      // NOINHERIT: the login role holds no table privileges of its own, so
      // forgetting SET LOCAL ROLE fails loudly instead of running with the
      // union of everything it is a member of.
      expect(role?.rolinherit).toBe(false);
    });

    it('has no table privileges before SET LOCAL ROLE', async () => {
      await expect(
        appDb()
          .transaction()
          .execute(async (trx) => {
            await sql`select 1 from aliquot.run limit 1`.execute(trx);
          }),
      ).rejects.toThrow(/permission denied/i);
    });

    it('cannot update or delete audit events', async () => {
      const grants = await sql<{ can_update: boolean; can_delete: boolean }>`
        select has_table_privilege('aliquot_app', 'aliquot.audit_event', 'UPDATE') as can_update,
               has_table_privilege('aliquot_app', 'aliquot.audit_event', 'DELETE') as can_delete
      `.execute(adminDb());

      expect(grants.rows[0]?.can_update).toBe(false);
      expect(grants.rows[0]?.can_delete).toBe(false);
    });

    it('cannot read or move the audit chain head', async () => {
      // The head is reachable only through append_audit_event(). Direct write
      // access would let the application rewind the chain and re-append over
      // the top of it, which defeats the entire mechanism.
      const grants = await sql<{ can_select: boolean; can_update: boolean }>`
        select has_table_privilege('aliquot_app', 'aliquot.audit_chain_head', 'SELECT') as can_select,
               has_table_privilege('aliquot_app', 'aliquot.audit_chain_head', 'UPDATE') as can_update
      `.execute(adminDb());

      expect(grants.rows[0]?.can_select).toBe(false);
      expect(grants.rows[0]?.can_update).toBe(false);
    });
  });

  describe('row-level security configuration', () => {
    it('is enabled AND forced wherever the application can read', async () => {
      // ENABLE alone leaves the table owner exempt, and migrations run as the
      // owner. FORCE is the half that is easy to omit and has no other symptom.
      const tables = await tenantScopedTables();
      const misconfigured: string[] = [];

      for (const table of tables) {
        if (!(await appRoleCanSelect(table))) continue;
        if (!(await rlsForced(table))) misconfigured.push(table);
      }

      expect(misconfigured).toEqual([]);
    });

    it('grants the application nothing at all on the chain head', async () => {
      // The one tenant-scoped table with no policy. Its protection is the
      // absence of every privilege, so that is what gets asserted.
      const result = await sql<{ privilege: string }>`
        select privilege
          from unnest(array['SELECT','INSERT','UPDATE','DELETE']) as privilege
         where has_table_privilege('aliquot_app', 'aliquot.audit_chain_head', privilege)
      `.execute(adminDb());

      expect(result.rows.map((row) => row.privilege)).toEqual([]);
    });

    it('declares every view with security_invoker', async () => {
      // A view over an RLS-protected table runs as its owner unless told
      // otherwise, which evaluates the policies against the wrong role. This is
      // the single easiest way to undo everything above.
      const result = await sql<{ viewname: string; options: string[] | null }>`
        select c.relname as viewname, c.reloptions as options
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'aliquot' and c.relkind = 'v'
      `.execute(adminDb());

      expect(result.rows.length).toBeGreaterThan(0);

      const leaky = result.rows
        .filter((row) => !(row.options ?? []).includes('security_invoker=true'))
        .map((row) => row.viewname);

      expect(leaky).toEqual([]);
    });
  });

  describe('the worker role', () => {
    it('sees the job queue across tenants, because claiming precedes knowing the tenant', async () => {
      await adminDb()
        .insertInto('aliquot.job')
        .values([
          { id: crypto.randomUUID(), tenant_id: acme.tenantId, queue: 'process.run' },
          { id: crypto.randomUUID(), tenant_id: umbrella.tenantId, queue: 'process.run' },
        ])
        .execute();

      const visible = await asTenant(
        acme.tenantId,
        async (trx) => {
          const result = await sql<{ count: string }>`
            select count(*) as count from aliquot.job where queue = 'process.run'
          `.execute(trx);
          return Number(result.rows[0]?.count ?? '0');
        },
        'aliquot_worker',
      );

      expect(visible).toBeGreaterThanOrEqual(2);
    });

    it('is still tenant-scoped on domain tables', async () => {
      // The cross-tenant privilege is bounded to the one table where it is
      // structurally unavoidable. Everywhere else the worker is scoped exactly
      // like the API.
      const foreign = await asTenant(
        acme.tenantId,
        async (trx) => {
          const result = await sql<{ count: string }>`
            select count(*) as count from aliquot.run where tenant_id <> ${acme.tenantId}::uuid
          `.execute(trx);
          return Number(result.rows[0]?.count ?? '0');
        },
        'aliquot_worker',
      );

      expect(foreign).toBe(0);
    });

    it('sees no jobs at all without a tenant set on the API role', async () => {
      const visible = await asTenant(null, async (trx) => {
        const result = await sql<{
          count: string;
        }>`select count(*) as count from aliquot.job`.execute(trx);
        return Number(result.rows[0]?.count ?? '0');
      });

      expect(visible).toBe(0);
    });
  });
});

/**
 * Whether the application role holds SELECT on a table. Used to partition
 * tenant-scoped tables into "protected by policy" and "protected by having no
 * grant at all", both of which are acceptable and neither of which may be
 * silently absent.
 */
async function appRoleCanSelect(table: string): Promise<boolean> {
  const result = await sql<{ allowed: boolean }>`
    select has_table_privilege('aliquot_app', ${`aliquot.${table}`}, 'SELECT') as allowed
  `.execute(adminDb());
  return result.rows[0]?.allowed === true;
}

async function rlsForced(table: string): Promise<boolean> {
  const result = await sql<{ enabled: boolean; forced: boolean; policies: string }>`
    select c.relrowsecurity as enabled,
           c.relforcerowsecurity as forced,
           (select count(*) from pg_policy p where p.polrelid = c.oid)::text as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'aliquot' and c.relname = ${table}
  `.execute(adminDb());

  const row = result.rows[0];
  return row?.enabled === true && row.forced === true && Number(row.policies) > 0;
}
