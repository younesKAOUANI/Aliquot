import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { digestCanonical, digestOfDigestSet, storageKeyForDigest } from '../../src/common/digest';
import { uuidv7 } from '../../src/common/uuid';
import {
  type ProvisionedTenant,
  type TestApp,
  bootTestApp,
  closeTestApp,
  provisionTenant,
} from './support/app';
import { adminDb, closeDatabases, insertRun } from './support/database';

/**
 * Regression: a derived artifact must be reachable, not just visible.
 *
 * An artifact reaches a study by one of two routes. An uploaded artifact is
 * bound by a `run_artifact` manifest entry; a processor output is not in that
 * table at all, and reaches a study only through its derivation's source run.
 *
 * The artifact read path originally consulted the first route alone, so every
 * derived artifact belonged to no study and the authorisation check reported
 * 403 -- for a tenant admin as much as for anyone else. The lineage endpoints
 * resolve studies by walking derivations and were unaffected, which made the
 * symptom oddly specific: the artifact appeared in the provenance graph and
 * could not be fetched or downloaded.
 *
 * The fixture builds the derivation directly rather than running a job. The
 * property under test is how the read path resolves a study, and driving a
 * whole processing pipeline to reach it would make the test slower and no more
 * conclusive.
 */
describe('access to derived artifacts', () => {
  let app: TestApp;
  let tenant: ProvisionedTenant;
  let inputArtifactId: string;
  let derivedArtifactId: string;
  let derivedDigest: string;

  beforeAll(async () => {
    app = await bootTestApp();
    tenant = await provisionTenant('derived-access');

    const runId = await insertRun(tenant, { state: 'OPEN' });
    const db = adminDb();

    // An ordinary uploaded artifact, bound through the manifest.
    const inputDigest = digestCanonical({ fixture: 'input', run: runId });
    inputArtifactId = uuidv7();
    await db
      .insertInto('aliquot.artifact')
      .values({
        id: inputArtifactId,
        tenant_id: tenant.tenantId,
        digest: inputDigest,
        size_bytes: 1024,
        storage_key: storageKeyForDigest(inputDigest),
        first_seen_run_id: runId,
      })
      .execute();

    await db
      .insertInto('aliquot.run_artifact')
      .values({
        id: uuidv7(),
        tenant_id: tenant.tenantId,
        run_id: runId,
        logical_name: 'ch0/stack.tif',
        declared_digest: inputDigest,
        declared_size: 1024,
        artifact_id: inputArtifactId,
        verification_state: 'VERIFIED',
        verified_at: new Date(),
      })
      .execute();

    // A processor output: recorded only in derivation_output, never in the
    // manifest. This is the artifact the read path used to lose.
    derivedDigest = digestCanonical({ fixture: 'derived', run: runId });
    derivedArtifactId = uuidv7();
    await db
      .insertInto('aliquot.artifact')
      .values({
        id: derivedArtifactId,
        tenant_id: tenant.tenantId,
        digest: derivedDigest,
        size_bytes: 256,
        media_type: 'application/json',
        storage_key: storageKeyForDigest(derivedDigest),
        first_seen_run_id: runId,
      })
      .execute();

    const derivationId = uuidv7();
    await db
      .insertInto('aliquot.derivation')
      .values({
        id: derivationId,
        tenant_id: tenant.tenantId,
        processor_name: 'checksum-manifest',
        processor_version: '1.0.0',
        parameters_digest: digestCanonical({}),
        inputs_digest: digestOfDigestSet([inputDigest]),
        source_run_id: runId,
      })
      .execute();

    await db
      .insertInto('aliquot.derivation_input')
      .values({
        tenant_id: tenant.tenantId,
        derivation_id: derivationId,
        artifact_id: inputArtifactId,
      })
      .execute();

    await db
      .insertInto('aliquot.derivation_output')
      .values({
        tenant_id: tenant.tenantId,
        derivation_id: derivationId,
        artifact_id: derivedArtifactId,
        logical_name: 'checksum-manifest/manifest.json',
      })
      .execute();
  });

  afterAll(async () => {
    await closeTestApp();
    await closeDatabases();
  });

  it('serves an uploaded artifact, so the fixture is sound', async () => {
    const response = await app.get(`/v1/artifacts/${inputArtifactId}`, {
      auth: tenant.users.scientist.token,
    });

    expect(response.status).toBe(200);
  });

  it('serves a derived artifact to a scientist on the source run study', async () => {
    const response = await app.get<{ id: string; boundTo: { logicalName: string }[] }>(
      `/v1/artifacts/${derivedArtifactId}`,
      { auth: tenant.users.scientist.token },
    );

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(derivedArtifactId);
    // The binding it is reachable through is the derivation output, so the
    // logical name a caller sees is the processor's, not a manifest entry's.
    expect(response.body.boundTo.map((binding) => binding.logicalName)).toContain(
      'checksum-manifest/manifest.json',
    );
  });

  it('redirects a download of a derived artifact to storage', async () => {
    const response = await app.get(`/v1/artifacts/${derivedArtifactId}/download`, {
      auth: tenant.users.scientist.token,
    });

    expect(response.status).toBe(302);
    // The presigned URL must point at the key derived from this artifact's own
    // digest. Asserting only that a redirect happened would pass just as
    // happily against the wrong object.
    expect(response.headers.location).toContain(storageKeyForDigest(derivedDigest));
  });

  it('still refuses a caller from another tenant', async () => {
    // The fix widened how a study is resolved. It must not have widened who may
    // reach the artifact: a different tenant sees a 404, not a 403, because a
    // 403 would confirm the identifier is real and belongs to somebody.
    const other = await provisionTenant('derived-access-other');

    const response = await app.get(`/v1/artifacts/${derivedArtifactId}`, {
      auth: other.users.admin.token,
    });

    expect(response.status).toBe(404);
  });
});
