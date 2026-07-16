import { Controller, Get } from '@nestjs/common';

import { AliquotError } from '../common/problem-details';
import { DatabaseService } from '../database/database.service';
import { Logger } from '../observability/logger';
import { ObjectStore } from '../storage/object-store';

/**
 * Liveness and readiness, kept apart on purpose.
 *
 * Conflating them is the classic outage amplifier: if liveness checked the
 * database, a database blip would fail every pod's liveness probe, the
 * orchestrator would kill every pod, and the restarts would neither fix the
 * database nor preserve the work that was in flight. Liveness answers one
 * question -- is this process still able to serve a request at all -- and it
 * answers it without talking to anything.
 *
 * Neither endpoint is tenant-scoped and neither returns tenant data, so both are
 * expected to be exempt from the authentication guard.
 */

const NOT_READY_TYPE = 'https://aliquot.dev/problems/not-ready';

/**
 * A probe that hangs is worse than a probe that fails: the orchestrator cannot
 * distinguish "slow" from "wedged" if the request simply never returns, so it
 * keeps routing traffic at a process that cannot serve it.
 */
const READINESS_BUDGET_MS = 2_000;

type CheckState = 'ok' | 'failed';

interface ReadinessChecks {
  database: CheckState;
  objectStore: CheckState;
}

export class NotReadyError extends AliquotError {
  constructor(checks: ReadinessChecks, failed: string[]) {
    super(NOT_READY_TYPE, 503, 'Not ready', `Dependencies unavailable: ${failed.join(', ')}.`, {
      checks,
      failed,
    });
  }
}

@Controller()
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly objectStore: ObjectStore,
    private readonly logger: Logger,
  ) {}

  @Get('healthz')
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /**
   * Readiness covers the object store as well as the database.
   *
   * Ingestion is a two-phase promise: registering a run tells an instrument that
   * this service will accept its bytes, and that promise is redeemed against the
   * object store minutes or hours later. A process that accepts registrations it
   * cannot fulfil converts an object store outage into a set of half-ingested
   * runs that somebody has to reconcile by hand. Refusing traffic while the
   * store is unreachable leaves the instrument holding its data, which is the
   * one place it is still safe.
   */
  @Get('readyz')
  async ready(): Promise<{ status: 'ready'; checks: ReadinessChecks }> {
    const [database, objectStore] = await Promise.all([
      this.check('database', () => this.database.healthCheck()),
      this.check('objectStore', async () => {
        if (!(await this.objectStore.isReachable())) {
          throw new Error('object store reported itself unreachable');
        }
      }),
    ]);

    const checks: ReadinessChecks = { database: state(database), objectStore: state(objectStore) };
    const failed = [database, objectStore].filter((result) => !result.ok).map((r) => r.name);

    if (failed.length > 0) {
      throw new NotReadyError(checks, failed);
    }

    return { status: 'ready', checks };
  }

  private async check(
    name: string,
    probe: () => Promise<void>,
  ): Promise<{ name: string; ok: boolean }> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        probe(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${name} did not respond within ${READINESS_BUDGET_MS}ms`)),
            READINESS_BUDGET_MS,
          );
        }),
      ]);
      return { name, ok: true };
    } catch (error) {
      // The reason stays in the log rather than in the response body: a
      // connection error quotes a host, a port and sometimes a user name, and
      // the readiness endpoint is served on the same socket as everything else.
      this.logger.warn('readiness check failed', {
        check: name,
        error: error instanceof Error ? error.message : String(error),
      });
      return { name, ok: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function state(result: { ok: boolean }): CheckState {
  return result.ok ? 'ok' : 'failed';
}
