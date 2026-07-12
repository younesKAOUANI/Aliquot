import { Inject, Injectable } from '@nestjs/common';
import { hostname } from 'node:os';

import { uuidv4 } from '../common/uuid';
import { AppConfig } from '../config/config';
import { Logger } from '../observability/logger';
import type { ClaimedJob, JobHandler } from './job-queue';
import { PostgresJobQueue } from './postgres-job-queue';

/**
 * The worker's poll loop.
 *
 * It is started explicitly by `src/worker.ts` rather than from a Nest lifecycle
 * hook, and that is not an oversight: the API process imports the same module
 * for the enqueue side of the seam, and an `onApplicationBootstrap` here would
 * quietly turn every API instance into a worker as well.
 *
 * The loop is deliberately dull. Claiming is a single statement with `SKIP
 * LOCKED` so N workers need no coordination beyond the database; leases make a
 * dead worker's jobs reclaimable without anybody noticing it died; and the
 * failure of any individual job never leaves the loop -- it is released, backed
 * off by the database, and eventually dead-lettered with its reason attached.
 */

/** Injection token for the handlers this runtime polls for. */
export const JOB_HANDLERS = 'ALIQUOT_JOB_HANDLERS';

/**
 * How long a shutdown waits for work already in flight.
 *
 * Exceeding it is not a failure. The job keeps its lease, the process exits, the
 * lease expires and the next claim picks the job up with `attempts` already
 * incremented -- so an over-running job is redelivered rather than lost, and
 * every handler here is written to converge on redelivery.
 */
const SHUTDOWN_GRACE_MS = 30_000;

/** Ceiling on the backoff applied after a failed claim, so a long outage still polls. */
const MAX_CLAIM_BACKOFF_MS = 30_000;

@Injectable()
export class WorkerRuntime {
  /**
   * Recorded in `job.claimed_by` and in every log line.
   *
   * Host and pid alone are not unique -- two containers on one host, or a pid
   * reused after a restart -- and `claimed_by` is what fences a completion
   * against a lease that has been taken over. The random suffix makes a
   * restarted worker a different worker, which is what it is.
   */
  readonly workerId = `${hostname()}/${process.pid}/${uuidv4().slice(0, 8)}`;

  private running = false;
  private readonly inFlight = new Map<string, Promise<void>>();
  private wake: (() => void) | null = null;
  private consecutiveClaimFailures = 0;

