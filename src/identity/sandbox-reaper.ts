import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { uuidv4 } from '../common/uuid';
import { AppConfig } from '../config/config';
import { DatabaseService } from '../database/database.service';
import { systemContext } from '../database/request-context';
import { Logger } from '../observability/logger';
import { ObjectStore } from '../storage/object-store';

/**
 * Deletes sandbox tenants that have run out of time, and the objects nobody else
 * is pointing at.
 *
 * ## Where this runs, and why not in the API
 *
 * The worker process, started explicitly by `src/worker.ts` in the same way
 * `WorkerRuntime` is, and for the same reason: `IdentityModule` is imported by
 * both processes, so an `onApplicationBootstrap` here would turn every API
 * replica into a reaper. Several reapers would not corrupt anything -- the
 * function takes `FOR UPDATE` on the tenant row and the loser finds nothing --
 * but they would spend a connection each doing work that is already being done,
 * and the API is the tier that gets scaled.
 *
 * ## Ordering, and which way the failures fall
 *
 * Rows first, objects afterwards, in that order and in separate transactions.
 * The alternative -- delete the objects, then the rows -- fails by leaving an
 * artifact row that says VERIFIED behind a key that 404s, which is a lie the
 * system tells about its own integrity. This order fails by leaving bytes in a
 * bucket that nothing references, which costs storage and tells no lies. When
 * one of the two has to be interruptible, it should be the harmless one.
 *
 * ## Why nothing is audited
 *
 * A reap is not recorded in the audit chain, because the only chain it could be
 * recorded in is the one being deleted. There is no tenant-independent
 * operations chain in this schema and inventing one to hold a single event type
 * would be a larger decision than this warrants. The log line below is
 * therefore the whole record, and it carries the counts precisely so that "how
 * much did the sandbox tenants delete last night" is answerable from it.
 */

/**
 * Tenants per sweep.
 *
 * A cap rather than "all of them" so that a reaper starting against a backlog --
 * the interval was raised, the worker was down for a day -- does the work in
 * bounded transactions instead of one enormous one that blocks vacuum and takes
 * a lock nobody expected. The next sweep is one interval away.
 */
const BATCH = 20;

/** Ceiling on the backoff applied after a failed sweep, so a long outage still polls. */
const MAX_BACKOFF_MS = 300_000;

interface ExpiredTenant {
  id: string;
  slug: string;
}

interface ReapCounts {
  runs: string;
  artifacts: string;
  audit_events: string;
}

@Injectable()
export class SandboxReaper {
  private running = false;
  private wake: (() => void) | null = null;
  private consecutiveFailures = 0;

