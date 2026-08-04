import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service';
import {
  ArtifactTooLargeError,
  ForbiddenError,
  SandboxExpiredError,
  SandboxQuotaExceededError,
} from '../common/problem-details';
import { uuidv7 } from '../common/uuid';
import { AppConfig } from '../config/config';
import { DatabaseService, applySessionContext } from '../database/database.service';
import type { Trx } from '../database/database.service';
import type { RequestContext } from '../database/request-context';
import type { TenantKind } from '../database/schema';
import { generateApiKey } from './credentials';
import { signSession } from './tokens';

/**
 * Provisioning, accounting and enforcement for ephemeral sandbox tenants.
 *
 * The public demo (ADR-0020) hands a visitor a read-only session over a
 * pre-seeded dataset. That shows what the system holds; it cannot show what the
 * system *does*, and what it does is the interesting part -- refuse bytes that
 * disagree with their declaration, quarantine the run that declared them, and
 * record every step of it in a chain nobody can rewrite. Nobody is convinced by
 * a recording of software catching its own planted fault. So this mints an
 * ordinary operator session over a tenant that did not exist a moment ago and
 * will not exist in an hour, and lets the visitor try it.
 *
 * The session it issues is **not** a demo session. `Principal.isDemo` stays
 * false, `DemoReadOnlyGuard` does not apply, and every ordinary role check runs
 * exactly as it does for a paying tenant -- which is the point: a sandbox that
 * reached the interesting paths by relaxing the guards would demonstrate that
 * the guards are negotiable, not that the system works.
 *
 * Containment is therefore not a role. It is three separate things:
 *
 *   - the tenant is empty except for what this session puts in it, and tenant
 *     isolation is enforced below the application, so there is nothing else to
 *     reach;
 *   - a quota, enforced by `SandboxQuotaGuard` on the way in and by
 *     `assertDeclarationsWithinQuota` at the moment a manifest is declared;
 *   - an expiry, after which `SandboxReaper` deletes the tenant outright.
 *
 * Deletion is the part that needs justifying, and migration 0008 justifies it:
 * a sandbox is by construction not the record, so the ALCOA+ demand that a
 * record be Enduring has nothing to attach to.
 */

/** Bytes are decimal strings throughout this API; a byte count is a bigint. */
export interface SandboxQuota {
  maxRuns: number;
  maxArtifactBytes: string;
  maxTotalBytes: string;
}

export interface SandboxUsage {
  runs: number;
  totalBytes: string;
}

export interface SandboxDescriptor {
  tenantId: string;
  tenantSlug: string;
  studyId: string;
  instrumentId: string;
  operatorId: string;
  /** ISO 8601. When the reaper takes it, which is not when the token expires. */
  expiresAt: string;
  quota: SandboxQuota;
}

export interface ProvisionedSandbox {
  token: string;
  tokenType: 'Bearer';
  expiresInSeconds: number;
  /** Token expiry. Deliberately a different clock from `sandbox.expiresAt`. */
  expiresAt: string;
  /** Sequence number of the `sandbox.provisioned` event. Always `"1"`. */
  auditSeq: string;
  sandbox: SandboxDescriptor;
}

export interface SandboxStatus extends SandboxDescriptor {
  used: SandboxUsage;
}

/** What the quota guard needs, in one row. */
export interface SandboxState {
  expiresAt: Date;
  runs: number;
  totalBytes: bigint;
}

/**
 * Slug attempts before giving up.
 *
 * The slug carries 32 bits, so a collision needs two live sandboxes to draw the
 * same four bytes. Three attempts takes the probability of failing a request
 * over it below anything worth thinking about, and the retry is free -- the
 * insert uses ON CONFLICT DO NOTHING, so a collision costs one round trip rather
 * than aborting the transaction that already holds the study and the operator.
 */
const SLUG_ATTEMPTS = 3;

const STUDY_SLUG = 'sandbox';
const INSTRUMENT_SLUG = 'sandbox-instrument';
const OPERATOR_LABEL = 'Sandbox operator';

interface StateRow {
  kind: TenantKind;
  expires_at: Date | null;
  runs: string;
  total_bytes: string;
}

interface DescriptorRow {
  slug: string;
  kind: TenantKind;
  expires_at: Date | null;
  study_id: string;
  instrument_id: string;
}

