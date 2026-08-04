import { afterAll, describe, expect, it } from 'vitest';

import { AppConfig } from '../../src/config/config';
import { Logger } from '../../src/observability/logger';
import { S3ObjectStore } from '../../src/storage/s3-object-store';
import { closeServices, testConfig } from './support/services';

/**
 * ## Where a presigned URL points, and whether it works there
 *
 * SigV4 covers the Host header, so a presigned URL is valid at exactly one host.
 * Usually the client and the service reach the object store by the same name and
 * there is nothing to decide — that is what R2 and S3 give you, and production
 * leaves `STORAGE_PUBLIC_ENDPOINT` unset for exactly that reason.
 *
 * A `docker compose up` is the case where it is not true. The API resolves
 * `http://minio:9000` on the compose network; the browser doing the upload
 * cannot resolve that name at all. The resulting failure is unusually hostile to
 * diagnose: the browser reports a bare `TypeError` with no status, no headers
 * and no body, and the same URL fetched from inside the network succeeds — so it
 * reads like a browser fault rather than a configuration one.
 *
 * Two things are worth pinning, and only the second is interesting.
 *
 * Rewriting the origin of an already-signed URL is not an option; it invalidates
 * the signature it is rewriting. So the implementation signs with a second
 * client pointed at the public endpoint, and the load-bearing claim is not that
 * the URL *names* that host but that the object store *accepts* it there.
 */
describe('presigned URLs are signed for the endpoint the client will use', () => {
  const logger = new Logger({ level: 'error' });
  const stores: S3ObjectStore[] = [];

  async function storeWith(overrides: Record<string, string>): Promise<S3ObjectStore> {
    const store = new S3ObjectStore(new AppConfig({ ...process.env, ...overrides }), logger);
    stores.push(store);
    // Constructed directly rather than through Nest, so nothing has run the
    // lifecycle hook that creates the bucket. `ensureBucket` rather than
    // `onModuleInit` because the latter swallows the failure by design, and a
    // suite that silently proceeds without a bucket reports the wrong error.
    await store.ensureBucket();
    return store;
  }

  afterAll(async () => {
    for (const store of stores) store.onModuleDestroy();
    await closeServices();
  });

  it('points at the private endpoint when no public one is configured', async () => {
    const store = await storeWith({});
    const key = 'presign-default-probe';

    const uploadId = await store.createMultipartUpload(key, 'text/plain');
    try {
      const url = await store.presignUploadPart(key, uploadId, 1);
      expect(new URL(url).origin).toBe(new URL(testConfig().storage.endpoint).origin);
    } finally {
      await store.abortMultipartUpload(key, uploadId);
    }
  });

  it('signs for the public endpoint, and the store accepts it there', async () => {
    // A second name for the same MinIO: the harness reaches it by whatever
    // `getHost()` returned, and `127.0.0.1` is the same socket by another
    // spelling. Same store, different Host header — which is precisely the
    // shape of the compose problem, without needing a second container.
    const endpoint = new URL(testConfig().storage.endpoint);
    const publicOrigin = `${endpoint.protocol}//${endpoint.hostname === 'localhost' ? '127.0.0.1' : 'localhost'}:${endpoint.port}`;

    // Without this the test is vacuous: if the harness already reached MinIO by
    // the name chosen above, a single-client implementation would produce the
    // expected origin by accident and the assertion would prove nothing.
    expect(publicOrigin).not.toBe(endpoint.origin);

    const store = await storeWith({ STORAGE_PUBLIC_ENDPOINT: publicOrigin });
    const key = 'presign-public-probe';

    // This one goes over the private endpoint. If the two clients were
    // conflated the whole store would have moved, and the assertion below would
    // pass for the wrong reason.
    const uploadId = await store.createMultipartUpload(key, 'text/plain');
    try {
      const url = await store.presignUploadPart(key, uploadId, 1);
      expect(new URL(url).origin).toBe(publicOrigin);

      // The part that matters. A URL merely *naming* the public host satisfies
      // the assertion above and fails in a browser with `SignatureDoesNotMatch`,
      // which is the regression this test exists for.
      const response = await fetch(url, { method: 'PUT', body: 'presigned-part-body' });
      expect(response.status, await response.clone().text()).toBe(200);
    } finally {
      await store.abortMultipartUpload(key, uploadId);
    }
  });
});
