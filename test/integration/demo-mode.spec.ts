import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sha256Hex } from '../../src/common/digest';
import { ProblemType } from '../../src/common/problem-details';
import { uuidv7 } from '../../src/common/uuid';
import { AppConfig } from '../../src/config/config';
import { verifySession } from '../../src/identity/tokens';
import {
  type IsolatedTestApp,
  type ProvisionedTenant,
  bootAppWithEnv,
  bootTestApp,
  closeTestApp,
  provisionTenant,
} from './support/app';
import { closeDatabases } from './support/database';
import { testConfig } from './support/services';

/**
 * G6 -- a public demo session can read everything and change nothing.
 *
 * This deployment is published at a URL a stranger can open, so there has to be
 * a way to obtain a session without being given one. The existing development
 * endpoint is not that way: it mints a session for any address it is handed, so
 * reaching it is equivalent to holding every credential in the tenant. What is
 * asserted here is that the demo endpoint is a different thing rather than a
 * relaxed version of the same thing -- it takes no input, so there is nothing to
 * influence, and every session it issues is refused on every mutating verb by a
 * guard that does not consult a role.
 *
 * ## Why this file builds its own applications
 *
 * `bootTestApp()` memoises one instance built from the environment the global
 * setup left behind, and that environment has `AUTH_DEV_TOKEN_ENDPOINT=true`
 * because every other suite signs in through it. `AppConfig` refuses to start
 * with that and `DEMO_MODE` both on -- deliberately, since they are different
 * mechanisms with different threat models -- so demo mode is unreachable from
 * the shared instance by construction.
 *
 * The alternative to a second application would have been overriding the
 * `AppConfig` provider, which needs `@nestjs/testing`: a permanent dependency
 * bought for one suite, and a second wiring path that can drift from the one
 * `main.ts` uses. `bootAppWithEnv()` instead sets the variables around a real
 * `NestFactory.create` and restores them, so what boots is the actual
 * application parsing an actual environment through the actual schema.
 *
 * Three of them, because three of the properties here are properties of
 * configuration -- the rate limit and the misconfigured account cannot be
 * exercised on an instance configured to have neither. Each uses a pool of two
 * connections so the four live applications in this run stay well inside the
 * server's limit.
 */