@Injectable()
export class SandboxService {
  /**
   * Tenants already established to be permanent.
   *
   * Only the permanent answer is remembered, and the asymmetry is deliberate.
   * `kind` never changes and a tenant id is never reused, so "permanent" is true
   * forever and the map is bounded by the number of real tenants this process
   * has served. Remembering "sandbox" would instead grow the map once per
   * sandbox ever provisioned, for entries that are wrong the moment the reaper
   * runs -- a leak sized by traffic, in exchange for saving a query on the one
   * path that is already doing several.
   */
  private readonly knownPermanent = new Set<string>();

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Create a tenant, a study, an operator, an instrument and the grants that
   * join them -- in one transaction, and mint a session for the operator.
   *
   * Partial provisioning is the failure this shape exists to make impossible. A
   * tenant with no study is a session that can do nothing; an instrument with no
   * study grant is a run registration that 403s on a resource the caller was
   * just handed. Either would be reported as "the sandbox is broken", by
   * somebody with no way to tell which half was missing.
   *
   * `withoutTenantScope` rather than `withTenant`, and it is the third caller of
   * a method whose comment says there should not be one without an argument.
   * Here is the argument: creating a tenant is not an operation *within* a
   * tenant. There is no `app.tenant_id` that could be set when the transaction
   * opens, because the value does not exist yet -- it is the output. The moment
   * it does exist, `applySessionContext` sets it and every remaining insert runs
   * under row-level security like any other write, so the unscoped window covers
   * exactly one statement: the one that creates the scope.
   *
   * That one statement is a `SECURITY DEFINER` function rather than an INSERT,
   * because `aliquot_app` holds SELECT and nothing else on `aliquot.tenant`.
   * Granting it INSERT so that this method could work would give the API the
   * ability to create permanent tenants; the function can only create sandboxes.
   * There is no admin pool in this process to reach for instead -- the login
   * role is NOINHERIT and unprivileged by design (ADR-0016), and adding a
   * privileged pool to the API would undo the assertion `DatabaseService` makes
   * at startup.
   */
  async provision(correlationId: string): Promise<ProvisionedSandbox> {
    // scrypt costs tens of milliseconds and a pooled connection held through it
    // is a connection nobody else can use, so the credential is derived before
    // the transaction opens -- the same reason `registerInstrument` does.
    const credential = await generateApiKey();

    const studyId = uuidv7();
    const operatorId = uuidv7();
    const instrumentId = uuidv7();

    return this.database.withoutTenantScope('aliquot_app', async (trx) => {
      const tenant = await this.createTenant(trx);

      const ctx: RequestContext = {
        tenantId: tenant.id,
        actorType: 'user',
        actorId: operatorId,
        actorLabel: OPERATOR_LABEL,
        correlationId,
        dbRole: 'aliquot_app',
      };
      await applySessionContext(trx, ctx);

      await trx
        .insertInto('aliquot.app_user')
        .values({
          id: operatorId,
          tenant_id: tenant.id,
          // `.invalid` is reserved by RFC 2606 and can never resolve. A sandbox
          // account is synthetic and must not be capable of receiving mail even
          // if something downstream one day decides to send some.
          email: `operator@${tenant.slug}.invalid`,
          display_name: OPERATOR_LABEL,
        })
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('aliquot.study')
        .values({
          id: studyId,
          tenant_id: tenant.id,
          slug: STUDY_SLUG,
          title: 'Sandbox study',
          description:
            'An ephemeral study in an ephemeral tenant. Everything here is deleted when the ' +
            'sandbox expires; nothing in it is part of the enduring record.',
        })
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('aliquot.instrument')
        .values({
          id: instrumentId,
          tenant_id: tenant.id,
          slug: INSTRUMENT_SLUG,
          display_name: 'Sandbox instrument',
          manufacturer: null,
          model: null,
          serial_number: null,
          // Generated and immediately forgotten. `api_key_hash` is NOT NULL and
          // `api_key_prefix` is globally unique, so the row needs a real
          // credential; the plaintext is not returned because the sandbox is
          // driven by the session token and an instrument key handed to an
          // anonymous visitor is a long-lived secret with no revocation story.
          api_key_hash: credential.hash,
          api_key_prefix: credential.prefix,
        })
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('aliquot.membership')
        .values({
          id: uuidv7(),
          tenant_id: tenant.id,
          study_id: studyId,
          user_id: operatorId,
          // Operator, not admin. The sandbox exists to exercise the ingestion
          // lifecycle, and an operator is the principal that actually performs
          // it; handing out admin would make the sandbox a demonstration of a
          // role nobody uses to acquire data.
          // Admin, not operator, and it is theirs to hold: this tenant exists for
          // one visitor and dies with them. Operator can register runs but not
          // verify a chain -- `POST /v1/audit/verify` requires steward or admin
          // -- which would leave a visitor able to watch the audit chain grow
          // from their own upload and unable to ask whether it is intact. That
          // is the one question the whole exercise builds towards.
          //
          // The privilege is bounded by the tenant, not by the role: everything
          // an admin can reach here belongs to a sandbox that is quota-capped,
          // rate-limited and reaped. See SandboxQuotaGuard for the write cap
          // that stops `admin` meaning "create ten thousand instruments".
          role: 'admin',
          granted_by: operatorId,
        })
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('aliquot.instrument_study_grant')
        .values({
          tenant_id: tenant.id,
          instrument_id: instrumentId,
          study_id: studyId,
          granted_by: operatorId,
        })
        .executeTakeFirstOrThrow();

      const issued = signSession(this.config.auth.jwtSecret, {
        userId: operatorId,
        tenantId: tenant.id,
        ttlSeconds: this.config.auth.tokenTtlSeconds,
        // Emphatically absent. A demo session is refused on every mutating verb,
        // and a sandbox whose session could not write would be a slower demo.
      });

      const quota = this.quota();
      const event = await this.audit.append(trx, ctx, {
        action: 'sandbox.provisioned',
        targetType: 'tenant',
        targetId: tenant.id,
        payload: {
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          studyId,
          instrumentId,
          operatorId,
          expiresAt: tenant.expiresAt.toISOString(),
          sessionId: issued.claims.jti,
          quota: { ...quota },
        },
      });

      return {
        token: issued.token,
        tokenType: 'Bearer' as const,
        expiresInSeconds: this.config.auth.tokenTtlSeconds,
        expiresAt: new Date(issued.claims.exp * 1000).toISOString(),
        // Always 1, by construction: the tenant did not exist when this
        // transaction opened. A visitor watching the chain grow sees it from
        // genesis, which is the one thing the seeded demo cannot show.
        auditSeq: event.seq,
        sandbox: {
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          studyId,
          instrumentId,
          operatorId,
          expiresAt: tenant.expiresAt.toISOString(),
          quota,
        },
      };
    });
  }

