import { AppConfig } from '../../../src/config/config';
import { DatabaseService } from '../../../src/database/database.service';
import type { RequestContext } from '../../../src/database/request-context';
import { Logger } from '../../../src/observability/logger';

/**
 * Minimal wiring for suites that exercise a service directly rather than
 * through HTTP.
 *
 * Deliberately not the full Nest container: booting the application to test the
 * chain verifier would couple an audit test to every unrelated module's
 * constructor, and a broken storage adapter would then fail the audit suite for
 * reasons that have nothing to do with the audit chain.
 */

let config: AppConfig | undefined;
let database: DatabaseService | undefined;

export function testConfig(): AppConfig {
  config ??= new AppConfig(process.env);
  return config;
}

export async function testDatabase(): Promise<DatabaseService> {
  if (!database) {
    database = new DatabaseService(testConfig(), new Logger({ level: 'error' }));
    // The same least-privilege assertion the service makes at startup. Running
    // it here means a suite fails loudly if the harness ever hands the tests a
    // privileged connection, rather than silently testing a database where
    // row-level security does not apply.
    await database.onModuleInit();
  }
  return database;
}

export async function closeServices(): Promise<void> {
  await database?.onModuleDestroy();
  database = undefined;
}

export function contextFor(
  tenantId: string,
  overrides: Partial<RequestContext> = {},
): RequestContext {
  return {
    tenantId,
    actorType: 'user',
    actorId: null,
    actorLabel: 'integration test',
    correlationId: 'test-correlation',
    dbRole: 'aliquot_app',
    ...overrides,
  };
}