  constructor(
    // The concrete queue, not the `JobQueue` abstraction: the abstraction covers
    // the producer side, which is where the transactional guarantee lives. A
    // broker would replace this loop entirely with its own delivery mechanism.
    private readonly queue: PostgresJobQueue,
    @Inject(JOB_HANDLERS) private readonly handlers: JobHandler[],
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Poll until `stop()` is called, then drain and resolve.
   *
   * Resolving means the process can exit: either every in-flight job finished or
   * the grace window elapsed and the rest will be redelivered.
   */
  async run(): Promise<void> {
    if (this.handlers.length === 0) {
      throw new Error('the worker has no job handlers registered; it would never claim anything');
    }
    if (this.running) {
      throw new Error('the worker runtime is already running');
    }

    this.running = true;
    this.logger.info('worker started', {
      workerId: this.workerId,
      queues: this.handlers.map((handler) => handler.queue),
      concurrency: this.config.worker.concurrency,
      pollIntervalMs: this.config.worker.pollIntervalMs,
      leaseSeconds: this.config.worker.leaseSeconds,
    });

    while (this.running) {
      const claimed = await this.pollOnce();
      if (!this.running) break;

      // Sleeping when nothing was claimed is the idle case; sleeping when the
      // slots are full is what stops a busy worker from spinning on a claim it
      // has no capacity to accept. A failed claim falls into the first case with
      // a backoff applied, so a database outage does not become a hot loop --
      // and a job that fails instantly cannot either, because release_job()
      // pushes its `run_after` past the point where the next claim would see it.
      if (claimed === 0 || this.inFlight.size >= this.config.worker.concurrency) {
        await this.sleep(this.pollDelayMs());
      }
    }

    await this.drain();
    this.logger.info('worker stopped', { workerId: this.workerId });
  }

  /**
   * Signal the loop to stop claiming.
   *
   * Returns immediately; the caller waits on the promise from `run()`, which
   * resolves once in-flight work has drained. Two channels for one shutdown
   * would be one more thing to get out of step.
   */
  stop(): void {
    if (!this.running) return;
    this.logger.info('worker shutting down', {
      workerId: this.workerId,
      inFlight: this.inFlight.size,
    });
    this.running = false;
    this.wake?.();
  }

  /** Claim across every registered queue, up to the remaining concurrency. */
  private async pollOnce(): Promise<number> {
    let claimed = 0;

    try {
      for (const handler of this.handlers) {
        if (!this.running) break;

        const capacity = this.config.worker.concurrency - this.inFlight.size;
        if (capacity <= 0) break;

        const jobs = await this.queue.claim(
          handler.queue,
          this.workerId,
          capacity,
          this.config.worker.leaseSeconds,
        );

        for (const job of jobs) this.dispatch(handler, job);
        claimed += jobs.length;
      }

      this.consecutiveClaimFailures = 0;
    } catch (error) {
      this.consecutiveClaimFailures += 1;
      this.logger.error('failed to claim jobs', {
        error: describeError(error),
        consecutiveFailures: this.consecutiveClaimFailures,
        workerId: this.workerId,
      });
      return 0;
    }

    return claimed;
  }

  private pollDelayMs(): number {
    if (this.consecutiveClaimFailures === 0) return this.config.worker.pollIntervalMs;
    const backoff =
      this.config.worker.pollIntervalMs * 2 ** Math.min(this.consecutiveClaimFailures, 10);
    return Math.min(backoff, MAX_CLAIM_BACKOFF_MS);
  }

  private dispatch(handler: JobHandler, job: ClaimedJob): void {
    const log = this.logger.child({
      jobId: job.id,
      queue: job.queue,
      tenantId: job.tenantId,
      // Restored from the payload so that these lines join the request that
      // caused the job. Without the hop, "why did this run never finish
      // processing" is two unrelated log streams.
      correlationId: job.correlationId,
      attempt: job.attempts,
      workerId: this.workerId,
    });

    // `execute` resolves for both success and failure, so this promise is never
    // rejected and never needs a handler attached to it.
    const task = this.execute(handler, job, log).finally(() => this.inFlight.delete(job.id));
    this.inFlight.set(job.id, task);
  }

  private async execute(handler: JobHandler, job: ClaimedJob, log: Logger): Promise<void> {
    const startedAt = Date.now();
    const renewal = this.startLeaseRenewal(job, log);

    try {
      await handler.handle(job);

      const acknowledged = await this.queue.complete(job.id, this.workerId);
      if (acknowledged) {
        log.info('job completed', { durationMs: Date.now() - startedAt });
      } else {
        log.warn('job finished after its lease was lost; the row belongs to another worker now', {
          durationMs: Date.now() - startedAt,
        });
      }
    } catch (error) {
      const message = describeError(error);
      log.error('job failed', {
        error: message,
        durationMs: Date.now() - startedAt,
        maxAttempts: job.maxAttempts,
      });
      await this.release(job, message, log);
    } finally {
      clearInterval(renewal);
    }
  }

  private async release(job: ClaimedJob, message: string, log: Logger): Promise<void> {
    try {
      const outcome = await this.queue.fail(job.id, this.workerId, message);

      if (outcome === null) {
        log.warn('failed job had already lost its lease; leaving it to its current owner');
      } else if (outcome.state === 'DEAD') {
        log.error('job exhausted its attempt budget and was dead-lettered', {
          attempts: outcome.attempts,
        });
      }
    } catch (error) {
      // Swallowed on purpose: there is nothing further this process can do, and
      // the outcome is reached anyway by a slower route -- the lease expires and
      // the same statement that claims new work reclaims this job with
      // `attempts` already incremented.
      log.error('could not release the failed job', { error: describeError(error) });
    }
  }

  /**
   * Keep the lease alive while a long job runs.
   *
   * At a third of the lease there are two renewals in hand before expiry, so a
   * single slow round trip does not hand the job to another worker. Losing it
   * anyway is survivable -- the work converges and completion is fenced on
   * `claimed_by` -- which is why this logs rather than aborts.
   */
  private startLeaseRenewal(job: ClaimedJob, log: Logger): NodeJS.Timeout {
    const intervalMs = Math.max(1_000, Math.floor((this.config.worker.leaseSeconds * 1000) / 3));

    const timer = setInterval(() => {
      void (async () => {
        try {
          const renewed = await this.queue.renewLease(
            job.id,
            this.workerId,
            this.config.worker.leaseSeconds,
          );
          if (!renewed) {
            log.warn('lease renewal matched no claim; this job may already be running elsewhere');
          }
        } catch (error) {
          log.warn('lease renewal failed', { error: describeError(error) });
        }
      })();
    }, intervalMs);

    // A renewal timer must never be the reason the process stays alive.
    timer.unref();
    return timer;
  }

  private async drain(): Promise<void> {
    const pending = [...this.inFlight.values()];
    if (pending.length === 0) return;

    this.logger.info('draining in-flight jobs', {
      count: pending.length,
      graceMs: SHUTDOWN_GRACE_MS,
    });

    await Promise.race([Promise.allSettled(pending), expire(SHUTDOWN_GRACE_MS)]);

    if (this.inFlight.size > 0) {
      this.logger.warn(
        'shutdown window elapsed with jobs still running; they will be redelivered',
        {
          inFlight: this.inFlight.size,
          leaseSeconds: this.config.worker.leaseSeconds,
        },
      );
    }
  }

  /** Interruptible sleep: `stop()` wakes it so shutdown is not gated on the poll interval. */
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

function expire(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
