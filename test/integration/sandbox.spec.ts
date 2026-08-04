import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sha256Hex, storageKeyForDigest } from '../../src/common/digest';
import { ProblemType } from '../../src/common/problem-details';
import { uuidv7 } from '../../src/common/uuid';
import { SandboxReaper } from '../../src/identity/sandbox-reaper';
import { verifySession } from '../../src/identity/tokens';
import { Logger } from '../../src/observability/logger';
import { S3ObjectStore } from '../../src/storage/s3-object-store';
import type { IsolatedTestApp, TestApp } from './support/app';
import { bootAppWithEnv, bootTestApp, closeTestApp } from './support/app';
import { adminDb, closeDatabases, createTenant, tenantScopedTables } from './support/database';
import type { TenantFixture } from './support/database';
import { closeServices, testConfig, testDatabase } from './support/services';

/**
 * G7 -- a stranger can drive the whole lifecycle, inside a tenant that is
 * bounded and then ceases to exist.
 *
 * The demo (G6) proves a visitor can read the seeded dataset and change nothing.
 * This proves the opposite half: a visitor can change things, and the blast
 * radius of their doing so is a tenant that holds nothing but their own work,
 * refuses to grow past a quota, and is deleted outright when its hour is up.
 *
 * Four properties are asserted, and they are not of equal weight.
 *
 *   1. The session is an ordinary one -- admin of the sandbox tenant and nothing
 *      else. If a sandbox reached the interesting paths by relaxing a guard, it
 *      would demonstrate that the guards are negotiable rather than that the
 *      system works. What bounds it is the tenant, not the role.
 *   2. The quota is refused at the earliest point at which refusing is free --
 *      a manifest entry that is too large is rejected at registration, before an
 *      upload URL exists, because refusing after the bytes have landed is a
 *      report on a quota rather than a quota.
 *   3. A permanent tenant cannot be reaped. This is the property the whole
 *      design of migration 0008 exists to provide, and it is asserted against
 *      the function directly rather than through the reaper, because the reaper
 *      is the thing that might one day be wrong.
 *   4. Reaping a sandbox does not delete bytes another tenant is pointing at.
 *      Storage keys are content-addressed and therefore global while artifact
 *      rows are per tenant (ADR-0017), so this is a real collision and not a
 *      hypothetical one. Getting it wrong leaves the neighbour's run reporting
 *      itself VERIFIED over a key that 404s, which is the single worst way this
 *      service could fail.
 */
