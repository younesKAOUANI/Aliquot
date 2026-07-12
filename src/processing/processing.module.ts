import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { ProvenanceModule } from '../provenance/provenance.module';
import { StorageModule } from '../storage/storage.module';
import { JobQueue } from './job-queue';
import { PostgresJobQueue } from './postgres-job-queue';
import { PROCESSORS, Processor } from './processor';
import { ChecksumManifestProcessor } from './processors/checksum-manifest.processor';
import { MetadataExtractProcessor } from './processors/metadata-extract.processor';
import { RunProcessorJob } from './run-processor.job';
import { JOB_HANDLERS, WorkerRuntime } from './worker.runtime';

/**
 * The processing module, imported by both processes and doing different work in
 * each.
 *
 * The API imports it for `JobQueue` alone: sealing a run enqueues its processing
 * job in the same transaction as the seal. The worker additionally starts
 * `WorkerRuntime`, which is why nothing here polls on its own -- see the note in
 * `worker.runtime.ts`.
 *
 * `DatabaseService`, `AppConfig` and `Logger` are process-wide singletons owned
 * by the root composition and are not re-provided here; a second connection pool
 * would be a strange thing to acquire by importing a module.
 */
@Module({
  imports: [AuditModule, StorageModule, ProvenanceModule],
  providers: [
    PostgresJobQueue,
    // One instance behind two names. Callers that only enqueue depend on the
    // abstraction; the runtime, which claims, depends on the implementation.
    { provide: JobQueue, useExisting: PostgresJobQueue },

    ChecksumManifestProcessor,
    MetadataExtractProcessor,
    {
      provide: PROCESSORS,
      // Order is fixed rather than incidental: each processor records its own
      // derivation, so the order does not change the result, but it does change
      // the order of the audit events that describe it.
      useFactory: (
        checksumManifest: ChecksumManifestProcessor,
        metadataExtract: MetadataExtractProcessor,
      ): Processor[] => [checksumManifest, metadataExtract],
      inject: [ChecksumManifestProcessor, MetadataExtractProcessor],
    },

    RunProcessorJob,
    {
      provide: JOB_HANDLERS,
      useFactory: (runProcessor: RunProcessorJob) => [runProcessor],
      inject: [RunProcessorJob],
    },

    WorkerRuntime,
  ],
  exports: [JobQueue, WorkerRuntime],
})
export class ProcessingModule {}
