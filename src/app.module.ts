import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuditModule } from './audit/audit.module';
import { CoreModule } from './core.module';
import { HttpModule } from './http/http.module';
import { AuthGuard } from './identity/auth.guard';
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
  providers: [
    // Authentication is on by default and opted out of per route with
    // @Public(). The alternative -- opting in with a decorator on every guarded
    // route -- fails open: a new endpoint written without the decorator is
    // simply unauthenticated, and nothing about it looks wrong in review.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
