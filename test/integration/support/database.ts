import { randomBytes } from 'node:crypto';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool, types } from 'pg';

import { uuidv7 } from '../../../src/common/uuid';
import type { Database } from '../../../src/database/schema';

/**
 * Direct database access for suites that test the schema itself rather than the
 * API on top of it.
 *
 * Two connections are exposed on purpose:
 *
 *   appDb    the unprivileged login role the service actually uses. Subject to
 *            row-level security. This is the one under test.
 *
 *   adminDb  the database owner. Bypasses row-level security entirely because
 *            it is a superuser, which is exactly why it is needed: seeding
 *            fixtures across tenants, and simulating an insider with full
 *            privileges attempting to rewrite audited history.
 *
 * A suite that reaches for adminDb to make an assertion pass has usually
 * misunderstood what it is testing.
 */

types.setTypeParser(types.builtins.INT8, (value) => value);
types.setTypeParser(types.builtins.NUMERIC, (value) => value);

let appPool: Pool | undefined;
let adminPool: Pool | undefined;
let appDbInstance: Kysely<Database> | undefined;
let adminDbInstance: Kysely<Database> | undefined;

export function appDb(): Kysely<Database> {
  if (!appDbInstance) {
    appPool = new Pool({ connectionString: required('DATABASE_URL'), max: 8 });
    appDbInstance = new Kysely<Database>({ dialect: new PostgresDialect({ pool: appPool }) });
  }
  return appDbInstance;
}

export function adminDb(): Kysely<Database> {
  if (!adminDbInstance) {
    adminPool = new Pool({ connectionString: required('DATABASE_ADMIN_URL'), max: 4 });
    adminDbInstance = new Kysely<Database>({ dialect: new PostgresDialect({ pool: adminPool }) });
  }
  return adminDbInstance;
}

export async function closeDatabases(): Promise<void> {
  await Promise.allSettled([appDbInstance?.destroy(), adminDbInstance?.destroy()]);
  appDbInstance = undefined;
  adminDbInstance = undefined;
  appPool = undefined;
  adminPool = undefined;
}

export type DbRole = 'aliquot_app' | 'aliquot_worker';

/**
 * Run a callback as a tenant-scoped role, exactly as the service does.
 *
 * Passing `tenantId: null` deliberately omits the session variable, which is
 * how the deny-by-default behaviour of the policies gets exercised.
 */
export async function asTenant<T>(
  tenantId: string | null,
  work: (trx: Kysely<Database>) => Promise<T>,
  role: DbRole = 'aliquot_app',
): Promise<T> {
  return appDb()
    .transaction()
    .execute(async (trx) => {
      await sql`set local role ${sql.raw(`"${role}"`)}`.execute(trx);
      if (tenantId !== null) {
        await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      }
      return work(trx);
    });
}

export interface TenantFixture {
  tenantId: string;
  studyId: string;
  userId: string;
  instrumentId: string;
  slug: string;
}

/**
 * A complete, isolated tenant.
 *
 * Suites create their own rather than sharing a global fixture, because the
 * interesting failures here are cross-tenant ones and a suite that can only see
 * its own data cannot detect them. The database is never emptied between
 * suites, which is also a better model of production.
 */
export async function createTenant(label: string): Promise<TenantFixture> {
  const db = adminDb();
  const tenantId = uuidv7();
  const studyId = uuidv7();
  const userId = uuidv7();
  const instrumentId = uuidv7();
  const slug = `${label}-${tenantId.slice(0, 8)}`;

  await db.insertInto('aliquot.tenant').values({ id: tenantId, slug, name: label }).execute();

  await db
    .insertInto('aliquot.app_user')
    .values({
      id: userId,
      tenant_id: tenantId,
      email: `operator@${slug}.test`,
      display_name: `Operator (${label})`,
    })
    .execute();

  await db
    .insertInto('aliquot.study')
    .values({ id: studyId, tenant_id: tenantId, slug: `study-${slug}`, title: `Study ${label}` })
    .execute();

  await db
    .insertInto('aliquot.membership')
    .values({
      id: uuidv7(),
      tenant_id: tenantId,
      study_id: studyId,
      user_id: userId,
      role: 'admin',
    })
    .execute();

  await db
    .insertInto('aliquot.instrument')
    .values({
      id: instrumentId,
      tenant_id: tenantId,
      slug: `scope-${slug}`,
      display_name: `Scope (${label})`,
      api_key_hash: 'not-a-real-hash',
      // api_key_prefix is globally unique, not per-tenant, because an inbound
      // credential is located by prefix before its tenant is known. Deriving it
      // from the UUIDv7 would collide for fixtures created in the same
      // millisecond, so it needs real entropy here just as it does in
      // production.
      api_key_prefix: `aliq_${randomBytes(6).toString('base64url').slice(0, 7)}`,
    })
    .execute();

  await db
    .insertInto('aliquot.instrument_study_grant')
    .values({ tenant_id: tenantId, instrument_id: instrumentId, study_id: studyId })
    .execute();

  return { tenantId, studyId, userId, instrumentId, slug };
}

/** Insert a run directly, for suites testing schema behaviour below the API. */
export async function insertRun(
  fixture: TenantFixture,
  overrides: Partial<{
    id: string;
    state: 'OPEN' | 'SEALED' | 'QUARANTINED' | 'ABANDONED';
    manifestDigest: string;
    sealed: boolean;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? uuidv7();
  const state = overrides.state ?? 'OPEN';
  const sealedStates = new Set(['SEALED', 'PROCESSING', 'PROCESSED', 'PROCESSING_FAILED']);

  await adminDb()
    .insertInto('aliquot.run')
    .values({
      id,
      tenant_id: fixture.tenantId,
      study_id: fixture.studyId,
      instrument_id: fixture.instrumentId,
      operator_id: fixture.userId,
      state,
      manifest_digest: overrides.manifestDigest ?? 'd'.repeat(64),
      sealed_at: sealedStates.has(state) ? new Date() : null,
      quarantine_reason: state === 'QUARANTINED' ? 'test fixture' : null,
      abandoned_at: state === 'ABANDONED' ? new Date() : null,
    })
    .execute();

  return id;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set; integration globalSetup did not run`);
  }
  return value;
}

/**
 * Every table carrying a tenant_id, read from the catalogue rather than
 * hard-coded.
 *
 * The isolation suite iterates this, so a table added in a future migration is
 * covered the moment it exists. A hard-coded list would pass forever while
 * silently not testing the newest table -- which is the exact failure mode
 * row-level security has.
 */
export async function tenantScopedTables(): Promise<string[]> {
  const result = await sql<{ table_name: string }>`
    select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
     where n.nspname = 'aliquot'
       and c.relkind = 'r'
       and a.attname = 'tenant_id'
       and a.attnum > 0
       and not a.attisdropped
     order by c.relname
  `.execute(adminDb());

  return result.rows.map((row) => row.table_name);
}
