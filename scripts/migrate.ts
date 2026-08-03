/**
 * Forward-only migration runner.
 *
 * Written rather than adopted, and the reason is narrow: this project needs
 * exactly three behaviours from a migration tool -- apply `.sql` files in order,
 * one transaction each, and refuse to run if a file that was already applied has
 * been edited. That last one is the whole point. A migration that has run
 * somewhere is history; editing it produces two databases that both believe they
 * are at version 7 and are not the same shape, and no amount of care downstream
 * recovers from that. Every tool that offers this also offers a dozen features
 * this repository would never use, and each of those is a thing a reviewer has
 * to learn before they can trust `docker compose up`.
 *
 * Also handles role bootstrap, which is genuinely awkward to express as a
 * migration: the login role needs a password from the environment, and secrets
 * do not belong in a file that gets committed and checksummed.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Client } from 'pg';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

interface Migration {
  filename: string;
  version: string;
  sql: string;
  checksum: string;
}

async function loadMigrations(): Promise<Migration[]> {
  const entries = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();

  const migrations: Migration[] = [];
  for (const filename of entries) {
    const version = filename.split('_')[0];
    if (!version || !/^\d{4}$/.test(version)) {
      throw new Error(`migration ${filename} must start with a four-digit version`);
    }
    const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
    migrations.push({
      filename,
      version,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }

  const versions = new Set(migrations.map((m) => m.version));
  if (versions.size !== migrations.length) {
    throw new Error('duplicate migration version numbers');
  }

  return migrations;
}

async function ensureLedger(client: Client): Promise<void> {
  // Deliberately outside the aliquot schema: the ledger has to exist before the
  // schema does, and it survives independently of it.
  await client.query(`
    create table if not exists public.schema_migration (
      version     text primary key,
      filename    text not null,
      checksum    text not null,
      applied_at  timestamptz not null default clock_timestamp(),
      duration_ms integer not null
    )
  `);
}

async function applyMigrations(client: Client): Promise<void> {
  const migrations = await loadMigrations();
  const applied = new Map<string, { checksum: string; filename: string }>(
    (
      await client.query<{ version: string; checksum: string; filename: string }>(
        'select version, checksum, filename from public.schema_migration',
      )
    ).rows.map((row) => [row.version, { checksum: row.checksum, filename: row.filename }]),
  );

  // Check every already-applied migration before running anything. Failing
  // halfway through because file 3 was edited would leave the database in a
  // state neither version describes.
  const drifted: string[] = [];
  for (const migration of migrations) {
    const record = applied.get(migration.version);
    if (record && record.checksum !== migration.checksum) {
      drifted.push(migration.filename);
    }
  }
  if (drifted.length > 0) {
    throw new Error(
      `these migrations have already been applied and have since been edited: ${drifted.join(', ')}. ` +
        'Migrations are forward-only. Correct a mistake with a new migration, the same way a ' +
        'sealed run is corrected by a superseding run.',
    );
  }

  const pending = migrations.filter((m) => !applied.has(m.version));
  if (pending.length === 0) {
    console.log(`schema is up to date (${migrations.length} migrations applied)`);
    return;
  }

  for (const migration of pending) {
    const startedAt = Date.now();
    // Each migration is one transaction. PostgreSQL has transactional DDL, so a
    // migration that fails partway leaves no trace -- which is the property that
    // makes a half-applied migration something you do not have to reason about.
    await client.query('begin');
    try {
      await client.query(migration.sql);
      await client.query(
        `insert into public.schema_migration (version, filename, checksum, duration_ms)
         values ($1, $2, $3, $4)`,
        [migration.version, migration.filename, migration.checksum, Date.now() - startedAt],
      );
      await client.query('commit');
      console.log(`applied ${migration.filename} (${Date.now() - startedAt}ms)`);
    } catch (error) {
      await client.query('rollback');
      throw new Error(
        `migration ${migration.filename} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Create the unprivileged login role the application connects as.
 *
 * `aliquot_app` and `aliquot_worker` are NOLOGIN group roles created by
 * migration 0001; they hold the table privileges. This role holds none of its
 * own and is NOINHERIT, so it must `SET LOCAL ROLE` into one of them to do
 * anything at all. Forgetting to is not a subtle privilege escalation, it is an
 * immediate permission denied -- which is the failure mode you want.
 */
