import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { AppConfig } from './config/config';
import { Logger } from './observability/logger';
import { WorkerRuntime } from './processing/worker.runtime';

/**
 * The worker entrypoint.
 *
 * A Nest application context, not an HTTP server: the worker has no routes and
 * binding a port it never serves would only invite a health check that means
 * nothing. It is the same image and the same composition root as the API --
 * `SERVICE_ROLE` decides which half runs -- so the code paths the worker
 * exercises are the ones the API was tested with, rather than a second assembly
 * of the same services that can drift.
 *
 * Shutdown is handled here rather than through Nest's shutdown hooks because the
 * order matters and it is short enough to read: stop claiming, let in-flight
 * jobs finish, then close the injector and with it the connection pool. Closing
 * the pool first would fail every job that was mid-transaction, which is exactly
 * the work a graceful shutdown is trying to protect.
 */

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

async function bootstrap(): Promise<void> {
  // The entrypoint decides the role; the environment may only agree with it.
  // `dist/worker.js` running as `aliquot_app` would fail on its first claim with
  // a permission error three layers down, so the default belongs here and the
  // disagreement is refused below.
  process.env.SERVICE_ROLE ??= 'worker';

  // abortOnError: a startup failure has to become a non-zero exit. Nest's
  // default logs and carries on, which leaves a container that is up, restarts
  // nothing, and processes no work.
  const context = await NestFactory.createApplicationContext(AppModule, { abortOnError: false });

  const config = context.get(AppConfig);
  if (config.serviceRole !== 'worker') {
    await context.close();
    throw new Error(
      `SERVICE_ROLE is "${config.serviceRole}"; the worker entrypoint must run as "worker". ` +
        'Only aliquot_worker holds the policy that allows a job to be claimed before its ' +
        'tenant is known.',
    );
  }

  const logger = context.get(Logger);
  const runtime = context.get(WorkerRuntime);

  let stopping = false;
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      if (stopping) {
        // A second signal is an operator saying they are no longer willing to
        // wait. In-flight jobs keep their leases and are redelivered once those
        // expire, so this is abrupt rather than destructive.
        logger.warn('second shutdown signal received; exiting without draining', { signal });
        process.exit(1);
      }

      stopping = true;
      logger.info('shutdown signal received', { signal });
      runtime.stop();
    });
  }

  // Resolves once the loop has stopped claiming and in-flight work has drained.
  await runtime.run();
  await context.close();
}

bootstrap().catch((error: unknown) => {
  // stderr, not the structured logger: this path covers failures that happen
  // before the injector exists, and a startup error written nowhere is a
  // container that restart-loops in silence.
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