describe('read-only demo access', () => {
  let tenant: ProvisionedTenant;

  /** Demo mode on, pointed at a real seeded account, rate limit effectively off. */
  let demoApp: IsolatedTestApp;
  /** Demo mode on, rate limit of two per minute, so the third request is refused. */
  let limitedApp: IsolatedTestApp;
  /** Demo mode on, pointed at an account that does not exist. */
  let unseededApp: IsolatedTestApp;

  let demoToken: string;
  let runId: string;

  beforeAll(async () => {
    tenant = await provisionTenant('demo');

    const base = {
      DEMO_MODE: 'true',
      // Mutually exclusive with DEMO_MODE, and on in the shared environment.
      AUTH_DEV_TOKEN_ENDPOINT: 'false',
      DEMO_TENANT_SLUG: tenant.slug,
      DATABASE_POOL_SIZE: '2',
    };

    [demoApp, limitedApp, unseededApp] = await Promise.all([
      bootAppWithEnv({
        ...base,
        // A steward, because chain verification is the one write-shaped read the
        // demo is allowed and it requires steward or admin. A demo pointed at an
        // account without that role would still be read-only; it would just have
        // nothing interesting to show.
        DEMO_USER_EMAIL: tenant.users.steward.email,
        DEMO_RATE_LIMIT_PER_MINUTE: '1000',
      }),
      bootAppWithEnv({
        ...base,
        DEMO_USER_EMAIL: tenant.users.steward.email,
        DEMO_RATE_LIMIT_PER_MINUTE: '2',
      }),
      bootAppWithEnv({
        ...base,
        DEMO_USER_EMAIL: `nobody@${tenant.slug}.test`,
        DEMO_RATE_LIMIT_PER_MINUTE: '1000',
      }),
    ]);

    const issued = await demoApp.post('/v1/auth/demo');
    expect(issued.status).toBe(200);
    demoToken = asSession(issued.body).token;

    // An ordinary run for the mutating verbs to be refused against. Registered
    // with a non-demo operator token, which is also what makes the refusals
    // below mean something: the same routes work.
    const registered = await demoApp.post(
      `/v1/studies/${tenant.studyId}/runs`,
      registerBody(tenant, 'baseline'),
      { auth: tenant.users.operator.token, headers: { 'idempotency-key': `demo-${uuidv7()}` } },
    );
    expect(registered.status).toBe(201);
    runId = asRun(registered.body).run.id;
  });

  afterAll(async () => {
    await Promise.all([demoApp.close(), limitedApp.close(), unseededApp.close()]);
    await closeTestApp();
    await closeDatabases();
  });

  describe('when demo mode is off', () => {
    it('answers 404, the same as a route that does not exist', async () => {
      // Absent rather than forbidden. A 403 would confirm the route is real and
      // merely switched off, which tells a scanner which deployment to revisit.
      const app = await bootTestApp();
      const response = await app.post('/v1/auth/demo');

      expect(response.status).toBe(404);
      expect(asProblem(response.body).type).toBe(ProblemType.NOT_FOUND);
    });
  });

  describe('the configuration', () => {
    it('permits DEMO_MODE in production, which is the entire point', () => {
      const config = new AppConfig({
        ...requiredEnv(),
        NODE_ENV: 'production',
        DEMO_MODE: 'true',
        AUTH_DEV_TOKEN_ENDPOINT: 'false',
      });

      expect(config.demo.enabled).toBe(true);
    });

    it('still refuses to start a production process with the dev token endpoint on', () => {
      // The guard this feature exists so that nobody has to weaken.
      expect(
        () =>
          new AppConfig({
            ...requiredEnv(),
            NODE_ENV: 'production',
            AUTH_DEV_TOKEN_ENDPOINT: 'true',
          }),
      ).toThrow(/AUTH_DEV_TOKEN_ENDPOINT/);
    });

    it('refuses to start with both sign-in mechanisms enabled', () => {
      expect(
        () =>
          new AppConfig({
            ...requiredEnv(),
            DEMO_MODE: 'true',
            AUTH_DEV_TOKEN_ENDPOINT: 'true',
          }),
      ).toThrow(/must not both be enabled/);
    });
  });

  describe('the demo sign-in', () => {
    it('issues a session for the configured account without being asked who to be', async () => {
      const response = await demoApp.post('/v1/auth/demo');
      const session = asSession(response.body);

      expect(response.status).toBe(200);
      expect(session.demo).toBe(true);
      expect(session.tokenType).toBe('Bearer');
      expect(session.user.email).toBe(tenant.users.steward.email);
      expect(session.user.tenantId).toBe(tenant.tenantId);
      expect(session.user.tenantSlug).toBe(tenant.slug);
    });

    it('ignores a body entirely, so no caller can name a different principal', async () => {
      // The security property in one assertion. The development endpoint would
      // hand back a session for whoever this named.
      const response = await demoApp.post('/v1/auth/demo', {
        email: tenant.users.admin.email,
        tenantSlug: tenant.slug,
      });

      expect(response.status).toBe(200);
      expect(asSession(response.body).user.email).toBe(tenant.users.steward.email);
    });

    it('marks the token itself, not merely the response', () => {
      // The response could say anything; what the guard reads is the signed
      // claim, so that is what has to carry it.
      const claims = verifySession(testConfig().auth.jwtSecret, demoToken);

      expect(claims.demo).toBe(true);
      expect(claims.sub).toBe(tenant.users.steward.id);
      expect(claims.tid).toBe(tenant.tenantId);
    });

    it('leaves an ordinary token unmarked', () => {
      const claims = verifySession(testConfig().auth.jwtSecret, tenant.users.steward.token);

      expect(claims.demo).toBeUndefined();
    });
  });

  describe('a demo session', () => {
    it('reads runs', async () => {
      const response = await demoApp.get(`/v1/runs?studyId=${tenant.studyId}`, {
        auth: demoToken,
      });

      expect(response.status).toBe(200);
      expect(asPage(response.body).items.length).toBeGreaterThan(0);
    });

    it('reads a single run and the audit stream', async () => {
      const run = await demoApp.get(`/v1/runs/${runId}`, { auth: demoToken });
      const audit = await demoApp.get('/v1/audit?limit=5', { auth: demoToken });

      expect(run.status).toBe(200);
      expect(audit.status).toBe(200);
    });

    it('verifies the audit chain, which is a read that happens to need a body', async () => {
      // The one non-GET on the allow-list that a visitor would care about, and
      // the reason the allow-list exists at all rather than a bare method check.
      const response = await demoApp.post('/v1/audit/verify', {}, { auth: demoToken });

      expect(response.status).toBe(200);
      expect(asVerification(response.body).ok).toBe(true);
    });
  });

  describe('every mutating verb under a demo session', () => {
    it('refuses registering a run', async () => {
      const response = await demoApp.post(
        `/v1/studies/${tenant.studyId}/runs`,
        registerBody(tenant, 'forbidden'),
        { auth: demoToken, headers: { 'idempotency-key': `demo-${uuidv7()}` } },
      );

      expectReadOnlyRefusal(response);
    });

    it('refuses sealing a run', async () => {
      const response = await demoApp.post(
        `/v1/runs/${runId}/seal`,
        {},
        { auth: demoToken, headers: { 'idempotency-key': `demo-${uuidv7()}` } },
      );

      expectReadOnlyRefusal(response);
    });

    it('refuses beginning an upload', async () => {
      const response = await demoApp.post(
        `/v1/runs/${runId}/artifacts/ch0/forbidden.tif/upload`,
        undefined,
        { auth: demoToken },
      );

      expectReadOnlyRefusal(response);
    });

    it('refuses revoking a membership', async () => {
      const response = await demoApp.del(
        `/v1/studies/${tenant.studyId}/members/${tenant.users.operator.id}`,
        { auth: demoToken },
      );

      expectReadOnlyRefusal(response);
    });

    it('refuses creating an audit checkpoint, next to the verify it allows', async () => {
      // Same controller, same role requirement, opposite answer. The distinction
      // is what the request does, not who is asking.
      const response = await demoApp.post('/v1/audit/checkpoints', {}, { auth: demoToken });

      expectReadOnlyRefusal(response);
    });

    it('refuses before authorisation is even consulted', async () => {
      // A study this tenant cannot see. An ordinary principal would get a 404 or
      // a 403 about membership; a demo one is stopped by the verb, which is what
      // makes the rule an invariant of the deployment rather than of the data.
      const response = await demoApp.post(`/v1/studies/${uuidv7()}/runs`, {}, { auth: demoToken });

      expectReadOnlyRefusal(response);
    });

    it('permits the same requests under a non-demo token for the same tenant', async () => {
      // Non-vacuity. Without this the suite above would pass just as happily
      // against an application where those routes were broken for everybody.
      const registered = await demoApp.post(
        `/v1/studies/${tenant.studyId}/runs`,
        registerBody(tenant, 'permitted'),
        {
          auth: tenant.users.operator.token,
          headers: { 'idempotency-key': `demo-${uuidv7()}` },
        },
      );

      expect(registered.status).toBe(201);
    });
  });

  describe('the rate limit', () => {
    it('refuses past the configured threshold with a 429 and a Retry-After', async () => {
      const first = await limitedApp.post('/v1/auth/demo');
      const second = await limitedApp.post('/v1/auth/demo');
      const third = await limitedApp.post('/v1/auth/demo');

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(429);

      const problem = asProblem(third.body);
      expect(problem.type).toBe(ProblemType.RATE_LIMITED);
      expect(third.headers['content-type']).toContain('application/problem+json');
      // Without this a client retries immediately and turns the limit into a
      // busy loop against the endpoint it is meant to protect.
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('is per application instance, so the generous instance is unaffected', async () => {
      // Stated as a test because it is the honest limitation: the counter is in
      // one process's memory, so a second replica would allow the limit twice.
      const response = await demoApp.post('/v1/auth/demo');

      expect(response.status).toBe(200);
    });
  });

  describe('when the demo dataset is not seeded', () => {
    it('answers 503 naming the misconfiguration, and never mints a session', async () => {
      const response = await unseededApp.post('/v1/auth/demo');

      expect(response.status).toBe(503);

      const problem = asProblem(response.body);
      expect(problem.type).toBe(ProblemType.DEMO_UNAVAILABLE);
      expect(problem.detail).toContain('DEMO_USER_EMAIL');
      // The failure that would matter: falling back to some other account, or
      // creating the configured one, would publish an identity nobody chose.
      expect(response.body).not.toHaveProperty('token');
    });
  });
});

// ---------------------------------------------------------------------------
// Fixtures and narrowing
// ---------------------------------------------------------------------------

/**
 * The environment the configuration schema requires, minus everything this file
 * is varying.
 *
 * Read from `process.env` rather than written out here, so a new required
 * variable does not turn these three assertions into a maintenance chore that
 * fails for a reason unrelated to demo mode.
 */
function requiredEnv(): NodeJS.ProcessEnv {
  return { ...process.env, DEMO_MODE: 'false', AUTH_DEV_TOKEN_ENDPOINT: 'false' };
}

function registerBody(tenant: ProvisionedTenant, label: string): Record<string, unknown> {
  return {
    instrumentId: tenant.instrumentId,
    operatorId: tenant.users.operator.id,
    acquiredAt: '2026-04-02T11:00:00Z',
    protocol: { objective: '20x', channels: ['DAPI'], binning: 1 },
    manifest: [
      {
        logicalName: `ch0/${label}.tif`,
        digest: sha256Hex(`demo-mode/${label}`),
        sizeBytes: '1048576',
        mediaType: 'image/tiff',
      },
    ],
  };
}

/**
 * Every refusal looks the same and says why.
 *
 * Asserting the wording rather than only the status is what distinguishes the
 * demo guard from an ordinary authorisation failure -- a 403 because the demo
 * user lacks a role would satisfy a bare status check while proving nothing
 * about the guard this suite is here for.
 */
function expectReadOnlyRefusal(response: { status: number; body: unknown }): void {
  expect(response.status).toBe(403);

  const problem = asProblem(response.body);
  expect(problem.type).toBe(ProblemType.FORBIDDEN);
  expect(problem.detail).toContain('read-only demo session');
}

interface SessionBody {
  token: string;
  tokenType: string;
  expiresInSeconds: number;
  demo: boolean;
  user: { id: string; email: string; tenantId: string; tenantSlug: string };
}

interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  [extension: string]: unknown;
}

function asSession(body: unknown): SessionBody {
  if (typeof body !== 'object' || body === null || !('token' in body)) {
    throw new Error(`expected an issued session, got ${JSON.stringify(body)}`);
  }
  return body as SessionBody;
}

function asProblem(body: unknown): ProblemBody {
  if (typeof body !== 'object' || body === null || !('type' in body) || !('status' in body)) {
    throw new Error(`expected an RFC 9457 problem document, got ${JSON.stringify(body)}`);
  }
  return body as ProblemBody;
}

function asRun(body: unknown): { run: { id: string; state: string } } {
  if (typeof body !== 'object' || body === null || !('run' in body)) {
    throw new Error(`expected a run mutation result, got ${JSON.stringify(body)}`);
  }
  return body as { run: { id: string; state: string } };
}

function asPage(body: unknown): { items: unknown[] } {
  if (typeof body !== 'object' || body === null || !('items' in body)) {
    throw new Error(`expected a page, got ${JSON.stringify(body)}`);
  }
  return body as { items: unknown[] };
}

function asVerification(body: unknown): { ok: boolean } {
  if (typeof body !== 'object' || body === null || !('ok' in body)) {
    throw new Error(`expected a chain verification result, got ${JSON.stringify(body)}`);
  }
  return body as { ok: boolean };
}
