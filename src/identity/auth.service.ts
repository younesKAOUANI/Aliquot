import { Injectable } from '@nestjs/common';

import { ForbiddenError, UnauthenticatedError } from '../common/problem-details';
import { AppConfig } from '../config/config';
import { DatabaseService } from '../database/database.service';
import type { RequestContext } from '../database/request-context';
import { systemContext } from '../database/request-context';
import type { StudyRole } from '../database/schema';
import type { Principal } from '../http/principal';
import { apiKeyPrefix, isApiKey, usesApiKeyScheme, verifyApiKey } from './credentials';
import { TenantRegistry } from './tenant-registry';
import { verifySession } from './tokens';

/**
 * Authentication and authorisation.
 *
 * Two credential kinds, resolved to the same `Principal`. Instruments are not
 * modelled as a species of user: they hold a long-lived secret that lives on an
 * acquisition workstation in a shared lab, they can only ever deposit into
 * studies they have been explicitly granted, and the provenance record wants to
 * say "acquired by instrument X, operated by human Y" as two separate facts.
 *
 * Authorisation is study-scoped because a role that spanned the tenant would be
 * inexpressible against the real cases -- blinded arms, competing programmes,
 * human subject data under a narrower consent -- where a scientist on one study
 * is deliberately not entitled to another in the same organisation.
 */

/**
 * Correlation id for the transactions authentication itself runs.
 *
 * `resolvePrincipal` is handed a credential and nothing else, by contract: it is
 * called before there is a request context to inherit one from. These
 * transactions read and never write, so the value never reaches an audit event;
 * it exists so query logs from the authentication path are identifiable.
 */
const AUTHENTICATION_CORRELATION = 'authentication';

const BEARER = /^bearer[ \t]+(\S+)$/i;

/** The one capability an instrument principal can satisfy. */
export const INSTRUMENT_ROLE: StudyRole = 'operator';

