import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from '../../../src/app.module';
import { uuidv7 } from '../../../src/common/uuid';
import type { StudyRole } from '../../../src/database/schema';
import { generateApiKey } from '../../../src/identity/credentials';
import { signSession } from '../../../src/identity/tokens';
import { Logger } from '../../../src/observability/logger';
import { adminDb, createTenant } from './database';
import type { TenantFixture } from './database';
import { testConfig } from './services';

/**
 * The real Nest application, booted once against the Testcontainers
 * dependencies, driven over Fastify's in-process injection.
 *
 * ## Why `inject()` and not a listening socket
 *
 * `app.inject()` builds a synthetic request and response and pushes them through
 * the *same* Fastify pipeline a socket would: routing, middie middleware, the
 * authentication guard, the Zod boundary, the controller, the problem-details
 * filter, serialisation. The only thing it does not exercise is the socket
 * itself, which is Node's code rather than ours and is not what any of these
 * suites are claiming anything about.
 *
 * What binding a port would add is cost and flakiness. Suites in this project
 * share one container set and run sequentially, so a fixed port collides with a
 * previous suite that has not finished closing its listener and an ephemeral
 * port has to be plumbed into every request. Neither buys coverage. Injection
 * also removes the TCP round trip from the concurrency test, which matters:
 * eight `Promise.all` requests through `inject` reach the idempotency claim
 * within microseconds of each other, which is the race the test exists to
 * provoke.
 *
 * Swagger and `@fastify/static` from `src/main.ts` are deliberately absent. They
 * are documentation and a viewer; neither is reachable through a Nest handler,
 * so no guard, filter or controller behaviour changes by omitting them.
 */

export interface TestResponse<T = unknown> {
  status: number;
  /** Lower-cased, array values joined, so a lookup never has to widen its type. */
  headers: Record<string, string>;
  body: T;
}

export interface RequestOptions {
  /** Bearer credential: a user session token or an instrument API key. */
  auth?: string;
  headers?: Record<string, string | string[]>;
  query?: Record<string, string | string[]>;
}

export interface TestApp {
  get<T = unknown>(path: string, options?: RequestOptions): Promise<TestResponse<T>>;
  /** `body` is serialised with `JSON.stringify`, so property order is preserved on the wire. */
  post<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<TestResponse<T>>;
  /** Exact bytes, for tests that care how a body was spelled rather than what it means. */
  postRaw<T = unknown>(
    path: string,
    payload: string,
    options?: RequestOptions,
  ): Promise<TestResponse<T>>;
}

let booting: Promise<TestApp> | undefined;
let application: NestFastifyApplication | undefined;

/** Memoised: one application, one connection pool, one S3 client for the whole run. */
export function bootTestApp(): Promise<TestApp> {
  booting ??= boot();
  return booting;
}

export async function closeTestApp(): Promise<void> {
  if (booting === undefined) return;

  // Awaited rather than discarded: closing while a boot is still in flight
  // leaves the half-built injector holding the pool, and the run then hangs on
  // an open handle instead of failing.
  await booting;
  booting = undefined;

  await application?.close();
  application = undefined;
}

async function boot(): Promise<TestApp> {
  const config = testConfig();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      bodyLimit: 2 * 1024 * 1024,
      genReqId: () => '',
      trustProxy: true,
    }),
    {
      logger: new Logger({
        level: config.logLevel,
        base: { service: 'aliquot', role: 'api-test' },
      }),
      bufferLogs: false,
    },
  );

  // `init()` and not `listen()`. Routes, middleware and lifecycle hooks are all
  // registered by init; only the socket is skipped.
  await app.init();
  application = app;

  return {
    get: (path, options = {}) => send(app, 'GET', path, undefined, options),
    post: (path, body, options = {}) =>
      send(app, 'POST', path, body === undefined ? undefined : JSON.stringify(body), options),
    postRaw: (path, payload, options = {}) => send(app, 'POST', path, payload, options),
  };
}

async function send<T>(
  app: NestFastifyApplication,
  method: 'GET' | 'POST',
  path: string,
  payload: string | undefined,
  options: RequestOptions,
): Promise<TestResponse<T>> {
  const headers = lowerCased(options.headers ?? {});

  if (options.auth !== undefined) {
    headers.authorization = `Bearer ${options.auth}`;
  }
  if (payload !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await app.inject({
    method,
    url: `${path}${queryStringOf(options.query)}`,
    headers,
    ...(payload !== undefined ? { payload } : {}),
  });

  const normalised = normaliseHeaders(response.headers);

  return {
    status: response.statusCode,
    headers: normalised,
    body: decode(normalised['content-type'], response.payload) as T,
  };
}

function lowerCased(headers: Record<string, string | string[]>): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name.toLowerCase()] = value;
  }
  return result;
}

function normaliseHeaders(headers: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const rendered = renderHeader(value);
    if (rendered !== undefined) {
      result[name.toLowerCase()] = rendered;
    }
  }
  return result;
}

/** Node's header map admits strings, numbers and arrays; anything else is not a header we sent. */
function renderHeader(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === 'string');
    return parts.length > 0 ? parts.join(', ') : undefined;
  }
  return undefined;
}

function queryStringOf(query: RequestOptions['query']): string {
  if (query === undefined) return '';

  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const entry of value) params.append(name, entry);
    } else {
      params.append(name, value);
    }
  }

  const rendered = params.toString();
  return rendered.length > 0 ? `?${rendered}` : '';
}

