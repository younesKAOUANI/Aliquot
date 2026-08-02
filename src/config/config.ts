import { Injectable } from '@nestjs/common';
import { z } from 'zod';

/**
 * Configuration is parsed once, at startup, into a frozen object.
 *
 * Nothing in this service reads `process.env` after boot. A missing or
 * malformed variable is a startup failure with the variable named, not an
 * `undefined` that surfaces three hours later as a connection string of
 * "undefined" in a log line.
 */

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_ROLE: z.enum(['api', 'worker']).default('api'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(10),
  DATABASE_LOG_QUERIES: z.stringbool().default(false),

  STORAGE_ENDPOINT: z.string().url(),
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_BUCKET: z.string().min(3),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  /** MinIO needs path-style; real S3 does not. */
  STORAGE_FORCE_PATH_STYLE: z.stringbool().default(true),
  /**
   * Presigned URLs are capability tokens: anyone holding one can write those
   * bytes. Short enough to bound that exposure, long enough that a 5 GiB part
   * on a lab network finishes. One hour is the compromise, and it is the
   * dominant reason uploads are chunked rather than single-shot -- a resumable
   * upload can mint fresh URLs, a single 800 GB PUT cannot.
   */
  STORAGE_PRESIGN_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  STORAGE_PART_SIZE_BYTES: z.coerce
    .number()
    .int()
    .min(5 * 1024 * 1024)
    .default(64 * 1024 * 1024),

  /** HS256 secret for user session tokens. Development convenience -- see AUTH.md. */
  AUTH_JWT_SECRET: z.string().min(32),
  AUTH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(3600),
  /** Enables POST /v1/auth/token, which mints a session without an IdP. Never in production. */
  AUTH_DEV_TOKEN_ENDPOINT: z.stringbool().default(false),

  /**
   * Enables POST /v1/auth/demo, and it is allowed in production on purpose.
   *
   * The distinction from `AUTH_DEV_TOKEN_ENDPOINT` is not one of degree. That
   * endpoint takes an email address and mints a session for whoever it names,
   * so its reachability is the whole of the authentication boundary. This one
   * takes no input at all: the tenant, the account and the lifetime are fixed
   * below, and a session it issues is refused on every mutating verb by
   * `DemoReadOnlyGuard`. There is nothing a caller can influence and no way to
   * enumerate accounts, which is what makes it publishable. See ADR-0020.
   */
  DEMO_MODE: z.stringbool().default(false),
  DEMO_TENANT_SLUG: z.string().min(1).max(63).default('acme'),
  /**
   * The seeded steward on the `acme` study; see `scripts/seed.ts`.
   *
   * Steward rather than scientist on purpose. `POST /v1/audit/verify` requires
   * steward or admin, and chain verification is the single most worth-seeing
   * thing on a public deployment -- pointing the demo at a scientist leaves the
   * demo guard allowing the call and the role check refusing it.
   */
  DEMO_USER_EMAIL: z.email().max(320).default('priya.venkat@acme.test'),
  DEMO_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  DEMO_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(20),

  IDEMPOTENCY_RETENTION_HOURS: z.coerce.number().int().min(1).default(24),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(10).default(300),

  AUDIT_CHECKPOINT_INTERVAL_MS: z.coerce.number().int().min(1000).default(300_000),
  AUDIT_CHECKPOINT_MIN_EVENTS: z.coerce.number().int().min(1).default(50),
});

export type Env = z.infer<typeof schema>;

@Injectable()
export class AppConfig {
  readonly env: Env['NODE_ENV'];
  readonly serviceRole: Env['SERVICE_ROLE'];
  readonly port: number;
  readonly logLevel: Env['LOG_LEVEL'];

  readonly database: {
    url: string;
    poolSize: number;
    logQueries: boolean;
    role: 'aliquot_app' | 'aliquot_worker';
  };

