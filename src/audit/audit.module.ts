import { Module } from '@nestjs/common';

import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { ChainVerifier } from './chain-verifier';
import { CheckpointService } from './checkpoint.service';

/**
 * The audit module.
 *
 * `AuditService` is exported because every other module appends through it --
 * ingestion, provenance and the worker all record what they did, and they do it
 * inside their own transaction rather than by calling an endpoint here.
 *
 * `DatabaseService`, `AppConfig` and `AuthService` are not provided here. They
 * are process-wide singletons owned by the root composition; re-providing them
 * in a feature module would create a second connection pool and a second
 * configuration object that could disagree with the first.
 */
@Module({
  controllers: [AuditController],
  providers: [AuditService, ChainVerifier, CheckpointService],
  exports: [AuditService, ChainVerifier, CheckpointService],
})
export class AuditModule {}