/**
 * The payload as the caller will want to assert on it.
 *
 * Problem documents are `application/problem+json`, so the check is for `json`
 * anywhere in the media type rather than an exact match -- an error body that
 * came back as an opaque string would make every failed assertion read as a
 * shape mismatch instead of naming the status that actually came back.
 */
function decode(contentType: string | undefined, payload: string): unknown {
  if (payload.length === 0) return undefined;
  if (contentType === undefined || !contentType.includes('json')) return payload;

  const parsed: unknown = JSON.parse(payload);
  return parsed;
}

// ---------------------------------------------------------------------------
// Fixtures with usable credentials
// ---------------------------------------------------------------------------

export interface TestUser {
  id: string;
  email: string;
  displayName: string;
  role: StudyRole;
  /** A bearer token, ready for `RequestOptions.auth`. */
  token: string;
}

export interface TestInstrument {
  id: string;
  /** Plaintext `aliq_...` key. Authenticates for real; only its hash is stored. */
  apiKey: string;
  prefix: string;
}

export interface ProvisionedTenant extends TenantFixture {
  /** One user per study role, each holding exactly that role on `studyId`. */
  users: Record<StudyRole, TestUser>;
  instrument: TestInstrument;
}

const STUDY_ROLES: StudyRole[] = ['operator', 'scientist', 'steward', 'admin'];

/**
 * A tenant that can actually be talked to over HTTP.
 *
 * `createTenant()` builds the rows but stores a placeholder `api_key_hash` that
 * no credential can satisfy, and grants one user one role. Both are fine for
 * suites that go straight to SQL and useless for suites that go through the
 * API, so this fills in the difference: a real scrypt-hashed instrument key
 * minted by `src/identity/credentials.ts`, and a user per role so that an
 * authorisation outcome can be attributed to the role rather than to the
 * fixture happening to be an admin.
 */
export async function provisionTenant(label: string): Promise<ProvisionedTenant> {
  const fixture = await createTenant(label);
  const db = adminDb();

  // Generated and hashed exactly as `IdentityService.registerInstrument` does.
  // Writing a hash by any other route would test a credential path that
  // production never takes.
  const credential = await generateApiKey();
  await db
    .updateTable('aliquot.instrument')
    .set({ api_key_hash: credential.hash, api_key_prefix: credential.prefix })
    .where('id', '=', fixture.instrumentId)
    .execute();

  const users: Partial<Record<StudyRole, TestUser>> = {};

  // createTenant's own user is already an admin on the study; reusing it keeps
  // `fixture.userId` meaningful rather than leaving a fifth user nobody uses.
  users.admin = {
    id: fixture.userId,
    email: `operator@${fixture.slug}.test`,
    displayName: `Operator (${label})`,
    role: 'admin',
    token: tokenFor(fixture.userId, fixture.tenantId),
  };

  for (const role of STUDY_ROLES) {
    if (role === 'admin') continue;

    const id = uuidv7();
    // Suffixed rather than bare: createTenant() already inserted a user at
    // `operator@<slug>.test` and reused it as the admin above, so a bare
    // `operator@...` here collides on app_user_email_unique_per_tenant.
    const email = `${role}-role@${fixture.slug}.test`;
    const displayName = `${role} (${label})`;

    await db
      .insertInto('aliquot.app_user')
      .values({ id, tenant_id: fixture.tenantId, email, display_name: displayName })
      .execute();

    await db
      .insertInto('aliquot.membership')
      .values({
        id: uuidv7(),
        tenant_id: fixture.tenantId,
        study_id: fixture.studyId,
        user_id: id,
        role,
      })
      .execute();

    users[role] = { id, email, displayName, role, token: tokenFor(id, fixture.tenantId) };
  }

  return {
    ...fixture,
    users: complete(users),
    instrument: { id: fixture.instrumentId, apiKey: credential.key, prefix: credential.prefix },
  };
}

/**
 * Sign a session token directly rather than calling `POST /v1/auth/token`.
 *
 * Both work -- the dev endpoint is enabled in the harness. Signing is chosen
 * because it has fewer moving parts *and* fewer side effects. The endpoint
 * appends a `session.issued` audit event per call, so the number of tokens a
 * suite happens to mint would show up in another suite's chain-length
 * assertions; and it resolves the user by email and tenant slug, which is two
 * more fixture details that have to stay in step with the database.
 *
 * Nothing is lost by skipping it. The part of the token path that can actually
 * break is verification, and that runs on every single request in this suite:
 * `AuthGuard` calls `verifySession` and then re-reads the `app_user` row. The
 * endpoint itself belongs to the identity surface and is tested there.
 */
export function tokenFor(userId: string, tenantId: string): string {
  const config = testConfig();
  return signSession(config.auth.jwtSecret, {
    userId,
    tenantId,
    ttlSeconds: config.auth.tokenTtlSeconds,
  }).token;
}

function complete(users: Partial<Record<StudyRole, TestUser>>): Record<StudyRole, TestUser> {
  const result: Partial<Record<StudyRole, TestUser>> = {};

  for (const role of STUDY_ROLES) {
    const user = users[role];
    if (user === undefined) {
      throw new Error(`tenant fixture is missing a ${role} user`);
    }
    result[role] = user;
  }

  return result as Record<StudyRole, TestUser>;
}