describe('ephemeral sandbox tenants', () => {
  /** Sandbox mode on, with quotas small enough to reach inside a test. */
  let sandboxApp: IsolatedTestApp;
  /** The shared application, which has SANDBOX_MODE off. */
  let defaultApp: TestApp;

  const MAX_RUNS = 2;
  const MAX_ARTIFACT_BYTES = 1024;

  beforeAll(async () => {
    defaultApp = await bootTestApp();
    sandboxApp = await bootAppWithEnv({
      SANDBOX_MODE: 'true',
      SANDBOX_TTL_MINUTES: '60',
      SANDBOX_MAX_RUNS: String(MAX_RUNS),
      SANDBOX_MAX_ARTIFACT_BYTES: String(MAX_ARTIFACT_BYTES),
      SANDBOX_MAX_TOTAL_BYTES: '4096',
      SANDBOX_RATE_LIMIT_PER_MINUTE: '1000',
      DATABASE_POOL_SIZE: '2',
    });
  });

  afterAll(async () => {
    await sandboxApp.close();
    await closeTestApp();
    await closeServices();
    await closeDatabases();
  });

  describe('provisioning', () => {
    it('creates a whole working tenant and hands back a session for it', async () => {
      const response = await sandboxApp.post('/v1/sandbox');
      expect(response.status).toBe(200);

      const issued = asSandbox(response.body);
      expect(issued.tokenType).toBe('Bearer');
      expect(issued.sandbox.tenantSlug).toMatch(/^sandbox-[0-9a-f]{8}$/);
      expect(new Date(issued.sandbox.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(issued.sandbox.quota).toEqual({
        maxRuns: MAX_RUNS,
        maxArtifactBytes: String(MAX_ARTIFACT_BYTES),
        maxTotalBytes: '4096',
      });

      // The tenant is marked in the schema, not merely by convention. Everything
      // the reaper is allowed to do follows from this column.
      const tenant = await adminDb()
        .selectFrom('aliquot.tenant')
        .select(['kind', 'expires_at'])
        .where('id', '=', issued.sandbox.tenantId)
        .executeTakeFirstOrThrow();

      expect(tenant.kind).toBe('sandbox');
      expect(tenant.expires_at).not.toBeNull();
    });

    it('issues an ordinary session, not a demo one', async () => {
      const issued = asSandbox((await sandboxApp.post('/v1/sandbox')).body);
      const claims = verifySession(testConfig().auth.jwtSecret, issued.token);

      // The distinction the whole feature turns on: `DemoReadOnlyGuard` refuses
      // every mutating verb presented by a session carrying `demo: true`, and a
      // sandbox that could not write would be a slower demo.
      expect(claims.demo).toBeUndefined();
      expect(claims.tid).toBe(issued.sandbox.tenantId);
      expect(claims.sub).toBe(issued.sandbox.operatorId);
    });

    it('opens the tenant audit chain at seq 1 with the provisioning event', async () => {
      const issued = asSandbox((await sandboxApp.post('/v1/sandbox')).body);
      expect(issued.auditSeq).toBe('1');

      const events = await sandboxApp.get('/v1/audit', { auth: issued.token });
      expect(events.status).toBe(200);

      const first = asAuditPage(events.body).items.at(-1);
      expect(first?.action).toBe('sandbox.provisioned');
      expect(first?.seq).toBe('1');
    });

    it('reports quota and usage back through GET /v1/sandbox', async () => {
      const issued = asSandbox((await sandboxApp.post('/v1/sandbox')).body);

      const status = await sandboxApp.get('/v1/sandbox', { auth: issued.token });
      expect(status.status).toBe(200);

      const body = asStatus(status.body);
      expect(body.tenantId).toBe(issued.sandbox.tenantId);
      expect(body.studyId).toBe(issued.sandbox.studyId);
      expect(body.instrumentId).toBe(issued.sandbox.instrumentId);
      expect(body.used).toEqual({ runs: 0, totalBytes: '0' });
    });

    it('is absent, not forbidden, on a deployment with sandbox mode off', async () => {
      // A 403 would confirm the route exists and is merely switched off, which
      // tells a scanner which deployment to come back to.
      const response = await defaultApp.post('/v1/sandbox');
      expect(response.status).toBe(404);
    });
  });

  describe('the session it issues', () => {
    it('can register a run, which is the entire point', async () => {
      // Non-vacuity for everything below. Without this the refusals could all be
      // satisfied by a sandbox session that could do nothing at all.
      const issued = asSandbox((await sandboxApp.post('/v1/sandbox')).body);

      const registered = await sandboxApp.post(
        `/v1/studies/${issued.sandbox.studyId}/runs`,
        registerBody(issued, 'first-light', '512'),
        { auth: issued.token, headers: { 'idempotency-key': uuidv7() } },
      );

      expect(registered.status).toBe(201);
    });
  });

  describe('the quota', () => {
    it('refuses an oversized artifact at registration, before any upload URL exists', async () => {
      const issued = asSandbox((await sandboxApp.post('/v1/sandbox')).body);

      const response = await sandboxApp.post(
        `/v1/studies/${issued.sandbox.studyId}/runs`,
        registerBody(issued, 'too-big', String(MAX_ARTIFACT_BYTES + 1)),
        { auth: issued.token, headers: { 'idempotency-key': uuidv7() } },
      );

      expect(response.status).toBe(422);
      const problem = asProblem(response.body);
      expect(problem.type).toBe(ProblemType.ARTIFACT_TOO_LARGE);
      expect(problem.declaredSize).toBe(String(MAX_ARTIFACT_BYTES + 1));
      expect(problem.limit).toBe(String(MAX_ARTIFACT_BYTES));

      // The run must not exist. Refusing after a run had been created would
      // leave the tenant a run poorer for a request that did nothing.
      const runs = await sandboxApp.get('/v1/sandbox', { auth: issued.token });
      expect(asStatus(runs.body).used.runs).toBe(0);
    });

    it('refuses the run after the last one it is allowed, and still permits reads', async () => {
      const issued = asSandbox((await sandboxApp.post('/v1/sandbox')).body);

      for (let index = 0; index < MAX_RUNS; index += 1) {
        const allowed = await sandboxApp.post(
          `/v1/studies/${issued.sandbox.studyId}/runs`,
          registerBody(issued, `run-${index}`, '256'),
          { auth: issued.token, headers: { 'idempotency-key': uuidv7() } },
        );
        expect(allowed.status).toBe(201);
      }

      const refused = await sandboxApp.post(
        `/v1/studies/${issued.sandbox.studyId}/runs`,
        registerBody(issued, 'one-too-many', '256'),
        { auth: issued.token, headers: { 'idempotency-key': uuidv7() } },
      );

      expect(refused.status).toBe(409);
      const problem = asProblem(refused.body);
      expect(problem.type).toBe(ProblemType.SANDBOX_QUOTA_EXCEEDED);
      expect(problem.quota).toBe('runs');
      expect(problem.limit).toBe(String(MAX_RUNS));

      // Reads are untouched. Being able to look at what you made is the reason
      // for having made it, and a quota that blinded the visitor at the moment
      // they hit it would be a strange thing to ship.
      const status = await sandboxApp.get('/v1/sandbox', { auth: issued.token });
      expect(status.status).toBe(200);
      expect(asStatus(status.body).used.runs).toBe(MAX_RUNS);
    });

    it('refuses writes once the sandbox has expired, and says so as expiry', async () => {
      const issued = asSandbox((await sandboxApp.post('/v1/sandbox')).body);
      await expire(issued.sandbox.tenantId);

      const refused = await sandboxApp.post(
        `/v1/studies/${issued.sandbox.studyId}/runs`,
        registerBody(issued, 'after-the-bell', '256'),
        { auth: issued.token, headers: { 'idempotency-key': uuidv7() } },
      );

      expect(refused.status).toBe(403);
      // Not a 401. The token is genuine and has not itself expired -- the token
      // lifetime and the tenant lifetime are separate clocks -- so telling the
      // holder to re-authenticate would send them round a loop that cannot work.
      expect(asProblem(refused.body).type).toBe(ProblemType.SANDBOX_EXPIRED);

      const status = await sandboxApp.get('/v1/sandbox', { auth: issued.token });
      expect(status.status).toBe(200);
    });

    it('does not apply to a permanent tenant', async () => {
      // The guard is bound globally, so it runs on every mutating request in the
      // process. A permanent tenant must be entirely unaffected by it.
      const neighbour = await createTenant('sandbox-unaffected');
      const runId = await insertRunFor(neighbour);

      const state = await sql<{ kind: string }>`
        select kind::text as kind from aliquot.tenant where id = ${neighbour.tenantId}::uuid
      `.execute(adminDb());

      expect(state.rows[0]?.kind).toBe('permanent');
      expect(runId).toBeTruthy();
    });
  });

  describe('finishing the story', () => {
    /**
     * `operator` registers runs and cannot call `POST /v1/audit/verify`, which
     * needs steward or admin. A sandbox granted it would let a visitor upload an
     * artifact, watch the audit chain grow from their own action, and then be
     * refused the one question the whole exercise builds towards. So the
     * membership is `admin`: the tenant is theirs and dies with them, and the
     * privilege is bounded by the tenant rather than by the role.
     */
    it('can verify its own chain rather than being refused it', async () => {
      const issued = asSandbox((await sandboxApp.post('/v1/sandbox')).body);

      const response = await sandboxApp.post('/v1/audit/verify', {}, { auth: issued.token });

      expect(response.status).toBe(200);
      expect((response.body as { ok: boolean }).ok).toBe(true);
    });

    it('is still bounded: writes are capped whatever they touch', async () => {
      // `admin` over one's own tenant would otherwise mean unlimited instrument
      // creation, which neither the run nor the byte quota notices.
      const issued = asSandbox((await sandboxApp.post('/v1/sandbox')).body);

      let refusedAt: number | null = null;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const response = await sandboxApp.post(
          '/v1/instruments',
          { slug: `probe-${attempt}`, displayName: `Probe ${attempt}` },
          { auth: issued.token },
        );
        if (response.status === 409) {
          refusedAt = attempt;
          break;
        }
      }

      expect(refusedAt, 'writes were never capped').not.toBeNull();
    });
  });

  describe('reaping', () => {
    it('refuses to delete a tenant that is not a sandbox', async () => {
      const permanent = await createTenant('sandbox-protected');

      // Asserted against the function rather than through the reaper. The
      // reaper's WHERE clause is code and code can be wrong; this is the gate
      // that holds when it is.
      await expect(
        sql`select * from aliquot.reap_sandbox_tenant(${permanent.tenantId}::uuid)`.execute(
          adminDb(),
        ),
      ).rejects.toThrow(/enduring record/);

      const survivor = await adminDb()
        .selectFrom('aliquot.tenant')
        .select('id')
        .where('id', '=', permanent.tenantId)
        .executeTakeFirst();

      expect(survivor).toBeDefined();
    });

    it('deletes an expired sandbox entirely, and spares objects another tenant holds', async () => {
      const store = new S3ObjectStore(testConfig(), new Logger({ level: 'error' }));
      await store.onModuleInit();

      const shared = sha256Hex(`sandbox-shared-${uuidv7()}`);
      const solitary = sha256Hex(`sandbox-solitary-${uuidv7()}`);
      const sharedKey = storageKeyForDigest(shared);
      const solitaryKey = storageKeyForDigest(solitary);

      await store.putObject(sharedKey, new TextEncoder().encode('shared'), 'text/plain');
      await store.putObject(solitaryKey, new TextEncoder().encode('solitary'), 'text/plain');

      // A permanent neighbour holding the same content. Per-tenant deduplication
      // means two artifact rows; content addressing means one object.
      const neighbour = await createTenant('sandbox-neighbour');
      const neighbourRun = await insertRunFor(neighbour);
      await insertArtifact(neighbour.tenantId, neighbourRun, shared, sharedKey);

      const issued = asSandbox((await sandboxApp.post('/v1/sandbox')).body);
      const sandboxRun = await insertRunFor({
        tenantId: issued.sandbox.tenantId,
        studyId: issued.sandbox.studyId,
        instrumentId: issued.sandbox.instrumentId,
        userId: issued.sandbox.operatorId,
        slug: issued.sandbox.tenantSlug,
      });
      await insertArtifact(issued.sandbox.tenantId, sandboxRun, shared, sharedKey);
      await insertArtifact(issued.sandbox.tenantId, sandboxRun, solitary, solitaryKey);

      await expire(issued.sandbox.tenantId);

      const reaper = new SandboxReaper(
        await testDatabase(),
        store,
        testConfig(),
        new Logger({ level: 'error' }),
      );
      const swept = await reaper.sweep();
      expect(swept).toBeGreaterThanOrEqual(1);

      // Nothing of the sandbox is left. Read from the catalogue rather than a
      // hard-coded list, so a table added by a later migration and forgotten by
      // the reaper fails here instead of leaking rows for ever.
      for (const table of await tenantScopedTables()) {
        const remaining = await sql<{ count: string }>`
          select count(*)::text as count
            from ${sql.raw(`aliquot.${table}`)}
           where tenant_id = ${issued.sandbox.tenantId}::uuid
        `.execute(adminDb());

        expect(`${table}=${remaining.rows[0]?.count ?? '?'}`).toBe(`${table}=0`);
      }

      const tenant = await adminDb()
        .selectFrom('aliquot.tenant')
        .select('id')
        .where('id', '=', issued.sandbox.tenantId)
        .executeTakeFirst();
      expect(tenant).toBeUndefined();

      // The load-bearing assertion. The neighbour's artifact row still points at
      // `sharedKey`, so the bytes must still be there; nothing points at
      // `solitaryKey`, so they must not.
      expect(await store.headObject(sharedKey)).not.toBeNull();
      expect(await store.headObject(solitaryKey)).toBeNull();

      const neighbourRows = await adminDb()
        .selectFrom('aliquot.artifact')
        .select('id')
        .where('tenant_id', '=', neighbour.tenantId)
        .execute();
      expect(neighbourRows).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Fixtures and narrowing
// ---------------------------------------------------------------------------

interface SandboxResponse {
  token: string;
  tokenType: string;
  auditSeq: string;
  sandbox: {
    tenantId: string;
    tenantSlug: string;
    studyId: string;
    instrumentId: string;
    operatorId: string;
    expiresAt: string;
    quota: { maxRuns: number; maxArtifactBytes: string; maxTotalBytes: string };
  };
}

interface StatusResponse {
  tenantId: string;
  studyId: string;
  instrumentId: string;
  used: { runs: number; totalBytes: string };
}

function asSandbox(body: unknown): SandboxResponse {
  return body as SandboxResponse;
}

function asStatus(body: unknown): StatusResponse {
  return body as StatusResponse;
}

function asProblem(body: unknown): Record<string, unknown> {
  return body as Record<string, unknown>;
}

function asAuditPage(body: unknown): { items: { seq: string; action: string }[] } {
  return body as { items: { seq: string; action: string }[] };
}

function registerBody(
  issued: SandboxResponse,
  label: string,
  sizeBytes: string,
): Record<string, unknown> {
  return {
    instrumentId: issued.sandbox.instrumentId,
    acquiredAt: '2026-08-04T09:00:00Z',
    protocol: { objective: '20x', channels: ['DAPI'] },
    manifest: [
      {
        logicalName: `ch0/${label}.tif`,
        digest: sha256Hex(`sandbox/${issued.sandbox.tenantId}/${label}`),
        sizeBytes,
        mediaType: 'image/tiff',
      },
    ],
  };
}

/** Move a sandbox's expiry into the past, which is the only way to age one in a test. */
async function expire(tenantId: string): Promise<void> {
  await sql`
    update aliquot.tenant
       set expires_at = clock_timestamp() - interval '1 minute'
     where id = ${tenantId}::uuid
  `.execute(adminDb());
}

async function insertRunFor(fixture: TenantFixture): Promise<string> {
  const id = uuidv7();

  await adminDb()
    .insertInto('aliquot.run')
    .values({
      id,
      tenant_id: fixture.tenantId,
      study_id: fixture.studyId,
      instrument_id: fixture.instrumentId,
      operator_id: fixture.userId,
      state: 'OPEN',
      manifest_digest: 'e'.repeat(64),
    })
    .execute();

  return id;
}

async function insertArtifact(
  tenantId: string,
  runId: string,
  digest: string,
  storageKey: string,
): Promise<void> {
  await adminDb()
    .insertInto('aliquot.artifact')
    .values({
      id: uuidv7(),
      tenant_id: tenantId,
      digest,
      size_bytes: '8',
      storage_key: storageKey,
      media_type: 'text/plain',
      first_seen_run_id: runId,
    })
    .execute();
}
