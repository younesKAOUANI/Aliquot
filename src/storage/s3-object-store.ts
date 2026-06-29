import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  BucketLocationConstraint,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';

import { AppConfig } from '../config/config';
import { Logger } from '../observability/logger';
import { ObjectStore } from './object-store';
import type { CompletedPart } from './object-store';

/**
 * S3-compatible implementation. Exercised against MinIO in development and in
 * the integration suite, which is why `forcePathStyle` is configurable rather
 * than assumed: MinIO serves `endpoint/bucket/key`, real S3 prefers
 * `bucket.endpoint/key`, and getting it wrong produces a DNS failure that reads
 * like a network outage.
 *
 * ## Presigned URLs are capability tokens
 *
 * A presigned URL is not a link to a protected resource -- it *is* the
 * authorisation. Anyone holding the string can perform exactly that one
 * operation on exactly that one key, with this service's credentials, until the
 * signature expires. No further check happens at the storage tier; there is
 * nothing left to check against.
 *
 * Three consequences follow, and all three are load-bearing elsewhere in the
 * codebase:
 *
 *   - They are secrets. `src/observability/logger.ts` redacts `uploadUrl`,
 *     `downloadUrl` and `presignedUrl` by key, because a presigned PUT in a log
 *     aggregator is a live write capability against the bucket that outlives
 *     whoever leaked it.
 *   - They expire, and the expiry is not negotiable after the fact. A 700 GB
 *     transfer over a lab network will outlive any TTL short enough to be
 *     responsible, which is the actual reason uploads are multipart rather than
 *     a single PUT: a resumable upload can be handed fresh URLs, a single
 *     in-flight PUT cannot.
 *   - Their scope is a key, not a tenant. Row-level security does not reach the
 *     object store. Every key this service signs is derived from a digest it
 *     read out of a tenant-scoped query, so the authorisation happens before the
 *     signature is minted and never after.
 */
@Injectable()
export class S3ObjectStore extends ObjectStore implements OnModuleInit, OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly presignTtlSeconds: number;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    super();
    this.bucket = config.storage.bucket;
    this.presignTtlSeconds = config.storage.presignTtlSeconds;
    this.client = new S3Client({
      region: config.storage.region,
      endpoint: config.storage.endpoint,
      forcePathStyle: config.storage.forcePathStyle,
      credentials: {
        accessKeyId: config.storage.accessKeyId,
        secretAccessKey: config.storage.secretAccessKey,
      },
    });
  }

  /**
   * Create the bucket on boot, but do not refuse to boot if that fails.
   *
   * The failure is logged and swallowed deliberately. Object storage being down
   * is a condition the service is designed to survive: the readiness probe
   * covers it, so an unreachable store means the process starts, reports itself
   * not ready, serves no traffic, and recovers on its own when the store comes
   * back. Throwing here would instead crash-loop the process, and a crash-looping
   * pod produces no readiness signal at all -- the operator loses the one piece
   * of evidence that says which dependency is actually broken.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.ensureBucket();
    } catch (error) {
      this.logger.warn('could not ensure the storage bucket exists at startup', {
        bucket: this.bucket,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    try {
      await this.client.send(
        new CreateBucketCommand({
          Bucket: this.bucket,
          ...locationConstraint(this.config.storage.region),
        }),
      );
    } catch (error) {
      // The API and the worker boot at the same time and both call this. One of
      // them loses the race; losing it is the expected outcome, not a fault.
      if (!isAlreadyOurs(error)) throw error;
    }
  }

  async headObject(key: string): Promise<{ sizeBytes: bigint; etag: string } | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: BigInt(response.ContentLength ?? 0),
        etag: unquote(response.ETag ?? ''),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async createMultipartUpload(key: string, mediaType: string): Promise<string> {
    const response = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: mediaType,
      }),
    );

    if (!response.UploadId) {
      throw new Error(`object store did not return an upload id for ${key}`);
    }
    return response.UploadId;
  }

  async presignUploadPart(key: string, uploadId: string, partNumber: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.presignTtlSeconds },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    // S3 requires ascending part numbers and rejects the whole request if they
    // are not, without saying which one was out of order.
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: ordered.map((part) => ({
            PartNumber: part.partNumber,
            // Requoted on the way out: entity tags are stored unquoted here so
            // that a client which stripped the quotes and one which did not
            // produce the same row, and both AWS and MinIO expect the quoted
            // spelling back.
            ETag: `"${part.etag}"`,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (error) {
      // Abort is called on paths that may already have completed or already
      // aborted, and an upload id that no longer exists means the cleanup this
      // call was asking for has happened. Any other failure is real.
      if (!isNoSuchUpload(error)) throw error;
    }
  }

  async presignGet(key: string, downloadFilename?: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // The stored key is a digest, so without this every download lands on
        // disk named `3f9a...`. The disposition is signed along with the rest of
        // the request, which is why it is set here and not by a client
        // rewriting the query string -- an unsigned parameter invalidates the
        // signature.
        ...(downloadFilename === undefined
          ? {}
          : { ResponseContentDisposition: contentDisposition(downloadFilename) }),
      }),
      { expiresIn: this.presignTtlSeconds },
    );
  }

  async putObject(key: string, body: Uint8Array, mediaType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: mediaType,
        ContentLength: body.byteLength,
      }),
    );
  }

  async getObject(key: string): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) {
      throw new Error(`object store returned no body for ${key}`);
    }
    return response.Body.transformToByteArray();
  }

  async openReadStream(key: string): Promise<Readable> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    const body = response.Body;
    // The SDK types the body as one of three stream flavours because it is
    // shared with the browser build. Narrowing rather than asserting means a
    // future SDK that hands back a web stream here fails loudly instead of
    // hashing whatever `Readable.from` makes of it.
    if (!(body instanceof Readable)) {
      throw new Error(`object store returned a non-streaming body for ${key}`);
    }
    return body;
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch (error) {
      this.logger.debug('object store head bucket failed', {
        bucket: this.bucket,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

/**
 * Shape of an SDK service error, matched structurally.
 *
 * `instanceof S3ServiceException` is the obvious test and it is fragile in the
 * same way `instanceof DatabaseError` is: the exception is constructed inside a
 * `@smithy` package that may be deduplicated to a second copy in the module
 * graph, and one mismatched copy silently turns "bucket does not exist" into an
 * unhandled 404 on every boot.
 */
