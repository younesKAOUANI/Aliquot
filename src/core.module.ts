import { Global, Module } from '@nestjs/common';

import { AppConfig } from './config/config';
import { DatabaseService } from './database/database.service';
import { Logger } from './observability/logger';

/**
 * Configuration, logging and the database pool, visible everywhere.
 *
 * `@Global()` is usually a smell -- it makes a module's real dependencies
 * invisible in its `imports` list. These three earn it for a specific reason:
 * they are singletons whose identity matters. `DatabaseService` owns the
 * connection pool, and a feature module that provided its own copy would open a
 * second pool that nothing accounts for, silently doubling the connection count
 * against a database whose limit is the constraint the pool size was chosen
 * against. Making them global means there is exactly one of each by
 * construction rather than by everyone remembering to import rather than
 * provide.
 *
 * Everything else stays in its feature module and is imported explicitly.
 */
@Global()
@Module({
  providers: [
    { provide: AppConfig, useFactory: () => new AppConfig(process.env) },
    {
      provide: Logger,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        new Logger({
          level: config.logLevel,
          base: { service: 'aliquot', role: config.serviceRole },
        }),
    },
    DatabaseService,
  ],
  exports: [AppConfig, Logger, DatabaseService],
})
export class CoreModule {}