async function bootstrapLoginRole(
  client: Client,
  username: string,
  password: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(username)) {
    throw new Error(`invalid login role name: ${username}`);
  }

  assertUrlSafePassword(password);

  // CREATE ROLE is utility SQL: it does not accept bind parameters, so the
  // password has to be inlined as a literal. Escaping it by hand is exactly the
  // kind of thing that goes wrong quietly, so it is done in one place, and the
  // value is checked first -- a password that would need escaping beyond
  // doubling quotes is rejected rather than mangled.
  const exists = await client.query('select 1 from pg_roles where rolname = $1', [username]);
  const attributes = 'login noinherit nobypassrls nosuperuser nocreatedb nocreaterole';

  if (exists.rowCount === 0) {
    await client.query(
      `create role ${quote(username)} ${attributes} password ${literal(password)}`,
    );
    console.log(`created login role ${username}`);
  } else {
    await client.query(
      `alter role ${quote(username)} with ${attributes} password ${literal(password)}`,
    );
  }

  await client.query(`grant aliquot_app, aliquot_worker to ${quote(username)}`);
  await client.query(
    `grant connect on database ${quote(client.database ?? 'aliquot')} to ${quote(username)}`,
  );
  await client.query(`grant usage on schema aliquot to ${quote(username)}`);
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * The login password is written into a SQL literal here, but it is ALSO
 * interpolated into `DATABASE_URL` as `postgres://user:password@host/db` by the
 * deployment. That second use is the constraint: in a URL, the userinfo section
 * ends at the first `/`, so a password containing one silently truncates the
 * authority and the driver reports `TypeError: Invalid URL` from deep inside
 * connection setup, naming neither the password nor the variable.
 *
 * This bit: `openssl rand -base64 24` was the documented way to generate it, and
 * base64's alphabet includes `+`, `/` and `=`. Roughly a third of generated
 * passwords broke the deployment, and which third was luck -- the migration
 * would succeed and the API would crash-loop minutes later.
 *
 * Rejected rather than URL-encoded, for the same reason backslashes are rejected
 * above: a value that is silently transformed between where it is set and where
 * it is used produces an authentication failure nobody can explain. Hex is the
 * documented generator now, and this is the guard that makes that not merely
 * advice.
 */
function assertUrlSafePassword(password: string): void {
  const offending = [...new Set(password.match(/[^A-Za-z0-9._~-]/g) ?? [])];
  if (offending.length > 0) {
    throw new Error(
      `APP_DB_PASSWORD contains characters that are unsafe inside a URL: ${offending.join(' ')}\n` +
        'It is interpolated into DATABASE_URL as postgres://user:password@host/db, where\n' +
        "a '/' ends the authority section and the driver fails with 'Invalid URL'.\n" +
        'Generate one with: openssl rand -hex 32',
    );
  }
}

/**
 * A single-quoted SQL string literal.
 *
 * Backslashes are rejected rather than escaped: their meaning depends on
 * `standard_conforming_strings`, which is a server setting this script does not
 * control, and a password that is silently interpreted differently from what
 * was configured produces an authentication failure nobody can explain.
 */
function literal(value: string): string {
  if (value.includes('\\') || value.includes('\0')) {
    throw new Error('APP_DB_PASSWORD must not contain backslashes or null bytes');
  }
  return `'${value.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    throw new Error('DATABASE_ADMIN_URL is required (the owner/superuser connection)');
  }

  const client = new Client({ connectionString: adminUrl });
  await client.connect();

  try {
    await ensureLedger(client);
    await applyMigrations(client);

    const appUser = process.env.APP_DB_USER;
    const appPassword = process.env.APP_DB_PASSWORD;
    if (appUser && appPassword) {
      await bootstrapLoginRole(client, appUser, appPassword);
    } else {
      console.log('APP_DB_USER/APP_DB_PASSWORD not set; skipping login role bootstrap');
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