  readonly storage: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    presignTtlSeconds: number;
    partSizeBytes: number;
  };

  readonly auth: {
    jwtSecret: string;
    tokenTtlSeconds: number;
    devTokenEndpoint: boolean;
  };

  readonly demo: {
    enabled: boolean;
    tenantSlug: string;
    userEmail: string;
    tokenTtlSeconds: number;
    rateLimitPerMinute: number;
  };

  readonly idempotency: { retentionHours: number };

  readonly worker: {
    concurrency: number;
    pollIntervalMs: number;
    leaseSeconds: number;
  };

  readonly checkpoint: { intervalMs: number; minEvents: number };

  constructor(source: NodeJS.ProcessEnv = process.env) {
    const parsed = schema.safeParse(source);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `  ${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('\n');
      throw new Error(`invalid configuration:\n${issues}`);
    }

    const env = parsed.data;

    this.env = env.NODE_ENV;
    this.serviceRole = env.SERVICE_ROLE;
    this.port = env.PORT;
    this.logLevel = env.LOG_LEVEL;

    this.database = {
      url: env.DATABASE_URL,
      poolSize: env.DATABASE_POOL_SIZE,
      logQueries: env.DATABASE_LOG_QUERIES,
      role: env.SERVICE_ROLE === 'worker' ? 'aliquot_worker' : 'aliquot_app',
    };

    this.storage = {
      endpoint: env.STORAGE_ENDPOINT,
      region: env.STORAGE_REGION,
      bucket: env.STORAGE_BUCKET,
      accessKeyId: env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
      forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
      presignTtlSeconds: env.STORAGE_PRESIGN_TTL_SECONDS,
      partSizeBytes: env.STORAGE_PART_SIZE_BYTES,
    };

    this.auth = {
      jwtSecret: env.AUTH_JWT_SECRET,
      tokenTtlSeconds: env.AUTH_TOKEN_TTL_SECONDS,
      devTokenEndpoint: env.AUTH_DEV_TOKEN_ENDPOINT,
    };

    this.demo = {
      enabled: env.DEMO_MODE,
      tenantSlug: env.DEMO_TENANT_SLUG,
      userEmail: env.DEMO_USER_EMAIL,
      tokenTtlSeconds: env.DEMO_TOKEN_TTL_SECONDS,
      rateLimitPerMinute: env.DEMO_RATE_LIMIT_PER_MINUTE,
    };

    this.idempotency = { retentionHours: env.IDEMPOTENCY_RETENTION_HOURS };

    this.worker = {
      concurrency: env.WORKER_CONCURRENCY,
      pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
      leaseSeconds: env.WORKER_LEASE_SECONDS,
    };

    this.checkpoint = {
      intervalMs: env.AUDIT_CHECKPOINT_INTERVAL_MS,
      minEvents: env.AUDIT_CHECKPOINT_MIN_EVENTS,
    };

    // A development-only credential minting endpoint reachable in production is
    // a total authentication bypass. Refusing to start is the only response
    // proportionate to that.
    if (this.env === 'production' && this.auth.devTokenEndpoint) {
      throw new Error('AUTH_DEV_TOKEN_ENDPOINT must not be enabled when NODE_ENV=production');
    }

    // Two sign-in mechanisms with two different threat models. Running both is
    // never what someone meant: either the deployment is a development one, in
    // which case the demo endpoint adds nothing the dev endpoint does not
    // already do, or it is public, in which case the dev endpoint is an
    // authentication bypass sitting next to the thing that exists to avoid
    // needing one. Refusing to start is how that stays a misconfiguration
    // rather than a discovery.
    if (this.demo.enabled && this.auth.devTokenEndpoint) {
      throw new Error(
        'DEMO_MODE and AUTH_DEV_TOKEN_ENDPOINT must not both be enabled; ' +
          'they are different sign-in mechanisms with different threat models',
      );
    }

    Object.freeze(this.database);
    Object.freeze(this.storage);
    Object.freeze(this.auth);
    Object.freeze(this.demo);
    Object.freeze(this.worker);
    Object.freeze(this.checkpoint);
    Object.freeze(this);
  }
}
