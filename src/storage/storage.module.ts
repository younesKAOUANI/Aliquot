import { Global, Module } from '@nestjs/common';

import { ObjectStore } from './object-store';
import { S3ObjectStore } from './s3-object-store';

/**
 * Binds the seam to the only implementation that talks to real storage.
 *
 * Global because an `S3Client` is a process singleton in the same sense the
 * connection pool is: it owns a socket pool, a credential provider and a
 * retry budget, and providing it a second time in a feature module would create
 * a second of each without anything indicating that had happened. The readiness
 * probe, ingestion, uploads and the worker all inject `ObjectStore`, and they
 * must all get the same one.
 *
 * Everything injects the abstract class, never `S3ObjectStore`. That is what
 * lets an integration test swap in a store that corrupts a byte on the way
 * through and have the rest of the graph be unaware.
 */
@Global()
@Module({
  providers: [{ provide: ObjectStore, useClass: S3ObjectStore }],
  exports: [ObjectStore],
})
export class StorageModule {}
