import type { Readable } from 'node:stream';

/**
 * The seam between this service and whatever is actually holding the bytes.
 *
 * It exists for two reasons, and neither of them is "we might switch cloud
 * providers one day".
 *
 * The first is that the integrity guarantee is only as good as the test that
 * tries to break it. Corruption tests need to write bytes that disagree with
 * the digest the producer declared, which no correctly-behaving client will ever
 * do; having the store behind an interface means a test can subclass it and
 * flip a byte on the way through. That test is the whole evidence for R3, and
 * without a seam it cannot be written at all.
 *
 * The second is that the operations below are the complete list of things this
 * service asks of object storage. That list is short on purpose -- no listing,
 * no copying, no server-side encryption configuration, no lifecycle rules --
 * because everything the API does with storage has to be expressible as a
 * presigned URL handed to a client we do not control. Anything that cannot be
 * is a design mistake, and keeping the interface narrow is how that stays
 * visible.
 *
 * It is an abstract class rather than an interface because Nest resolves
 * providers by runtime token, and an interface has no runtime existence to be a
 * token.
 */

/** A part the client says it uploaded. `etag` is stored unquoted. */
export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export abstract class ObjectStore {
  /** Idempotent. Safe to call on every boot and from both processes at once. */
  abstract ensureBucket(): Promise<void>;

  /** `null` when the object does not exist. Any other failure throws. */
  abstract headObject(key: string): Promise<{ sizeBytes: bigint; etag: string } | null>;

  abstract createMultipartUpload(key: string, mediaType: string): Promise<string>;

  abstract presignUploadPart(key: string, uploadId: string, partNumber: number): Promise<string>;

  abstract completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void>;

  abstract abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  /** `downloadFilename` sets `response-content-disposition` on the signed request. */
  abstract presignGet(key: string, downloadFilename?: string): Promise<string>;

  abstract putObject(key: string, body: Uint8Array, mediaType: string): Promise<void>;

  /**
   * Remove an object. Idempotent: deleting a key that is not there succeeds.
   *
   * The only caller is the sandbox reaper (migration 0008), and it is the only
   * operation on this interface that destroys anything. It is here rather than
   * being reached around the seam for the same reason the corruption tests exist
   * -- a store a test can substitute is a store a test can assert against, and
   * "the reaper deleted an object a permanent tenant still references" is a
   * failure that has to be provable in a test rather than argued about.
   *
   * Deciding *which* keys are safe to delete is emphatically not this
   * interface's business: keys are content-addressed and therefore shared
   * between tenants, and the check lives in
   * `aliquot.digests_referenced_elsewhere()` where it can see the rows.
   */
  abstract deleteObject(key: string): Promise<void>;

  /**
   * Whole object into memory. Only for objects this service produced and whose
   * size it already knows to be small -- a processor's JSON output, a manifest.
   * Verification does not use it; see `openReadStream`.
   */
  abstract getObject(key: string): Promise<Uint8Array>;

  /**
   * Streaming read, for hashing an object whose size is unbounded.
   *
   * This is an addition to the operations above rather than a convenience on top
   * of `getObject`, because the two are not interchangeable at the sizes this
   * service is built for: a light-sheet stack is a few hundred gigabytes and
   * `getObject` would ask Node to allocate a buffer for all of it. Digest
   * verification reads every byte of every artifact, so it is precisely the
   * caller that cannot afford to buffer.
   *
   * The caller owns the returned stream and must destroy it if it stops reading
   * early; an abandoned S3 response body holds a socket open until the agent's
   * idle timeout.
   */
  abstract openReadStream(key: string): Promise<Readable>;

  /** Cheap liveness probe for the readiness endpoint. Never throws. */
  abstract isReachable(): Promise<boolean>;
}