interface ServiceError {
  name: string;
  statusCode: number | undefined;
}

function asServiceError(error: unknown): ServiceError | null {
  if (typeof error !== 'object' || error === null) return null;
  if (!('name' in error) || typeof error.name !== 'string') return null;

  let statusCode: number | undefined;
  if ('$metadata' in error && typeof error.$metadata === 'object' && error.$metadata !== null) {
    const code: unknown = Reflect.get(error.$metadata, 'httpStatusCode');
    if (typeof code === 'number') statusCode = code;
  }

  return { name: error.name, statusCode };
}

function isNotFound(error: unknown): boolean {
  const service = asServiceError(error);
  if (!service) return false;
  // HEAD responses carry no body, so the SDK has no error code to parse and
  // reports `NotFound` with a 404. Named codes appear on the GET paths.
  return service.statusCode === 404 || service.name === 'NotFound' || service.name === 'NoSuchKey';
}

function isNoSuchUpload(error: unknown): boolean {
  const service = asServiceError(error);
  return service !== null && (service.name === 'NoSuchUpload' || service.statusCode === 404);
}

function isAlreadyOurs(error: unknown): boolean {
  const service = asServiceError(error);
  return (
    service !== null &&
    (service.name === 'BucketAlreadyOwnedByYou' || service.name === 'BucketAlreadyExists')
  );
}

/**
 * `us-east-1` must not be sent as a location constraint -- S3 rejects the
 * request if it is. Every other region must. MinIO ignores both.
 */
function locationConstraint(region: string): {
  CreateBucketConfiguration?: { LocationConstraint: BucketLocationConstraint };
} {
  if (region === 'us-east-1') return {};

  const known = Object.values(BucketLocationConstraint).find((value) => value === region);
  return known === undefined ? {} : { CreateBucketConfiguration: { LocationConstraint: known } };
}

/**
 * RFC 6266 disposition with both spellings of the filename.
 *
 * The quoted `filename` is what every HTTP client has understood for twenty
 * years and it can only carry ASCII; `filename*` carries the real name. Logical
 * names are constrained by a CHECK to a conservative character set, so the
 * fallback is nearly always identical -- nearly, and this is the header that
 * decides what a scientist finds in their downloads folder.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function unquote(etag: string): string {
  return etag.replace(/^"|"$/g, '');
}