  /** The sandbox behind this session, with what it has spent so far. */
  async describe(ctx: RequestContext): Promise<SandboxStatus> {
    return this.database.withTenant(ctx, async (trx) => {
      const tenant = await sql<DescriptorRow>`
        select t.slug,
               t.kind,
               t.expires_at,
               (select s.id from aliquot.study s      where s.tenant_id = t.id order by s.id limit 1)
                 as study_id,
               (select i.id from aliquot.instrument i where i.tenant_id = t.id order by i.id limit 1)
                 as instrument_id
          from aliquot.tenant t
         where t.id = ${ctx.tenantId}::uuid
      `.execute(trx);

      const row = tenant.rows[0];
      if (row === undefined || row.kind !== 'sandbox' || row.expires_at === null) {
        throw new ForbiddenError(
          'This session belongs to a permanent tenant, which has no sandbox to describe. ' +
            'POST /v1/sandbox issues a session that does.',
          'a sandbox session',
        );
      }

      const used = await usageWithin(trx, ctx.tenantId);

      return {
        tenantId: ctx.tenantId,
        tenantSlug: row.slug,
        // A sandbox has exactly one of each by construction, so the ids are read
        // back rather than stored: a column pointing at "the sandbox study"
        // would be a second source of truth that a later change could desync.
        studyId: row.study_id,
        instrumentId: row.instrument_id,
        operatorId: ctx.actorId ?? '',
        expiresAt: row.expires_at.toISOString(),
        quota: this.quota(),
        used: { runs: used.runs, totalBytes: used.totalBytes.toString() },
      };
    });
  }

  /** Runs registered and artifact bytes stored, for this tenant. */
  async usage(ctx: RequestContext): Promise<SandboxUsage> {
    const used = await this.database.withTenant(ctx, (trx) => usageWithin(trx, ctx.tenantId));
    return { runs: used.runs, totalBytes: used.totalBytes.toString() };
  }

