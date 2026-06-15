import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service';
import { buildPage, decodeCursor } from '../common/cursor';
import type { Page } from '../common/cursor';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../common/problem-details';
import { isUuid, uuidv7 } from '../common/uuid';
import { AppConfig } from '../config/config';
import { DatabaseService, applySessionContext } from '../database/database.service';
import type { Trx } from '../database/database.service';
import type { RequestContext } from '../database/request-context';
import { systemContext } from '../database/request-context';
import type { StudyRole } from '../database/schema';
import { INSTRUMENT_ROLE } from './auth.service';
import { generateApiKey } from './credentials';
import { TenantRegistry } from './tenant-registry';
import { signSession } from './tokens';

/**
 * Administration of tenants' own identity data: instruments, studies, members.
 *
 * Authorisation is not done here. The controller establishes what the caller may
 * do before calling in, which keeps this file about what the operations *are*
 * and leaves one place -- `AuthService` -- that answers who may do them.
 *
 * Two conventions run through all of it:
 *
 *   - Every state change and the audit event describing it commit together, in
 *     one transaction. An audit trail that can disagree with the data it
 *     describes is worse than none, because it is trusted.
 *   - A request that changes nothing appends nothing, and reports `auditSeq:
 *     null`. Re-granting a role somebody already holds is not an event; the
 *     chain records history, not traffic.
 */

export interface RegisterInstrumentInput {
  slug: string;
  displayName: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
}

export interface RegisteredInstrument {
  id: string;
  slug: string;
  displayName: string;
  createdAt: Date;
  /**
   * Plaintext, returned exactly once.
   *
   * Only a hash is stored, so there is no path that recovers this value -- not
   * for the caller, not for an administrator, not for us. A lost key is replaced
   * by rotation, which is the same operation as compromise recovery and is
   * therefore a path that stays exercised.
   */
  apiKey: string;
  apiKeyPrefix: string;
  auditSeq: string;
}

export interface RotatedInstrumentKey {
  instrumentId: string;
  apiKey: string;
  apiKeyPrefix: string;
  previousApiKeyPrefix: string;
  auditSeq: string;
}

export interface StudyView {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  createdAt: Date;
  closedAt: Date | null;
  /** The caller's own standing on this study, not a property of the study. */
  role: StudyRole;
}

export interface CreatedStudy extends StudyView {
  auditSeq: string;
}

export interface MemberView {
  /** Identifies the grant rather than the person; it is what the cursor pages on. */
  membershipId: string;
  userId: string;
  email: string;
  displayName: string;
  role: StudyRole;
  grantedAt: Date;
  grantedBy: string | null;
  revokedAt: Date | null;
  disabled: boolean;
}

export interface MembershipGrant {
  studyId: string;
  userId: string;
  role: StudyRole;
  /** The role held before this call, or null when there was no prior membership. */
  previousRole: StudyRole | null;
  userCreated: boolean;
  auditSeq: string | null;
}

export interface MembershipRevocation {
  studyId: string;
  userId: string;
  revokedAt: Date;
  auditSeq: string;
}

export interface InstrumentStudyGrant {
  studyId: string;
  instrumentId: string;
  created: boolean;
  auditSeq: string | null;
}

export interface IssuedSession {
  token: string;
  tokenType: 'Bearer';
  expiresInSeconds: number;
  expiresAt: string;
  user: { id: string; email: string; displayName: string; tenantId: string; tenantSlug: string };
  auditSeq: string;
}

export interface PageQuery {
  limit: number;
  cursor?: string;
}

export interface MemberQuery extends PageQuery {
  includeRevoked: boolean;
}

export interface GrantMembershipInput {
  userId?: string;
  email?: string;
  displayName?: string;
  role: StudyRole;
}

