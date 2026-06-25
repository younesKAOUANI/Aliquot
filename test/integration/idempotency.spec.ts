import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sha256Hex, storageKeyForDigest } from '../../src/common/digest';
import { ProblemType } from '../../src/common/problem-details';
import { uuidv7 } from '../../src/common/uuid';
import { manifestDigest } from '../../src/ingestion/manifest';
import type { ManifestEntry } from '../../src/ingestion/manifest';
import {
  type ProvisionedTenant,
  type TestApp,
  bootTestApp,
  closeTestApp,
  provisionTenant,
} from './support/app';
import { adminDb, closeDatabases } from './support/database';

/**
 * G1 — ingestion is exactly-once from the caller's point of view.
 *
 * The clients here are instrument agents on lab networks. They retry on any
 * timeout, including the timeouts where the request actually succeeded and only
 * the response was lost, so "the caller sent it twice" is the normal case rather
 * than the exceptional one. What this suite asserts is that sending it twice --
 * or eight times at once -- produces one run and one answer.
 *
 * Everything goes through HTTP. The idempotency service can be exercised
 * directly and it would prove less: the header parsing, the fingerprint taken
 * over the *parsed* body, the replayed status code and the problem document for
 * a reused key are all things that only exist at the edge, and the edge is where
 * the client meets them.
 *
 * Each test uses a manifest unique to itself, so `manifest_digest` identifies
 * that test's runs and a count is exact regardless of what else has run against
 * the same tenant.
 */
