import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kysely, PostgresDialect, Transaction, sql } from 'kysely';
import { Pool, types } from 'pg';

import { AppConfig } from '../config/config';
import { Logger } from '../observability/logger';
import type { Database } from './schema';
import type { DatabaseRole, RequestContext } from './request-context';

/**
 * `bigint` and `numeric` arrive as strings.
 *
 * node-postgres parses int8 to a JavaScript number by default, which silently
 * loses precision above 2^53. Two columns here are genuinely at risk --
 * `size_bytes` on hundred-gigabyte artifacts is fine, but `seq` on the audit
 * chain is unbounded and a rounded sequence number would corrupt chain
 * verification in a way that looks like tampering. Strings everywhere, converted
 * deliberately at the point of use.
 */
types.setTypeParser(types.builtins.INT8, (value) => value);
types.setTypeParser(types.builtins.NUMERIC, (value) => value);

export type Trx = Transaction<Database>;

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  readonly db: Kysely<Database>;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.pool = new Pool({
      connectionString: config.database.url,
      max: config.database.poolSize,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: config.serviceRole,
    });

    this.pool.on('error', (error) => {
      // An idle client erroring is normal during a failover and must not take
      // the process down. In-flight work fails on its own transaction.
      this.logger.warn('idle database client error', { error: error.message });
    });

    this.db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: this.pool }),
      log: config.database.logQueries
        ? (event) => {
            if (event.level === 'query') {
              this.logger.debug('sql', {
                sql: event.query.sql,
                durationMs: Math.round(event.queryDurationMillis),
              });
            }
          }
        : undefined,
    });
  }

  async onModuleInit(): Promise<void> {
    await assertLeastPrivilege(this.db, this.config.database.role);
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }

  /**
   * Run work inside a transaction scoped to one tenant.
   *
   * Three things happen before the callback sees the transaction, and all three
   * matter:
   *
   *   SET LOCAL ROLE    the connection's login role holds no table privileges
   *                     of its own (NOINHERIT). Forgetting this does not
   *                     silently run with more access than intended -- it fails
   *                     immediately with a permission error.
   *
   *   set_config(...,true)  the `true` is SET LOCAL semantics: the setting is
   *                     reverted at COMMIT or ROLLBACK. A plain SET would
   *                     survive on a pooled connection and the next request on
   *                     that connection would inherit this tenant. That is the
   *                     precise bug row-level security exists to prevent, and
   *                     it would be introduced by the code enforcing it.
   *
   *   parameterised     `SET LOCAL x = $1` is not valid syntax, so the naive
   *                     workaround is string interpolation into DDL-ish SQL.
   *                     set_config() takes the value as an ordinary bind
   *                     parameter and closes that off.
   */
  async withTenant<T>(context: RequestContext, work: (trx: Trx) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await applySessionContext(trx, context);
      return work(trx);
    });
  }

  /**
   * Unscoped transaction for work that legitimately spans tenants: the worker's
   * claim loop, and the startup checkpoint sweep. Deliberately named to be
   * conspicuous in review -- there are exactly two callers and there should
   * never be a third without an argument for why.
   */
  async withoutTenantScope<T>(role: DatabaseRole, work: (trx: Trx) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`set local role ${sql.raw(quoteIdentifier(role))}`.execute(trx);
      return work(trx);
    });
  }

  async healthCheck(): Promise<void> {
    await sql`select 1`.execute(this.db);
  }
}

export async function applySessionContext(trx: Trx, context: RequestContext): Promise<void> {
  await sql`set local role ${sql.raw(quoteIdentifier(context.dbRole))}`.execute(trx);
  await sql`select
      set_config('app.tenant_id',  ${context.tenantId},        true),
      set_config('app.actor_id',   ${context.actorId ?? ''},   true),
      set_config('app.actor_type', ${context.actorType},       true)
  `.execute(trx);
}

/**
 * `SET ROLE` cannot be parameterised either. The role name never comes from
 * user input -- it is one of two compile-time literals -- but validating it
 * here means that stays true even if a future caller gets creative.
 */
function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`refusing to use ${JSON.stringify(identifier)} as a role name`);
  }
  return `"${identifier}"`;
}

/**
 * Startup assertion: the credentials we were handed are not privileged enough
 * to bypass the isolation layer.
 *
 * Without this check a deployment that accidentally points `DATABASE_URL` at a
 * superuser loses row-level security entirely, and absolutely nothing else
 * changes -- every request succeeds, every test passes, and the second layer of
 * defence is simply gone. Refusing to start is the only signal that is loud
 * enough.
 */
export async function assertLeastPrivilege(
  db: Kysely<Database>,
  expectedRole: DatabaseRole,
): Promise<void> {
  const result = await sql<{
    login_role: string;
    is_superuser: boolean;
    bypasses_rls: boolean;
    can_assume: boolean;
    assumed_bypasses_rls: boolean;
  }>`
    select current_user                                  as login_role,
           r.rolsuper                                    as is_superuser,
           r.rolbypassrls                                as bypasses_rls,
           pg_has_role(current_user, ${expectedRole}, 'MEMBER') as can_assume,
           t.rolbypassrls                                as assumed_bypasses_rls
      from pg_roles r
      join pg_roles t on t.rolname = ${expectedRole}
     where r.rolname = current_user
  `.execute(db);

  const row = result.rows[0];
  if (!row) {
    throw new Error('unable to determine the current database role');
  }

  const failures: string[] = [];
  if (row.is_superuser) failures.push(`${row.login_role} is a superuser`);
  if (row.bypasses_rls) failures.push(`${row.login_role} has BYPASSRLS`);
  if (row.assumed_bypasses_rls) failures.push(`${expectedRole} has BYPASSRLS`);
  if (!row.can_assume) failures.push(`${row.login_role} is not a member of ${expectedRole}`);

  if (failures.length > 0) {
    throw new Error(
      `refusing to start: row-level security would not be enforced (${failures.join('; ')}). ` +
        'Point DATABASE_URL at the unprivileged login role created by scripts/migrate.ts.',
    );
  }
}
