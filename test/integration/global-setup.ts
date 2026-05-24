import { join } from 'node:path';

import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * One PostgreSQL and one MinIO, started once for the whole integration run.
 *
 * Per-file containers would give perfect isolation and would also add roughly
 * three seconds to every suite, which in practice means the suite stops being
 * run. Sharing them is the right trade because the tests isolate by creating
 * their own tenants rather than by emptying the database -- which is also a
 * better model of production, where the database is never empty and a query
 * that only works against one tenant's data is exactly the bug we care about.
 *
 * The connection details are handed to the test processes through environment
 * variables rather than a module export, because Vitest's globalSetup runs in a
 * separate process from the tests themselves.
 */

let postgres: StartedPostgreSqlContainer | undefined;
let minio: StartedTestContainer | undefined;

const MINIO_ROOT_USER = 'aliquot';
const MINIO_ROOT_PASSWORD = 'aliquot-test-secret';
const APP_DB_USER = 'aliquot_login';
const APP_DB_PASSWORD = 'aliquot-test-secret';

export async function setup(): Promise<void> {
  const started = Date.now();

  [postgres, minio] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('aliquot')
      .withUsername('postgres')
      .withPassword('postgres')
      // The tests are throwaway and the container never restarts, so durability
      // buys nothing and costs a fsync on every commit. This is the single
      // largest win available on a write-heavy suite.
      .withCommand(['postgres', '-c', 'fsync=off', '-c', 'full_page_writes=off'])
      .start(),
    new GenericContainer('minio/minio:RELEASE.2025-04-22T22-12-26Z')
      .withExposedPorts(9000)
      .withEnvironment({
        MINIO_ROOT_USER,
        MINIO_ROOT_PASSWORD,
      })
      .withCommand(['server', '/data'])
      .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000).forStatusCode(200))
      .start(),
  ]);

  const adminUrl = postgres.getConnectionUri();

  process.env.DATABASE_ADMIN_URL = adminUrl;
  process.env.APP_DB_USER = APP_DB_USER;
  process.env.APP_DB_PASSWORD = APP_DB_PASSWORD;

  // The migration runner is the thing under test as much as the schema is. If
  // the suite applied SQL some other way, a broken runner would still show a
  // green build, and `docker compose up` -- which uses the runner -- would fail
  // for a reviewer on the very first command.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  await run(process.execPath, [require.resolve('tsx/cli'), 'scripts/migrate.ts'], {
    cwd: join(__dirname, '..', '..'),
    env: {
      ...process.env,
      DATABASE_ADMIN_URL: adminUrl,
      APP_DB_USER,
      APP_DB_PASSWORD,
    },
  });

  const host = postgres.getHost();
  const port = postgres.getMappedPort(5432);

  process.env.DATABASE_URL = `postgres://${APP_DB_USER}:${APP_DB_PASSWORD}@${host}:${port}/aliquot`;
  process.env.STORAGE_ENDPOINT = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
  process.env.STORAGE_BUCKET = 'aliquot-test';
  process.env.STORAGE_ACCESS_KEY_ID = MINIO_ROOT_USER;
  process.env.STORAGE_SECRET_ACCESS_KEY = MINIO_ROOT_PASSWORD;
  process.env.STORAGE_FORCE_PATH_STYLE = 'true';
  // Small parts so a multipart upload in a test is genuinely multipart without
  // moving hundreds of megabytes. 5 MiB is S3's floor for a non-final part.
  process.env.STORAGE_PART_SIZE_BYTES = String(5 * 1024 * 1024);
  process.env.AUTH_JWT_SECRET = 'integration-test-secret-integration-test-secret';
  process.env.AUTH_DEV_TOKEN_ENDPOINT = 'true';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';

  console.log(`integration dependencies ready in ${Date.now() - started}ms`);
}

export async function teardown(): Promise<void> {
  await Promise.allSettled([postgres?.stop(), minio?.stop()]);
}