describe('idempotent ingestion', () => {
  let app: TestApp;
  let tenant: ProvisionedTenant;
  let registerPath: string;

  beforeAll(async () => {
    app = await bootTestApp();
    tenant = await provisionTenant('idem');
    registerPath = `/v1/studies/${tenant.studyId}/runs`;
  });

  afterAll(async () => {
    await closeTestApp();
    await closeDatabases();
  });

  describe('a request repeated under the same key', () => {
    it('replays the original response byte for byte and creates exactly one run', async () => {
      const label = 'replay';
      const key = keyFor(label);

      const first = await app.post(registerPath, registerBody(tenant, label), auth(tenant, key));
      const second = await app.post(registerPath, registerBody(tenant, label), auth(tenant, key));

      expect(first.status).toBe(201);
      // The stored status, not a constant 200: a replay answers with whatever
      // the original answered, which is the entire point of storing it.
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);
      expect(asRun(second.body).run.id).toBe(asRun(first.body).run.id);

      expect(await runsWithManifest(tenant, label)).toBe(1);
    });

    it('replays a retry that differs only in JSON key order', async () => {
      // This is what canonicalisation buys, and it is the test that decides
      // whether ADR-0009 is load-bearing or decorative. A client that
      // re-serialises the same object on retry -- a different JSON library, a
      // map with a different iteration order, a proxy that reformatted the body
      // -- has not made a different request, and fingerprinting the raw bytes
      // would tell it that it had.
      const label = 'key-order';
      const key = keyFor(label);
      const entries = manifestFor(label);

      const declared = JSON.stringify({
        instrumentId: tenant.instrumentId,
        operatorId: tenant.users.operator.id,
        acquiredAt: ACQUIRED_AT,
        protocol: PROTOCOL,
        manifest: entries,
      });

      // Every object's keys reversed. The manifest *array* keeps its order:
      // array order is significant in JSON and reordering it would be a
      // different request, not a differently spelled one.
      const reordered = JSON.stringify({
        manifest: entries.map((entry) => ({
          mediaType: entry.mediaType,
          sizeBytes: entry.sizeBytes,
          digest: entry.digest,
          logicalName: entry.logicalName,
        })),
        protocol: {
          binning: PROTOCOL.binning,
          channels: PROTOCOL.channels,
          objective: PROTOCOL.objective,
        },
        acquiredAt: ACQUIRED_AT,
        operatorId: tenant.users.operator.id,
        instrumentId: tenant.instrumentId,
      });

      // Guard against the test proving nothing: if these two strings were equal
      // the assertion below would hold for the wrong reason.
      expect(reordered).not.toBe(declared);

      const first = await app.postRaw(registerPath, declared, auth(tenant, key));
      const second = await app.postRaw(registerPath, reordered, auth(tenant, key));

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(asRun(second.body).run.id).toBe(asRun(first.body).run.id);

      expect(await runsWithManifest(tenant, label)).toBe(1);
    });
  });

  describe('a key reused for a materially different request', () => {
    it('is refused, names the mismatch, and creates no second run', async () => {
      const key = keyFor('reuse');

      const first = await app.post(
        registerPath,
        registerBody(tenant, 'reuse-a'),
        auth(tenant, key),
      );
      const second = await app.post(
        registerPath,
        registerBody(tenant, 'reuse-b'),
        auth(tenant, key),
      );

      expect(first.status).toBe(201);
      expect(second.status).toBe(409);
      expect(second.headers['content-type']).toContain('application/problem+json');

      const problem = asProblem(second.body);
      expect(problem.type).toBe(ProblemType.IDEMPOTENCY_KEY_REUSED);
      expect(problem.idempotencyKey).toBe(key);
      expect(problem.endpoint).toBe(`POST /v1/studies/${tenant.studyId}/runs`);
      // Silently returning the first response here would be worse than an
      // error, because it would look like success.
      expect(problem.detail).toContain('materially different');

      expect(await runsWithManifest(tenant, 'reuse-a')).toBe(1);
      expect(await runsWithManifest(tenant, 'reuse-b')).toBe(0);
    });
  });

  describe('genuinely concurrent duplicates', () => {
    it('produce exactly one run from eight simultaneous identical requests', async () => {
      // PRD R1's acceptance criterion, and the reason the unique constraint is
      // the concurrency mechanism rather than a check-then-act in the service.
      // Nothing here is staggered: the eight requests are started before any of
      // them is awaited, so they contend for the same key inside the same
      // millisecond.
      const label = 'concurrent';
      const key = keyFor(label);
      const body = registerBody(tenant, label);
      const attempts = 8;

      const responses = await Promise.all(
        Array.from({ length: attempts }, () => app.post(registerPath, body, auth(tenant, key))),
      );

      expect(await runsWithManifest(tenant, label)).toBe(1);

      const created = responses.filter((response) => response.status === 201);
      const contended = responses.filter((response) => response.status === 409);

      // Every caller gets a usable answer. There is no third outcome: a 500 here
      // would mean a duplicate reached a constraint the service did not expect.
      expect(created.length + contended.length).toBe(attempts);
      expect(created.length).toBeGreaterThanOrEqual(1);

      const winner = created[0];
      expect(winner).toBeDefined();
      for (const response of created) {
        // Whether a caller created the run or replayed it, it is handed the same
        // run. A client cannot tell which of the eight it was, and does not need to.
        expect(response.body).toEqual(winner?.body);
      }

      for (const response of contended) {
        const problem = asProblem(response.body);
        expect(problem.type).toBe(ProblemType.IDEMPOTENT_REQUEST_IN_FLIGHT);
        // Without this the client retries immediately, collides again, and turns
        // a transient conflict into a hot loop.
        expect(response.headers['retry-after']).toBeDefined();
      }
    });
  });

  describe('a request that fails', () => {
    it('releases its key, so the same key retried with a good body succeeds', async () => {
      // The failure is chosen to happen *inside* the work transaction, after the
      // IN_FLIGHT record has committed. A rejection that never claims a key
      // proves nothing about release; this one does.
      const label = 'released';
      const key = keyFor(label);

      const doomed = { ...registerBody(tenant, label), instrumentId: uuidv7() };
      const failed = await app.post(registerPath, doomed, auth(tenant, key));

      expect(failed.status).toBe(400);
      expect(asProblem(failed.body).detail).toContain('not an active instrument');

      // The mechanism: the record is deleted rather than left IN_FLIGHT or
      // completed with a failure. A tombstone would block this key for the whole
      // retention window and reject the legitimate retry below as a fingerprint
      // mismatch against a response that never existed.
      expect(await keyRecords(tenant, key)).toHaveLength(0);

      const retried = await app.post(registerPath, registerBody(tenant, label), auth(tenant, key));

      expect(retried.status).toBe(201);
      expect(await runsWithManifest(tenant, label)).toBe(1);
    });

    it('never claims the key at all when the body is rejected at the boundary', async () => {
      const label = 'malformed';
      const key = keyFor(label);

      const malformed = {
        ...registerBody(tenant, label),
        manifest: [
          {
            logicalName: `ch0/${label}.tif`,
            digest: 'not-a-sha-256-digest',
            sizeBytes: '1048576',
            mediaType: 'image/tiff',
          },
        ],
      };

      const rejected = await app.post(registerPath, malformed, auth(tenant, key));

      expect(rejected.status).toBe(400);
      expect(asProblem(rejected.body).type).toBe(ProblemType.VALIDATION_FAILED);
      expect(await keyRecords(tenant, key)).toHaveLength(0);

      const retried = await app.post(registerPath, registerBody(tenant, label), auth(tenant, key));
      expect(retried.status).toBe(201);
    });
  });

  describe('the Idempotency-Key header', () => {
    it('is required, and its absence names it rather than failing obscurely', async () => {
      const label = 'unkeyed';

      const response = await app.post(registerPath, registerBody(tenant, label), {
        auth: tenant.users.operator.token,
      });

      expect(response.status).toBe(400);
      const problem = asProblem(response.body);
      expect(problem.type).toBe(ProblemType.VALIDATION_FAILED);
      expect(problem.detail).toContain('Idempotency-Key');

      // Rejected before anything was written, not after.
      expect(await runsWithManifest(tenant, label)).toBe(0);
    });

    it('is refused when the client sent two of them', async () => {
      // A request carrying two keys is a client that does not know which key it
      // used. Resolving that on its behalf -- by taking the first, or by
      // treating the concatenation as a third key nobody chose -- is how one of
      // the two requests silently gets lost.
      const label = 'two-keys';

      const response = await app.post(registerPath, registerBody(tenant, label), {
        auth: tenant.users.operator.token,
        headers: { 'idempotency-key': [keyFor('first'), keyFor('second')] },
      });

      expect(response.status).toBe(400);
      expect(asProblem(response.body).detail).toContain('Idempotency-Key');
      expect(await runsWithManifest(tenant, label)).toBe(0);
    });
  });

  describe('the retention window', () => {
    it('treats a replay after expiry as a first-time request', async () => {
      // A caller replaying a key after the window is documented to be treated as
      // a first-time caller. The alternative -- returning the stale stored
      // response -- would mean a key handed out again a week later silently
      // answers with last week's run.
      const label = 'expired';
      const key = keyFor(label);

      const first = await app.post(registerPath, registerBody(tenant, label), auth(tenant, key));
      expect(first.status).toBe(201);

      // The window elapsing, without waiting a day for it. Written through the
      // owner because no application path can move an expiry backwards, which is
      // itself the property that makes the record trustworthy.
      await adminDb()
        .updateTable('aliquot.idempotency_key')
        .set({ expires_at: sql<Date>`clock_timestamp() - interval '1 hour'` })
        .where('tenant_id', '=', tenant.tenantId)
        .where('key', '=', key)
        .execute();

      const second = await app.post(registerPath, registerBody(tenant, label), auth(tenant, key));

      expect(second.status).toBe(201);
      expect(asRun(second.body).run.id).not.toBe(asRun(first.body).run.id);
      expect(await runsWithManifest(tenant, label)).toBe(2);
    });
  });

  describe('sealing', () => {
    it('replays the seal response and does not enqueue a second processing job', async () => {
      const label = 'sealed';

      const registered = await app.post(
        registerPath,
        registerBody(tenant, label),
        auth(tenant, keyFor(`${label}-register`)),
      );
      expect(registered.status).toBe(201);

      const runId = asRun(registered.body).run.id;
      await markManifestVerified(tenant, runId);

      const sealKey = keyFor(label);
      const sealPath = `/v1/runs/${runId}/seal`;

      const first = await app.post(sealPath, {}, auth(tenant, sealKey));
      const second = await app.post(sealPath, {}, auth(tenant, sealKey));

      expect(first.status).toBe(200);
      expect(asRun(first.body).run.state).toBe('SEALED');
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);

      // The seal and the job it enqueues commit together, so a second seal that
      // was not recognised as a replay would produce a second job and the run
      // would be processed twice. `job_dedupe_idx` is the backstop; the
      // idempotency record is what should mean the insert is never attempted.
      const jobs = await adminDb()
        .selectFrom('aliquot.job')
        .select(['id', 'state'])
        .where('tenant_id', '=', tenant.tenantId)
        .where('dedupe_key', '=', `run:${runId}`)
        .execute();

      expect(jobs).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Fixtures and narrowing
// ---------------------------------------------------------------------------

const ACQUIRED_AT = '2026-03-01T09:15:00Z';
const PROTOCOL = { objective: '63x', channels: ['DAPI', 'GFP'], binning: 1 };

/**
 * A manifest unique to one test.
 *
 * The digest is derived from the label rather than being a constant, so each
 * test's runs are identifiable by `manifest_digest` and a count is exact without
 * emptying the database between tests.
 */
function manifestFor(label: string): ManifestEntry[] {
  return [
    {
      logicalName: `ch0/${label}.tif`,
      digest: sha256Hex(`${label}/ch0`),
      sizeBytes: '1048576',
      mediaType: 'image/tiff',
    },
    {
      logicalName: `ch1/${label}.tif`,
      digest: sha256Hex(`${label}/ch1`),
      sizeBytes: '2097152',
      mediaType: 'image/tiff',
    },
  ];
}

function registerBody(tenant: ProvisionedTenant, label: string): Record<string, unknown> {
  return {
    instrumentId: tenant.instrumentId,
    operatorId: tenant.users.operator.id,
    acquiredAt: ACQUIRED_AT,
    protocol: PROTOCOL,
    manifest: manifestFor(label),
  };
}

/** Registration runs as an operator, which is the role an instrument agent's human counterpart holds. */
function auth(tenant: ProvisionedTenant, key: string) {
  return {
    auth: tenant.users.operator.token,
    headers: { 'idempotency-key': key },
  };
}

function keyFor(label: string): string {
  return `idem-${label}-${uuidv7()}`;
}

async function runsWithManifest(tenant: ProvisionedTenant, label: string): Promise<number> {
  const rows = await adminDb()
    .selectFrom('aliquot.run')
    .select('id')
    .where('tenant_id', '=', tenant.tenantId)
    .where('manifest_digest', '=', manifestDigest(manifestFor(label)))
    .execute();

  return rows.length;
}

async function keyRecords(
  tenant: ProvisionedTenant,
  key: string,
): Promise<{ id: string; state: string }[]> {
  return adminDb()
    .selectFrom('aliquot.idempotency_key')
    .select(['id', 'state'])
    .where('tenant_id', '=', tenant.tenantId)
    .where('key', '=', key)
    .execute();
}

/**
 * Bring a run's declared artifacts to VERIFIED without moving any bytes.
 *
 * Sealing refuses a run whose manifest is not fully verified, and that refusal
 * is the upload suite's guarantee, not this one's. Driving a real multipart
 * upload here would make a seal-replay assertion fail whenever MinIO hiccups,
 * for reasons that say nothing about idempotency. The rows are written through
 * the owner because the state they represent -- bytes stored and checked -- is
 * exactly what is being stipulated rather than tested.
 */
async function markManifestVerified(tenant: ProvisionedTenant, runId: string): Promise<void> {
  const db = adminDb();

  const declared = await db
    .selectFrom('aliquot.run_artifact')
    .select(['id', 'declared_digest', 'declared_size', 'declared_media_type'])
    .where('run_id', '=', runId)
    .execute();

  for (const entry of declared) {
    const artifactId = uuidv7();

    await db
      .insertInto('aliquot.artifact')
      .values({
        id: artifactId,
        tenant_id: tenant.tenantId,
        digest: entry.declared_digest,
        size_bytes: entry.declared_size,
        storage_key: storageKeyForDigest(entry.declared_digest),
        media_type: entry.declared_media_type,
        first_seen_run_id: runId,
      })
      .execute();

    await db
      .updateTable('aliquot.run_artifact')
      .set({
        artifact_id: artifactId,
        verification_state: 'VERIFIED',
        verified_at: sql<Date>`clock_timestamp()`,
      })
      .where('id', '=', entry.id)
      .execute();
  }
}

interface RunMutationBody {
  run: { id: string; state: string; manifestDigest: string };
  auditSeq: string;
}

interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  [extension: string]: unknown;
}

/**
 * Narrowed at runtime rather than asserted, so a test that expected a run and
 * received a problem document fails saying what it actually got. A bare cast
 * would fail three lines later on an undefined property instead.
 */
function asRun(body: unknown): RunMutationBody {
  if (typeof body !== 'object' || body === null || !('run' in body)) {
    throw new Error(`expected a run mutation result, got ${JSON.stringify(body)}`);
  }
  return body as RunMutationBody;
}

function asProblem(body: unknown): ProblemBody {
  if (typeof body !== 'object' || body === null || !('type' in body) || !('status' in body)) {
    throw new Error(`expected an RFC 9457 problem document, got ${JSON.stringify(body)}`);
  }
  return body as ProblemBody;
}