@Injectable()
export class AuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfig,
    private readonly registry: TenantRegistry,
  ) {}

  /**
   * Resolve an `Authorization` header to a principal, or reject it.
   *
   * The credential kind is decided by the `aliq_` scheme prefix rather than by
   * trying one path and falling back to the other. A malformed instrument key
   * must not be retried as a session token: the fallback would double the work
   * done on every bad credential and would make the failure that gets reported
   * the second one, which is never the useful one.
   */
  async resolvePrincipal(authorizationHeader: string | undefined): Promise<Principal> {
    if (authorizationHeader === undefined) {
      throw new UnauthenticatedError('An Authorization header is required.');
    }

    const match = BEARER.exec(authorizationHeader.trim());
    const credential = match?.[1];
    if (credential === undefined) {
      throw new UnauthenticatedError('Authorization must be a Bearer credential.');
    }

    return usesApiKeyScheme(credential)
      ? this.instrumentPrincipal(credential)
      : this.userPrincipal(credential);
  }

  /**
   * The database session an authenticated request runs under.
   *
   * `dbRole` is always `aliquot_app`. `aliquot_worker` exists to claim jobs
   * across tenants and no request-bound principal has any business assuming it,
   * so it is not reachable from here at all.
   */
  contextFor(principal: Principal, correlationId: string): RequestContext {
    return {
      tenantId: principal.tenantId,
      actorType: principal.actorType,
      actorId: principal.actorId,
      actorLabel: principal.label,
      correlationId,
      dbRole: 'aliquot_app',
    };
  }

  /**
   * Require one of `allowed` on `studyId`, or throw.
   *
   * `admin` satisfies every check without being listed: it is defined as the
   * role that manages instruments and members, and a service where the
   * administrator of a study cannot read it would be a service where every call
   * site has to remember to write `['scientist', 'admin']`. Forgetting once is a
   * lockout that looks like a permissions bug.
   *
   * An instrument satisfies exactly `operator`, and only for a study it has been
   * granted. Even an instrument the tenant trusts completely cannot read a study
   * it does not deposit into, because the credential's blast radius is the whole
   * point of `instrument_study_grant` existing.
   */
  async requireStudyRole(
    ctx: RequestContext,
    studyId: string,
    allowed: StudyRole[],
  ): Promise<void> {
    const required = allowed.join(' or ');

    if (ctx.actorType === 'instrument') {
      if (!allowed.includes(INSTRUMENT_ROLE)) {
        throw new ForbiddenError(
          `An instrument credential cannot act as ${required}; it only ever acts as ${INSTRUMENT_ROLE}.`,
          required,
        );
      }

      const instrumentId = ctx.actorId;
      if (instrumentId === null) {
        throw new UnauthenticatedError('This request is not attributable to an instrument.');
      }

      const granted = await this.database.withTenant(ctx, (trx) =>
        trx
          .selectFrom('aliquot.instrument_study_grant')
          .select('instrument_id')
          .where('study_id', '=', studyId)
          .where('instrument_id', '=', instrumentId)
          .executeTakeFirst(),
      );

      if (granted === undefined) {
        throw new ForbiddenError(
          `This instrument has not been granted deposit rights on study ${studyId}.`,
          INSTRUMENT_ROLE,
        );
      }
      return;
    }

    if (ctx.actorType !== 'user') {
      // A system context is the worker acting on its own behalf. It holds no
      // membership by construction, and reaching a study-role check with one is
      // a routing mistake rather than a request that should be reasoned about.
      throw new ForbiddenError('An automated context carries no study role.', required);
    }

    const role = await this.studyRole(ctx, studyId);
    if (role === null) {
      throw new ForbiddenError(`You are not a member of study ${studyId}.`, required);
    }
    if (role !== 'admin' && !allowed.includes(role)) {
      throw new ForbiddenError(
        `Study ${studyId} requires ${required}; you hold ${role}.`,
        required,
      );
    }
  }

  /**
   * Require administrative standing over the tenant, for the operations that
   * have no study to be checked against: registering an instrument, creating a
   * study.
   *
   * There is no tenant-level role in the schema, and inventing one in the
   * application would put an authorisation decision somewhere row-level security
   * cannot corroborate it. This reads the nearest true statement the data model
   * can make instead -- the caller administers at least one study in this tenant
   * -- and it is deliberately weaker than it looks: an admin of any one study can
   * create studies and register instruments for the whole tenant. That is
   * acceptable while `admin` is granted by another admin and every grant is in
   * the audit trail; it stops being acceptable the moment tenants start
   * sub-delegating administration, at which point the schema needs a
   * tenant-level role and this method is the only caller to change.
   *
   * The first study in a fresh tenant therefore cannot be created through this
   * API, because nobody administers anything yet. Bootstrapping a tenant is an
   * out-of-band operation.
   */
  /**
   * Require one of `allowed` on **any** study in the tenant.
   *
   * Some resources are tenant-scoped rather than study-scoped -- the audit
   * chain most obviously, since `seq` is per tenant and the chain spans every
   * study in it. Authorising those against a named study would be asking the
   * caller to nominate a study the resource does not belong to, which is how a
   * tenant-wide read ends up looking like a study-wide one.
   *
   * Holding the role anywhere in the tenant is the right bar for those: a
   * steward's remit is the record, and the record is not divisible by study.
   */
  async requireTenantRole(ctx: RequestContext, allowed: StudyRole[]): Promise<void> {
    const required = allowed.join(' or ');

    if (ctx.actorType !== 'user') {
      throw new ForbiddenError(
        `Only a user principal may act as ${required} across the tenant.`,
        required,
      );
    }

    const userId = ctx.actorId;
    if (userId === null) {
      throw new UnauthenticatedError('This session is not attributable to a user.');
    }

    const held = await this.database.withTenant(ctx, (trx) =>
      trx
        .selectFrom('aliquot.membership')
        .select('id')
        .where('user_id', '=', userId)
        .where('role', 'in', allowed)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );

    if (held === undefined) {
      throw new ForbiddenError(
        `This operation requires ${required} on at least one study in the tenant.`,
        required,
      );
    }
  }

  async requireTenantAdmin(ctx: RequestContext): Promise<void> {
    await this.requireTenantRole(ctx, ['admin']);
  }

  /** The caller's active role on a study, or null when there is no active membership. */
  async studyRole(ctx: RequestContext, studyId: string): Promise<StudyRole | null> {
    if (ctx.actorType === 'instrument') {
      return null;
    }

    const userId = ctx.actorId;
    if (userId === null) {
      return null;
    }

    const membership = await this.database.withTenant(ctx, (trx) =>
      trx
        .selectFrom('aliquot.membership')
        .select('role')
        .where('study_id', '=', studyId)
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );

    return membership?.role ?? null;
  }

  /**
   * An unknown prefix and a wrong key produce the same 401 with the same wording.
   *
   * Distinguishing them would confirm that a prefix is live, which is the only
   * part of the credential an attacker could plausibly have seen in isolation --
   * it is the part this service writes to logs and audit payloads.
   */
  private async instrumentPrincipal(credential: string): Promise<Principal> {
    const rejected = new UnauthenticatedError('The instrument API key is not valid.');

    if (!isApiKey(credential)) {
      throw rejected;
    }

    const instrument = await this.registry.instrumentByKeyPrefix(apiKeyPrefix(credential));
    if (instrument === null || !(await verifyApiKey(credential, instrument.apiKeyHash))) {
      throw rejected;
    }
    if (instrument.disabledAt !== null) {
      throw new UnauthenticatedError('This instrument credential has been disabled.');
    }

    return {
      tenantId: instrument.tenantId,
      actorType: 'instrument',
      actorId: instrument.instrumentId,
      label: instrument.displayName,
      // An instrument key is issued by a tenant administrator and is never
      // handed out by the demo endpoint, which mints session tokens only.
      isDemo: false,
    };
  }

  /**
   * A verified signature is not sufficient on its own.
   *
   * The token is a bearer credential with a lifetime measured in hours, and
   * disabling an account has to take effect before it expires. The user row is
   * therefore read on every request -- it is one indexed primary key lookup, and
   * the alternative is an account that stays live for the remainder of its
   * session after being switched off.
   */
  private async userPrincipal(credential: string): Promise<Principal> {
    const claims = verifySession(this.config.auth.jwtSecret, credential);

    const user = await this.database.withTenant(
      systemContext(claims.tid, AUTHENTICATION_CORRELATION),
      (trx) =>
        trx
          .selectFrom('aliquot.app_user')
          .select(['id', 'display_name', 'disabled_at'])
          .where('id', '=', claims.sub)
          .executeTakeFirst(),
    );

    // Row-level security scopes the lookup to the tenant the token names, so a
    // token whose `tid` and `sub` do not belong together finds nothing.
    if (user === undefined) {
      throw new UnauthenticatedError('This session refers to an account that no longer exists.');
    }
    if (user.disabled_at !== null) {
      throw new UnauthenticatedError('This account has been disabled.');
    }

    return {
      tenantId: claims.tid,
      actorType: 'user',
      actorId: user.id,
      label: user.display_name,
      // From the signed claim, not from the account. The same user could hold
      // an ordinary session and a demo session at once, and only one of them is
      // restricted.
      isDemo: claims.demo === true,
    };
  }
}
