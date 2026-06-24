import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { ProcessingModule } from '../processing/processing.module';
import { IdempotencyService } from './idempotency.service';
import { RunController } from './run.controller';
import { RunService } from './run.service';

/**
 * Runs, manifests, the state machine and the idempotency machinery.
 *
 * `RunService` is exported because the upload module quarantines through it: a
 * digest mismatch has to mark the manifest entry before the run leaves `OPEN`,
 * and that ordering belongs with the state machine rather than being restated at
 * every call site that discovers a fault. `IdempotencyService` is exported for
 * the same reason -- upload completion is a mutating endpoint and needs the same
 * guarantee.
 *
 * `AuditModule` and `ProcessingModule` are imported for the two collaborators
 * sealing needs in its own transaction: the audit append and the enqueue. They
 * are imported rather than re-provided because a second `JobQueue` would write
 * to a queue the worker is not reading, and that failure is silent -- the run
 * seals, the job exists, and nothing ever claims it.
 *
 * `DatabaseService`, `AppConfig`, `Logger` and `AuthService` come from the root
 * composition. Re-providing them here would mean a second connection pool.
 */
@Module({
  imports: [AuditModule, ProcessingModule],
  controllers: [RunController],
  providers: [RunService, IdempotencyService],
  exports: [RunService, IdempotencyService],
})
export class IngestionModule {}
