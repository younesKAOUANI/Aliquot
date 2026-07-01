import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';

/**
 * The resumable, integrity-verified upload flow.
 *
 * `AuditModule` and `IngestionModule` are imported for the two collaborators
 * that have to run inside this module's own transactions: the audit append, and
 * `RunService.quarantine`. Both are imported rather than re-provided, because a
 * second `RunService` would be a second implementation of the ordering that
 * `enforce_run_artifact_immutability` requires, and the failure would only show
 * up on the rejection path -- the one path that is hard to reach and matters
 * most when it is reached.
 *
 * `DatabaseService`, `AppConfig` and `Logger` come from the root composition,
 * and `ObjectStore` and `AuthService` from the two global modules that own them.
 * Re-providing any of them here would mean a second connection pool or a second
 * S3 client.
 */
@Module({
  imports: [AuditModule, IngestionModule],
  controllers: [UploadController],
  providers: [UploadService],
  exports: [UploadService],
})
export class UploadsModule {}