@Injectable()
export class IdentityService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly registry: TenantRegistry,
  ) {}

  async registerInstrument(
    ctx: RequestContext,
    input: RegisterInstrumentInput,
  ): Promise<RegisteredInstrument> {
    // Derived before the transaction opens. scrypt costs tens of milliseconds,
    // and holding a pooled connection through them is a connection nobody else
    // can use.
    const credential = await generateApiKey();
    const id = uuidv7();

    return this.database.withTenant(ctx, async (trx) => {
      const instrument = await trx
        .insertInto('aliquot.instrument')
        .values({
          id,
          tenant_id: ctx.tenantId,
          slug: input.slug,
          display_name: input.displayName,
          manufacturer: input.manufacturer ?? null,
          model: input.model ?? null,
          serial_number: input.serialNumber ?? null,
          api_key_hash: credential.hash,
          api_key_prefix: credential.prefix,
        })
        .returning(['id', 'slug', 'display_name', 'created_at'])
        .executeTakeFirstOrThrow();

      const event = await this.audit.append(trx, ctx, {
        action: 'instrument.registered',
        targetType: 'instrument',
        targetId: id,
        payload: {
          instrumentId: id,
          slug: input.slug,
          displayName: input.displayName,
          manufacturer: input.manufacturer ?? null,
          model: input.model ?? null,
          serialNumber: input.serialNumber ?? null,
          // The prefix, never the key and never the hash. It is what ties a
          // later authentication failure in the log to the credential that was
          // issued here, and it is not a secret.
          apiKeyPrefix: credential.prefix,
        },
      });

      return {
        id: instrument.id,
        slug: instrument.slug,
        displayName: instrument.display_name,
        createdAt: instrument.created_at,
        apiKey: credential.key,
        apiKeyPrefix: credential.prefix,
        auditSeq: event.seq,
      };
    });
  }

  /**
   * Rotation is immediate and unconditional: the previous key stops working the
   * moment this commits.
   *
   * Overlapping validity would be kinder to a running acquisition and is the
   * wrong default for the case rotation exists to serve. If a key is being
   * rotated because it leaked, a grace period is a grace period for whoever
   * holds it.
   */
  async rotateInstrumentKey(
    ctx: RequestContext,
    instrumentId: string,
  ): Promise<RotatedInstrumentKey> {
    const credential = await generateApiKey();

    return this.database.withTenant(ctx, async (trx) => {
      // Locked, because two rotations racing would each report a key they
      // believe is live and only one of them would be. The loser needs to be
      // told, and it is told by being serialised behind the winner and
      // recording the winner's prefix as the one it replaced.
      const existing = await trx
        .selectFrom('aliquot.instrument')
        .select(['id', 'slug', 'api_key_prefix'])
        .where('id', '=', instrumentId)
        .forUpdate()
        .executeTakeFirst();

      if (existing === undefined) {
        throw new NotFoundError('instrument', instrumentId);
      }

      await trx
        .updateTable('aliquot.instrument')
        .set({ api_key_hash: credential.hash, api_key_prefix: credential.prefix })
        .where('id', '=', instrumentId)
        .executeTakeFirstOrThrow();

      const event = await this.audit.append(trx, ctx, {
        action: 'instrument.key_rotated',
        targetType: 'instrument',
        targetId: instrumentId,
        payload: {
          instrumentId,
          slug: existing.slug,
          apiKeyPrefix: credential.prefix,
          previousApiKeyPrefix: existing.api_key_prefix,
        },
      });

      return {
        instrumentId,
        apiKey: credential.key,
        apiKeyPrefix: credential.prefix,
        previousApiKeyPrefix: existing.api_key_prefix,
        auditSeq: event.seq,
      };
    });
  }

  /**
   * The creator is made an admin of the new study in the same transaction.
   *
   * Without it the study exists and nobody administers it: the caller's standing
   * came from a different study, so every subsequent call about this one would be
   * a 403 and the only fix would be out of band.
   */
  async createStudy(
    ctx: RequestContext,
    input: { slug: string; title: string; description?: string },
  ): Promise<CreatedStudy> {
    const userId = actingUser(ctx);
    const studyId = uuidv7();

    return this.database.withTenant(ctx, async (trx) => {
      const study = await trx
        .insertInto('aliquot.study')
        .values({
          id: studyId,
          tenant_id: ctx.tenantId,
          slug: input.slug,
          title: input.title,
          description: input.description ?? null,
        })
        .returning(['id', 'slug', 'title', 'description', 'created_at', 'closed_at'])
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('aliquot.membership')
        .values({
          id: uuidv7(),
          tenant_id: ctx.tenantId,
          study_id: studyId,
          user_id: userId,
          role: 'admin',
          granted_by: userId,
        })
        .executeTakeFirstOrThrow();

      const event = await this.audit.append(trx, ctx, {
        action: 'study.created',
        targetType: 'study',
        targetId: studyId,
        payload: {
          studyId,
          slug: input.slug,
          title: input.title,
          description: input.description ?? null,
          administratorId: userId,
        },
      });

      return {
        id: study.id,
        slug: study.slug,
        title: study.title,
        description: study.description,
        createdAt: study.created_at,
        closedAt: study.closed_at,
        role: 'admin',
        auditSeq: event.seq,
      };
    });
  }

  /**
   * Studies the caller can see, which is exactly the ones they hold standing on.
   *
   * A tenant administrator does not see studies they are not a member of. That
   * is a deliberate asymmetry with `requireTenantAdmin`, which lets them create
   * studies and instruments: creating a study is an act of administration, while
   * reading one is access to human subject data under a consent scope that named
   * a set of people. Administration is not membership.
   */
  async listStudies(ctx: RequestContext, query: PageQuery): Promise<Page<StudyView>> {
    const before = query.cursor === undefined ? undefined : cursorId(query.cursor);

    return this.database.withTenant(ctx, async (trx) => {
      if (ctx.actorType === 'instrument') {
        const instrumentId = ctx.actorId;
        if (instrumentId === null) {
          throw new UnauthenticatedError('This request is not attributable to an instrument.');
        }

        let statement = trx
          .selectFrom('aliquot.study as s')
          .innerJoin('aliquot.instrument_study_grant as g', (join) =>
            join.onRef('g.study_id', '=', 's.id').on('g.instrument_id', '=', instrumentId),
          )
          .select(['s.id', 's.slug', 's.title', 's.description', 's.created_at', 's.closed_at'])
          // Study ids are UUIDv7, so ordering by id is ordering by creation time
          // without a second column in the cursor. A random UUID key would have
          // made this an arbitrary order that still paginated correctly.
          .orderBy('s.id', 'desc')
          .limit(query.limit + 1);

        if (before !== undefined) {
          statement = statement.where('s.id', '<', before);
        }

        const rows = await statement.execute();
        return buildPage(
          rows.map((row) => toStudyView(row, INSTRUMENT_ROLE)),
          query.limit,
          (study) => [study.id],
        );
      }

      const userId = ctx.actorId;
      if (userId === null) {
        throw new UnauthenticatedError('This request is not attributable to a user.');
      }

      let statement = trx
        .selectFrom('aliquot.study as s')
        .innerJoin('aliquot.membership as m', (join) =>
          join
            .onRef('m.study_id', '=', 's.id')
            .on('m.user_id', '=', userId)
            .on('m.revoked_at', 'is', null),
        )
        .select([
          's.id',
          's.slug',
          's.title',
          's.description',
          's.created_at',
          's.closed_at',
          'm.role',
        ])
        .orderBy('s.id', 'desc')
        .limit(query.limit + 1);

      if (before !== undefined) {
        statement = statement.where('s.id', '<', before);
      }

      const rows = await statement.execute();
      return buildPage(
        rows.map((row) => toStudyView(row, row.role)),
        query.limit,
        (study) => [study.id],
      );
    });
  }

  async listMembers(
    ctx: RequestContext,
    studyId: string,
    query: MemberQuery,
  ): Promise<Page<MemberView>> {
    const before = query.cursor === undefined ? undefined : cursorId(query.cursor);

    return this.database.withTenant(ctx, async (trx) => {
      let statement = trx
        .selectFrom('aliquot.membership as m')
        .innerJoin('aliquot.app_user as u', 'u.id', 'm.user_id')
        .select([
          'm.id',
          'm.user_id',
          'm.role',
          'm.granted_at',
          'm.granted_by',
          'm.revoked_at',
          'u.email',
          'u.display_name',
          'u.disabled_at',
        ])
        .where('m.study_id', '=', studyId)
        .orderBy('m.id', 'desc')
        .limit(query.limit + 1);

      if (!query.includeRevoked) {
        statement = statement.where('m.revoked_at', 'is', null);
      }
      if (before !== undefined) {
        statement = statement.where('m.id', '<', before);
      }

      const rows = await statement.execute();
      return buildPage(
        rows.map((row) => ({
          membershipId: row.id,
          userId: row.user_id,
          email: row.email,
          displayName: row.display_name,
          role: row.role,
          grantedAt: row.granted_at,
          grantedBy: row.granted_by,
          revokedAt: row.revoked_at,
          disabled: row.disabled_at !== null,
        })),
        query.limit,
        (member) => [member.membershipId],
      );
    });
  }

  /**
   * Grant a role, creating the account on first grant.
   *
   * Naming somebody by email who has no account yet is the normal case -- it is
   * how a person joins a study -- and refusing it would require a separate user
   * creation endpoint whose only caller is this one. The account is created
   * without any credential: it becomes usable when an identity provider (or, in
   * development, the token endpoint) authenticates that address.
   */
  async grantMembership(
    ctx: RequestContext,
    studyId: string,
    input: GrantMembershipInput,
  ): Promise<MembershipGrant> {
    const grantedBy = actingUser(ctx);

    return this.database.withTenant(ctx, async (trx) => {
      const study = await trx
        .selectFrom('aliquot.study')
        .select('id')
        .where('id', '=', studyId)
        .executeTakeFirst();

      if (study === undefined) {
        throw new NotFoundError('study', studyId);
      }

      const target = await this.resolveTarget(trx, ctx, input);
      const existing = await trx
        .selectFrom('aliquot.membership')
        .select(['id', 'role', 'revoked_at'])
        .where('study_id', '=', studyId)
        .where('user_id', '=', target.userId)
        .executeTakeFirst();

      if (existing !== undefined && existing.role === input.role && existing.revoked_at === null) {
        return {
          studyId,
          userId: target.userId,
          role: input.role,
          previousRole: existing.role,
          userCreated: target.created,
          auditSeq: null,
        };
      }

      // The unique constraint, not the read above, is what makes this safe under
      // concurrency: two administrators granting the same person at the same
      // moment both take this path and one of them updates rather than failing.
      const membership = await trx
        .insertInto('aliquot.membership')
        .values({
          id: uuidv7(),
          tenant_id: ctx.tenantId,
          study_id: studyId,
          user_id: target.userId,
          role: input.role,
          granted_by: grantedBy,
        })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'study_id', 'user_id'])
            .doUpdateSet({ role: input.role, revoked_at: null, granted_by: grantedBy }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();

      const event = await this.audit.append(trx, ctx, {
        action: 'membership.granted',
        targetType: 'membership',
        targetId: membership.id,
        payload: {
          studyId,
          userId: target.userId,
          email: target.email,
          role: input.role,
          previousRole: existing?.role ?? null,
          reinstated: existing !== undefined && existing.revoked_at !== null,
          userCreated: target.created,
        },
      });

      return {
        studyId,
        userId: target.userId,
        role: input.role,
        previousRole: existing?.role ?? null,
        userCreated: target.created,
        auditSeq: event.seq,
      };
    });
  }

  /**
   * Revocation sets `revoked_at`; the row stays.
   *
   * Deleting it would delete the answer to "who could have written this run, and
   * when did that stop being true", which is the question an audit of a
   * historical record actually asks. `membership_user_idx` is partial on
   * `revoked_at is null`, so the history costs nothing on the read path.
   */
  async revokeMembership(
    ctx: RequestContext,
    studyId: string,
    userId: string,
  ): Promise<MembershipRevocation> {
    return this.database.withTenant(ctx, async (trx) => {
      // Serialises membership changes for this study. The last-administrator
      // check below reads a count, and a count is only as strong as the lock
      // that stops it changing underneath: without this, two concurrent
      // revocations each see the other administrator still in place and both
      // succeed, leaving the study with none.
      const study = await sql<{ id: string }>`
        select id from aliquot.study where id = ${studyId}::uuid for update
      `.execute(trx);

      if (study.rows.length === 0) {
        throw new NotFoundError('study', studyId);
      }

      const membership = await trx
        .selectFrom('aliquot.membership')
        .select(['id', 'role'])
        .where('study_id', '=', studyId)
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();

      // An already-revoked membership is not found rather than a no-op success:
      // the resource being removed is the active grant, and it is not there.
      if (membership === undefined) {
        throw new NotFoundError('membership', userId);
      }

      if (membership.role === 'admin') {
        const remaining = await sql<{ count: string }>`
          select count(*)::text as count
            from aliquot.membership
           where tenant_id = ${ctx.tenantId}::uuid
             and study_id = ${studyId}::uuid
             and user_id <> ${userId}::uuid
             and role = 'admin'
             and revoked_at is null
        `.execute(trx);

        if ((remaining.rows[0]?.count ?? '0') === '0') {
          throw new ConflictError(
            `Study ${studyId} would be left with no administrator. Grant admin to somebody else first.`,
            { studyId, userId },
          );
        }
      }

      // The database's clock, not this process's, for the same reason
      // `occurred_at` on an audit event comes from `clock_timestamp()`: the time
      // recorded should be the time the row was written.
      const revoked = await trx
        .updateTable('aliquot.membership')
        .set({ revoked_at: sql<Date>`clock_timestamp()` })
        .where('id', '=', membership.id)
        .returning('revoked_at')
        .executeTakeFirstOrThrow();

      const revokedAt = revoked.revoked_at;
      if (revokedAt === null) {
        throw new Error('revocation left revoked_at null');
      }

      const event = await this.audit.append(trx, ctx, {
        action: 'membership.revoked',
        targetType: 'membership',
        targetId: membership.id,
        payload: { studyId, userId, role: membership.role },
      });

      return { studyId, userId, revokedAt, auditSeq: event.seq };
    });
  }

  /** Deposit rights for an instrument on one study. Repeating it changes nothing. */
  async grantInstrumentToStudy(
    ctx: RequestContext,
    studyId: string,
    instrumentId: string,
  ): Promise<InstrumentStudyGrant> {
    const grantedBy = actingUser(ctx);

    return this.database.withTenant(ctx, async (trx) => {
      // Checked rather than left to the foreign key: a bad id should be a 404
      // naming what was not found, not a constraint violation rendered as a
      // conflict.
      const instrument = await trx
        .selectFrom('aliquot.instrument')
        .select(['id', 'slug'])
        .where('id', '=', instrumentId)
        .executeTakeFirst();

      if (instrument === undefined) {
        throw new NotFoundError('instrument', instrumentId);
      }

      const study = await trx
        .selectFrom('aliquot.study')
        .select('id')
        .where('id', '=', studyId)
        .executeTakeFirst();

      if (study === undefined) {
        throw new NotFoundError('study', studyId);
      }

      // DO NOTHING rather than DO UPDATE: the application role has no UPDATE
      // privilege on this table, and there is nothing to update -- the row is
      // its own key.
      const inserted = await trx
        .insertInto('aliquot.instrument_study_grant')
        .values({
          tenant_id: ctx.tenantId,
          instrument_id: instrumentId,
          study_id: studyId,
          granted_by: grantedBy,
        })
        .onConflict((oc) => oc.columns(['instrument_id', 'study_id']).doNothing())
        .executeTakeFirst();

      const created = (inserted.numInsertedOrUpdatedRows ?? 0n) > 0n;
      if (!created) {
        return { studyId, instrumentId, created: false, auditSeq: null };
      }

      const event = await this.audit.append(trx, ctx, {
        action: 'instrument.granted',
        targetType: 'instrument',
        targetId: instrumentId,
        payload: { studyId, instrumentId, instrumentSlug: instrument.slug },
      });

      return { studyId, instrumentId, created: true, auditSeq: event.seq };
    });
  }

  /**
   * Mint a session from an email address, with no credential of any kind.
   *
   * This is a development affordance and it is a total authentication bypass:
   * anyone who can reach the endpoint can become anyone. It is gated by
   * `AUTH_DEV_TOKEN_ENDPOINT`, the controller returns 404 when that is off, and
   * `AppConfig` refuses to start a production process with it on. Three gates for
   * one switch is proportionate to what is behind it.
   *
   * The tenant is named explicitly because an email address is unique per tenant,
   * not globally -- the same person at two organisations is two accounts, and
   * guessing between them is not something an authentication path should do.
   */
  async issueDevSession(
    input: { email: string; tenantSlug: string },
    correlationId: string,
  ): Promise<IssuedSession> {
    const tenantId = await this.registry.tenantIdForSlug(input.tenantSlug);
    if (tenantId === null) {
      // Same rejection as an unknown address: whether a tenant slug exists is
      // not something an unauthenticated caller needs to learn.
      throw new UnauthenticatedError('No account matches that tenant and address.');
    }

    return this.database.withTenant(
      systemContext(tenantId, correlationId, { label: 'auth' }),
      async (trx) => {
        const user = await trx
          .selectFrom('aliquot.app_user')
          .select(['id', 'email', 'display_name', 'disabled_at'])
          .where(sql<boolean>`lower(email) = lower(${input.email})`)
          .executeTakeFirst();

        if (user === undefined) {
          throw new UnauthenticatedError('No account matches that tenant and address.');
        }
        if (user.disabled_at !== null) {
          throw new UnauthenticatedError('This account has been disabled.');
        }

        const issued = signSession(this.config.auth.jwtSecret, {
          userId: user.id,
          tenantId,
          ttlSeconds: this.config.auth.tokenTtlSeconds,
        });

        // The event belongs to the user who now holds the session, not to the
        // system context the lookup ran under, so the session variables are
        // re-applied to match what is about to be recorded. `append_audit_event`
        // takes its actor from these arguments and its tenant from the session;
        // leaving the two disagreeing would make the trail read as though the
        // service signed itself in.
        const sessionContext: RequestContext = {
          tenantId,
          actorType: 'user',
          actorId: user.id,
          actorLabel: user.display_name,
          correlationId,
          dbRole: 'aliquot_app',
        };
        await applySessionContext(trx, sessionContext);

        const event = await this.audit.append(trx, sessionContext, {
          action: 'session.issued',
          targetType: 'app_user',
          targetId: user.id,
          payload: {
            userId: user.id,
            email: user.email,
            // The token id, so an action taken later under this session can be
            // tied back to the moment it was issued.
            sessionId: issued.claims.jti,
            expiresAt: new Date(issued.claims.exp * 1000).toISOString(),
            mechanism: 'development-token-endpoint',
          },
        });

        return {
          token: issued.token,
          tokenType: 'Bearer',
          expiresInSeconds: this.config.auth.tokenTtlSeconds,
          expiresAt: new Date(issued.claims.exp * 1000).toISOString(),
          user: {
            id: user.id,
            email: user.email,
            displayName: user.display_name,
            tenantId,
            tenantSlug: input.tenantSlug,
          },
          auditSeq: event.seq,
        };
      },
    );
  }

  /**
   * The user a membership grant is about, created if this is their first.
   *
   * Creation appends its own audit event: an account coming into existence is a
   * distinct fact from being given a role, and folding it into the membership
   * payload would make the first grant and every later one look the same in the
   * trail.
   */
  private async resolveTarget(
    trx: Trx,
    ctx: RequestContext,
    input: GrantMembershipInput,
  ): Promise<{ userId: string; email: string; created: boolean }> {
    if (input.userId !== undefined) {
      const user = await trx
        .selectFrom('aliquot.app_user')
        .select(['id', 'email'])
        .where('id', '=', input.userId)
        .executeTakeFirst();

      if (user === undefined) {
        throw new NotFoundError('user', input.userId);
      }
      return { userId: user.id, email: user.email, created: false };
    }

    const email = input.email;
    if (email === undefined) {
      throw new ValidationError('Either userId or email must identify the member.');
    }

    const existing = await trx
      .selectFrom('aliquot.app_user')
      .select(['id', 'email'])
      .where(sql<boolean>`lower(email) = lower(${email})`)
      .executeTakeFirst();

    if (existing !== undefined) {
      return { userId: existing.id, email: existing.email, created: false };
    }

    const userId = uuidv7();
    const created = await trx
      .insertInto('aliquot.app_user')
      .values({
        id: userId,
        tenant_id: ctx.tenantId,
        email,
        display_name: input.displayName ?? email,
      })
      .returning(['id', 'email'])
      .executeTakeFirstOrThrow();

    await this.audit.append(trx, ctx, {
      action: 'user.registered',
      targetType: 'app_user',
      targetId: userId,
      payload: { userId, email, displayName: input.displayName ?? email },
    });

    return { userId: created.id, email: created.email, created: true };
  }
}

/**
 * The acting user id, for the columns that record who did something.
 *
 * `granted_by` is a foreign key to `app_user`, so an instrument principal cannot
 * be recorded there even if authorisation somehow let one through. Failing here
 * turns that into a named refusal rather than a foreign key violation.
 */
function actingUser(ctx: RequestContext): string {
  if (ctx.actorType !== 'user' || ctx.actorId === null) {
    throw new ForbiddenError('This operation must be performed by a user principal.', 'admin');
  }
  return ctx.actorId;
}

function toStudyView(
  row: {
    id: string;
    slug: string;
    title: string;
    description: string | null;
    created_at: Date;
    closed_at: Date | null;
  },
  role: StudyRole,
): StudyView {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    role,
  };
}

function cursorId(cursor: string): string {
  const [id] = decodeCursor(cursor, 1);
  if (id === undefined || !isUuid(id)) {
    throw new ValidationError('cursor is not a valid pagination cursor');
  }
  return id;
}