  /**
   * Kind, expiry and usage in one statement, or null for a permanent tenant.
   *
   * One statement rather than "is this a sandbox?" followed by "what has it
   * spent?": the guard needs both on every mutating request from a sandbox, and
   * two round trips on the hot path to answer one question is a cost paid on
   * every request to save nothing.
   */
  async state(ctx: RequestContext): Promise<SandboxState | null> {
    if (this.knownPermanent.has(ctx.tenantId)) {
      return null;
    }

    const state = await this.database.withTenant(ctx, async (trx) => {
      const result = await sql<StateRow>`
        select t.kind,
               t.expires_at,
               (select count(*) from aliquot.run r where r.tenant_id = t.id)::text
                 as runs,
               (select coalesce(sum(a.size_bytes), 0) from aliquot.artifact a
                 where a.tenant_id = t.id)::text
                 as total_bytes
          from aliquot.tenant t
         where t.id = ${ctx.tenantId}::uuid
      `.execute(trx);

      return result.rows[0] ?? null;
    });

    if (state === null || state.kind !== 'sandbox' || state.expires_at === null) {
      // A tenant that has vanished is remembered as permanent too, and that is
      // harmless: it has no rows left to protect and nothing will ever
      // authenticate against it again.
      this.knownPermanent.add(ctx.tenantId);
      return null;
    }

    return {
      expiresAt: state.expires_at,
      runs: Number(state.runs),
      totalBytes: BigInt(state.total_bytes),
    };
  }

  /**
   * Refuse a request that a sandbox has no allowance left for.
   *
   * Called by `SandboxQuotaGuard` before the handler runs, with the state it
   * already read. Expiry first: a caller whose sandbox has gone needs to be told
   * that and not which quota they were near.
   */
  /**
   * Mutating requests seen per sandbox, whatever they mutated.
   *
   * In memory, and therefore per instance -- which is correct for a
   * single-container deployment and would need moving to the database behind
   * more than one. The entry dies with the process; a sandbox outlives it only
   * until the reaper runs, and a restart handing a visitor a fresh allowance is
   * a smaller problem than a shared counter would be.
   */
  private readonly writes = new Map<string, number>();

  /**
   * Count one mutating request, and refuse once a sandbox has had its share.
   *
   * The run and byte quotas bound what is expensive to store. This bounds what
   * is merely cheap to create: the session holds `admin` over its own tenant, so
   * nothing else stops a visitor minting instruments until the TTL expires.
   */
  countWrite(tenantId: string): void {
    const seen = (this.writes.get(tenantId) ?? 0) + 1;
    this.writes.set(tenantId, seen);

    const limit = this.config.sandbox.maxWrites;
    if (seen > limit) {
      throw new SandboxQuotaExceededError(
        'writes',
        BigInt(seen),
        BigInt(limit),
        `This sandbox has made its ${limit} changes. Start a new sandbox with ` +
          'POST /v1/sandbox to keep going.',
      );
    }
  }

  /** Called by the reaper so a reaped tenant does not sit in the map forever. */
  forgetWrites(tenantId: string): void {
    this.writes.delete(tenantId);
  }

  assertWithinQuota(state: SandboxState): void {
    if (state.expiresAt.getTime() <= Date.now()) {
      throw new SandboxExpiredError(state.expiresAt);
    }

    const maxRuns = this.config.sandbox.maxRuns;
    if (state.runs >= maxRuns) {
      throw new SandboxQuotaExceededError(
        'runs',
        BigInt(state.runs),
        BigInt(maxRuns),
        `This sandbox has registered its ${maxRuns} runs. Start a new sandbox with ` +
          'POST /v1/sandbox to keep going.',
      );
    }

    const maxTotalBytes = BigInt(this.config.sandbox.maxTotalBytes);
    if (state.totalBytes >= maxTotalBytes) {
      throw new SandboxQuotaExceededError(
        'totalBytes',
        state.totalBytes,
        maxTotalBytes,
        `This sandbox has stored ${state.totalBytes.toString()} of ${maxTotalBytes.toString()} ` +
          'permitted bytes. Start a new sandbox with POST /v1/sandbox to keep going.',
      );
    }
  }

