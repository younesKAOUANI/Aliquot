import { Module } from '@nestjs/common';

import { AuditModule } from './audit/audit.module';
import { CoreModule } from './core.module';
import { HttpModule } from './http/http.module';
import { IdentityModule } from './identity/identity.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { ProcessingModule } from './processing/processing.module';
import { ProvenanceModule } from './provenance/provenance.module';
import { StorageModule } from './storage/storage.module';
import { UploadsModule } from './uploads/uploads.module';

/**
 * The composition root, shared by the API and the worker.
 *
 * One module graph for both processes rather than two. `SERVICE_ROLE` decides
 * which entrypoint runs, but both assemble the same services from the same
 * providers, so the worker exercises the code paths the API was tested against
 * instead of a parallel wiring that can quietly drift.
 */
@Module({
  imports: [
    CoreModule,
    HttpModule,
    AuditModule,
    IdentityModule,
    IngestionModule,
    StorageModule,
    UploadsModule,
    ProvenanceModule,
    ProcessingModule,
  ],
  // The global guards -- AuthGuard, then DemoReadOnlyGuard -- are bound by
  // IdentityModule, which owns them. Binding AuthGuard here as well registers it
  // twice and Nest runs it twice per request, which for an instrument credential
  // means a second scrypt derivation on the hot path for no benefit.
})
export class AppModule {}