  constructor(
    private readonly database: DatabaseService,
    private readonly store: ObjectStore,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  /** Poll until `stop()` is called, then resolve. */
  async run(): Promise<void> {
    if (this.running) {
      throw new Error('the sandbox reaper is already running');
    }

    this.running = true;
    this.logger.info('sandbox reaper started', {
      intervalMs: this.config.sandbox.reapIntervalMs,
      ttlMinutes: this.config.sandbox.ttlMinutes,
    });

    while (this.running) {
      try {
        await this.sweep();
        this.consecutiveFailures = 0;
      } catch (error) {
        // Swallowed on purpose. A sweep that fails has deleted nothing it should
        // not have -- every step is its own transaction -- and the tenants it
        // did not reach are still expired, so the next sweep finds them. Letting
        // this escape would stop the loop for the life of the process.
        this.consecutiveFailures += 1;
        this.logger.error('sandbox sweep failed', {
          error: describeError(error),
          consecutiveFailures: this.consecutiveFailures,
        });
      }

      if (!this.running) break;
      await this.sleep(this.delayMs());
    }

    this.logger.info('sandbox reaper stopped');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
  }

  /** One pass. Returns the number of tenants reaped, for tests and for logs. */
  async sweep(): Promise<number> {
    const expired = await this.database.withoutTenantScope('aliquot_worker', async (trx) => {
      // `aliquot.tenant` is the one table with no row-level security policy --
      // it is what the policies resolve against (migration 0002) -- so this reads
      // across tenants without needing a privilege the worker should not have.
      // `tenant_sandbox_expiry_idx` is partial on `kind = 'sandbox'`, so the
      // scan never touches a permanent tenant.
      const result = await sql<ExpiredTenant>`
        select id, slug
          from aliquot.tenant
         where kind = 'sandbox'
           and expires_at <= clock_timestamp()
         order by expires_at
         limit ${BATCH}
      `.execute(trx);

      return result.rows;
    });

    // Each tenant is its own pair of transactions, so a sweep interrupted by a
    // shutdown or a failure leaves nothing half-done: the tenants it did not
    // reach are still expired and the next sweep -- in this process or another
    // -- finds them.
    for (const tenant of expired) {
      await this.reap(tenant);
    }

    return expired.length;
  }

  private async reap(tenant: ExpiredTenant): Promise<void> {
    const correlationId = `sandbox-reaper/${uuidv4()}`;
    const log = this.logger.child({ tenantId: tenant.id, tenantSlug: tenant.slug, correlationId });

    const ctx = systemContext(tenant.id, correlationId, {
      label: 'sandbox-reaper',
      dbRole: 'aliquot_worker',
    });

    const { keys, counts } = await this.database.withTenant(ctx, async (trx) => {
      // Read before the delete, under this tenant's own row-level security --
      // there is nothing privileged about reading a tenant's artifacts once
      // `app.tenant_id` names it. Distinct because content addressing means one
      // key can back several rows.
      const artifacts = await sql<{ digest: string; storage_key: string }>`
        select distinct a.digest::text as digest, a.storage_key
          from aliquot.artifact a
         where a.tenant_id = ${tenant.id}::uuid
      `.execute(trx);

      // Everything, in foreign-key order, gated on kind = 'sandbox' inside the
      // function. See migration 0008: the constraint that makes this safe is not
      // the predicate below but the one in the function, which cannot be got
      // wrong from here.
      const reaped = await sql<ReapCounts>`
        select runs, artifacts, audit_events from aliquot.reap_sandbox_tenant(${tenant.id}::uuid)
      `.execute(trx);

      return { keys: artifacts.rows, counts: reaped.rows[0] };
    });

    const objectsDeleted = await this.deleteOrphanedObjects(tenant.id, keys, log);

    log.info('sandbox reaped', {
      runs: counts?.runs ?? '0',
      artifacts: counts?.artifacts ?? '0',
      auditEvents: counts?.audit_events ?? '0',
      objectsDeleted,
      objectsShared: keys.length - objectsDeleted,
    });
  }

  /**
   * Remove the objects this sandbox was the only holder of.
   *
   * Storage keys are derived from the digest alone and are therefore global,
   * while `artifact` rows are per tenant (ADR-0017). Two tenants that uploaded
   * identical bytes share one object, so walking this tenant's artifact rows and
   * deleting every key would delete bytes a permanent tenant is still pointing
   * at -- and that tenant's run would go on reporting itself VERIFIED with a
   * manifest that still digests correctly, while the download 404s. A verified
   * record with nothing behind it is the worst way this service could fail.
   *
   * So the digests are checked against every other tenant first, and the check
   * runs *after* the rows are gone rather than inside the transaction that
   * removed them. That is the deliberate part: at this point "referenced by
   * another tenant" and "referenced at all" are the same question, so a row
   * inserted concurrently by another tenant is already visible and its bytes are
   * spared. Checking before the delete would have left a window between the
   * answer and the action in which a fresh upload of the same content could land
   * -- and the cost of being wrong in that window is somebody else's data.
   */
  private async deleteOrphanedObjects(
    tenantId: string,
    keys: readonly { digest: string; storage_key: string }[],
    log: Logger,
  ): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }

    const digests = keys.map((key) => key.digest);
    const shared = await this.database.withoutTenantScope('aliquot_worker', async (trx) => {
      const result = await sql<{ digest: string }>`
        select d.digest
          from aliquot.digests_referenced_elsewhere(
            ${digests}::text[],
            ${tenantId}::uuid
          ) as d(digest)
      `.execute(trx);

      return new Set(result.rows.map((row) => row.digest));
    });

    let deleted = 0;
    for (const key of keys) {
      if (shared.has(key.digest)) continue;

      try {
        await this.store.deleteObject(key.storage_key);
        deleted += 1;
      } catch (error) {
        // Logged and stepped over. The rows are already gone, so retrying the
        // whole tenant is not available; what is left is an object nothing
        // references, which costs storage and misleads nobody. The key is in the
        // log so an operator can remove it by hand.
        log.warn('could not delete a sandbox object', {
          storageKey: key.storage_key,
          error: describeError(error),
        });
      }
    }

    return deleted;
  }

  private delayMs(): number {
    if (this.consecutiveFailures === 0) return this.config.sandbox.reapIntervalMs;
    const backoff = this.config.sandbox.reapIntervalMs * 2 ** Math.min(this.consecutiveFailures, 8);
    return Math.min(backoff, MAX_BACKOFF_MS);
  }

  /** Interruptible sleep: `stop()` wakes it so shutdown is not gated on the interval. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);

      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