  /**
   * Refuse a manifest that declares an artifact larger than a sandbox may hold.
   *
   * This runs at registration, against the *declared* size, before any presigned
   * URL exists. Enforcing it at upload completion instead would mean the bytes
   * are already in the bucket when they are refused, which is not a quota -- it
   * is a report on one. A caller who lies about the size is caught anyway, by
   * the digest and length check that verification already performs.
   *
   * A no-op for a permanent tenant, and a no-op for every deployment with
   * `SANDBOX_MODE` off, so the ingestion path pays nothing to have it.
   */
  async assertDeclarationsWithinQuota(
    ctx: RequestContext,
    entries: readonly { logicalName: string; sizeBytes: string }[],
  ): Promise<void> {
    if (!this.config.sandbox.enabled || this.knownPermanent.has(ctx.tenantId)) {
      return;
    }
    if ((await this.kindOf(ctx)) !== 'sandbox') {
      return;
    }

    const limit = BigInt(this.config.sandbox.maxArtifactBytes);
    for (const entry of entries) {
      const declared = BigInt(entry.sizeBytes);
      if (declared > limit) {
        throw new ArtifactTooLargeError(entry.logicalName, declared, limit);
      }
    }
  }

  private async kindOf(ctx: RequestContext): Promise<TenantKind> {
    if (this.knownPermanent.has(ctx.tenantId)) {
      return 'permanent';
    }

    const row = await this.database.withTenant(ctx, (trx) =>
      trx
        .selectFrom('aliquot.tenant')
        .select('kind')
        .where('id', '=', ctx.tenantId)
        .executeTakeFirst(),
    );

    const kind = row?.kind ?? 'permanent';
    if (kind === 'permanent') {
      this.knownPermanent.add(ctx.tenantId);
    }
    return kind;
  }

  private quota(): SandboxQuota {
    return {
      maxRuns: this.config.sandbox.maxRuns,
      maxArtifactBytes: this.config.sandbox.maxArtifactBytes.toString(),
      maxTotalBytes: this.config.sandbox.maxTotalBytes.toString(),
    };
  }

  private async createTenant(trx: Trx): Promise<{ id: string; slug: string; expiresAt: Date }> {
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
      const id = uuidv7();
      const slug = `sandbox-${randomBytes(4).toString('hex')}`;

      const created = await sql<{ id: string; slug: string; expires_at: Date | null }>`
        select id, slug, expires_at
          from aliquot.provision_sandbox_tenant(
            ${id}::uuid,
            ${slug},
            ${`Sandbox ${slug.slice('sandbox-'.length)}`},
            ${this.config.sandbox.ttlMinutes}
          )
      `.execute(trx);

      const row = created.rows[0];
      if (row === undefined) {
        // ON CONFLICT DO NOTHING returned nothing: the slug is taken by a
        // sandbox that has not been reaped yet. Draw again.
        continue;
      }
      if (row.expires_at === null) {
        // Unreachable while `tenant_expiry_matches_kind` holds. Checked because
        // the alternative is a sandbox with no expiry, which is a sandbox that
        // is never reaped -- the one outcome this whole file exists to prevent.
        throw new Error(`sandbox tenant ${row.id} was created without an expiry`);
      }

      return { id: row.id, slug: row.slug, expiresAt: row.expires_at };
    }

    throw new Error(
      `could not allocate a free sandbox slug in ${SLUG_ATTEMPTS} attempts; ` +
        'either an implausible run of collisions or the reaper has stopped running',
    );
  }
}

async function usageWithin(
  trx: Trx,
  tenantId: string,
): Promise<{ runs: number; totalBytes: bigint }> {
  const result = await sql<{ runs: string; total_bytes: string }>`
    select (select count(*) from aliquot.run r where r.tenant_id = ${tenantId}::uuid)::text
             as runs,
           (select coalesce(sum(a.size_bytes), 0) from aliquot.artifact a
             where a.tenant_id = ${tenantId}::uuid)::text
             as total_bytes
  `.execute(trx);

  const row = result.rows[0];
  // Both aggregates are over a scalar subquery, so exactly one row always comes
  // back; the branch exists because the driver's type does not say so.
  if (row === undefined) {
    return { runs: 0, totalBytes: 0n };
  }

  // BigInt, never Number: `size_bytes` is a bigint and arrives as a string
  // precisely so that a hundred-terabyte tenant does not silently round.
  return { runs: Number(row.runs), totalBytes: BigInt(row.total_bytes) };
}
