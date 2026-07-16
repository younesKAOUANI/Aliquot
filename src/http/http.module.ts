import { Module, RequestMethod } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { CorrelationMiddleware } from './correlation';
import { HealthController } from './health.controller';
import { ProblemDetailsFilter } from './problem-details.filter';

/**
 * HTTP cross-cutting concerns: correlation, error rendering, probes.
 *
 * The filter is bound through `APP_FILTER` rather than
 * `app.useGlobalFilters(...)` in the bootstrap because the latter constructs the
 * filter outside the injector, and a filter that cannot be given the `Logger` is
 * a filter that swallows the only record of an unexpected error.
 *
 * `DatabaseService` and `ObjectStore` are not provided here. They are process
 * singletons -- one connection pool, one S3 client -- and re-providing them in a
 * feature module would quietly create a second of each; the root composition
 * owns them.
 */
@Module({
  controllers: [HealthController],
  providers: [CorrelationMiddleware, { provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class HttpModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route, including the probes: an unattributable log line is not much
    // use, and the correlation id is echoed on error responses too.
    consumer.apply(CorrelationMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
