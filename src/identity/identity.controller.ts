import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import type { Page } from '../common/cursor';
import { AliquotError, ProblemType, RateLimitedError } from '../common/problem-details';
import { AppConfig } from '../config/config';
import type { RequestContext } from '../database/request-context';
import type { StudyRole } from '../database/schema';
import { correlationIdOf } from '../http/correlation';
import { Ctx } from '../http/principal';
import type { AliquotRequest } from '../http/principal';
import { parseWith } from '../http/zod-validation';
import { AuthService } from './auth.service';
import { Public } from './auth.guard';
import { DemoRateLimiter } from './demo-rate-limiter';
import { IdentityService } from './identity.service';
import type {
  CreatedStudy,
  DemoSession,
  InstrumentStudyGrant,
  IssuedSession,
  MemberView,
  MembershipGrant,
  MembershipRevocation,
  RegisteredInstrument,
  RotatedInstrumentKey,
  StudyView,
} from './identity.service';

/**
 * The administrative surface: instruments, studies, members, and a development
 * sign-in.
 *
 * Authorisation is decided here rather than in the service, one line per handler
 * and visible next to the route it protects. A reader checking whether an
 * endpoint is guarded should not have to follow a call two files deep to find
 * out.
 *
 * Every mutation returns `auditSeq`, the sequence number of the event it
 * appended, so a caller can verify its own write landed in the chain without
 * polling the audit stream. It is null when the request was accepted and changed
 * nothing.
 */

const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'must be a lower-case slug, 2-63 characters');
const limit = z.coerce.number().int().min(1).max(200).default(50);
const cursor = z.string().min(1).max(512);
const role = z.enum(['operator', 'scientist', 'steward', 'admin']);

const pageQuerySchema = z.object({ limit, cursor: cursor.optional() });

const memberQuerySchema = z.object({
  limit,
  cursor: cursor.optional(),
  /** Revoked grants are history and are excluded unless asked for by name. */
  includeRevoked: z.stringbool().default(false),
});

const registerInstrumentSchema = z.object({
  slug,
  displayName: z.string().min(1).max(200),
  manufacturer: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
  serialNumber: z.string().min(1).max(200).optional(),
});

const createStudySchema = z.object({
  slug,
  title: z.string().min(1).max(400),
  description: z.string().max(4000).optional(),
});

const grantMembershipSchema = z
  .object({
    userId: z.uuid().optional(),
    email: z.email().max(320).optional(),
    displayName: z.string().min(1).max(200).optional(),
    role,
  })
  .refine((body) => (body.userId === undefined) !== (body.email === undefined), {
    message: 'name the member by exactly one of userId or email',
    path: ['email'],
  });

const grantInstrumentSchema = z.object({ instrumentId: z.uuid() });

const devTokenSchema = z.object({
  email: z.email().max(320),
  /** An email address is unique per tenant, not globally. */
  tenantSlug: slug,
});

const instrumentParamsSchema = z.object({ id: z.uuid() });
const studyParamsSchema = z.object({ studyId: z.uuid() });
const memberParamsSchema = z.object({ studyId: z.uuid(), userId: z.uuid() });

const MEMBER_ROLES: StudyRole[] = ['operator', 'scientist', 'steward', 'admin'];
const ADMIN_ONLY: StudyRole[] = ['admin'];

/**
 * A disabled development endpoint is absent, not forbidden.
 *
 * A 403 would confirm the route exists and is merely switched off, which tells a
 * scanner exactly which deployment to come back to. The body says what an
 * unmatched route says.
 */
class RouteNotFoundError extends AliquotError {
  constructor(method: string, path: string) {
    super(ProblemType.NOT_FOUND, 404, 'Not found', `No route matches ${method} ${path}.`);
  }
}

@Controller('v1')
export class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    private readonly auth: AuthService,
    private readonly config: AppConfig,
    private readonly demoLimiter: DemoRateLimiter,
  ) {}

  @Post('instruments')
  async registerInstrument(
    @Ctx() ctx: RequestContext,
    @Body() body: unknown,
  ): Promise<RegisteredInstrument> {
    await this.auth.requireTenantAdmin(ctx);
    return this.identity.registerInstrument(ctx, parseWith(registerInstrumentSchema, body));
  }

  @Post('instruments/:id/keys')
  async rotateInstrumentKey(
    @Ctx() ctx: RequestContext,
    @Param() params: unknown,
  ): Promise<RotatedInstrumentKey> {
    const { id } = parseWith(instrumentParamsSchema, params, 'params');
    await this.auth.requireTenantAdmin(ctx);
    return this.identity.rotateInstrumentKey(ctx, id);
  }

  @Get('studies')
  async listStudies(@Ctx() ctx: RequestContext, @Query() query: unknown): Promise<Page<StudyView>> {
    return this.identity.listStudies(ctx, parseWith(pageQuerySchema, query, 'query'));
  }

  @Post('studies')
  async createStudy(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<CreatedStudy> {
    await this.auth.requireTenantAdmin(ctx);
    return this.identity.createStudy(ctx, parseWith(createStudySchema, body));
  }

  /** Any member may see who else is on the study; membership is not itself a secret. */
  @Get('studies/:studyId/members')
  async listMembers(
    @Ctx() ctx: RequestContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<Page<MemberView>> {
    const { studyId } = parseWith(studyParamsSchema, params, 'params');
    await this.auth.requireStudyRole(ctx, studyId, MEMBER_ROLES);
    return this.identity.listMembers(ctx, studyId, parseWith(memberQuerySchema, query, 'query'));
  }

  @Post('studies/:studyId/members')
  async grantMembership(
    @Ctx() ctx: RequestContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MembershipGrant> {
    const { studyId } = parseWith(studyParamsSchema, params, 'params');
    await this.auth.requireStudyRole(ctx, studyId, ADMIN_ONLY);

    const result = await this.identity.grantMembership(
      ctx,
      studyId,
      parseWith(grantMembershipSchema, body),
    );

    reply.status(result.previousRole === null ? 201 : 200);
    return result;
  }

  @Delete('studies/:studyId/members/:userId')
  async revokeMembership(
    @Ctx() ctx: RequestContext,
    @Param() params: unknown,
  ): Promise<MembershipRevocation> {
    const { studyId, userId } = parseWith(memberParamsSchema, params, 'params');
    await this.auth.requireStudyRole(ctx, studyId, ADMIN_ONLY);
    return this.identity.revokeMembership(ctx, studyId, userId);
  }

  @Post('studies/:studyId/instruments')
  async grantInstrument(
    @Ctx() ctx: RequestContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<InstrumentStudyGrant> {
    const { studyId } = parseWith(studyParamsSchema, params, 'params');
    const { instrumentId } = parseWith(grantInstrumentSchema, body);
    await this.auth.requireStudyRole(ctx, studyId, ADMIN_ONLY);

    const result = await this.identity.grantInstrumentToStudy(ctx, studyId, instrumentId);
    reply.status(result.created ? 201 : 200);
    return result;
  }

  /**
   * Development sign-in. Public by necessity -- it is what produces the
   * credential everything else requires -- and gated three ways: this check,
   * `AUTH_DEV_TOKEN_ENDPOINT`, and `AppConfig` refusing to start a production
   * process with the flag on.
   */
  @Public()
  @Post('auth/token')
  @HttpCode(200)
  async issueToken(@Body() body: unknown, @Req() request: AliquotRequest): Promise<IssuedSession> {
    if (!this.config.auth.devTokenEndpoint) {
      throw new RouteNotFoundError('POST', '/v1/auth/token');
    }

    return this.identity.issueDevSession(parseWith(devTokenSchema, body), correlationIdOf(request));
  }

  /**
   * Public read-only sign-in, for a deployment that is meant to be looked at.
   *
   * There is deliberately no request body and no parameter of any kind. The
   * endpoint above mints a session for whatever address it is handed, which is
   * why it must never be reachable in production; this one mints a session for
   * exactly one pre-configured, pre-seeded account and marks it as a demo, and
   * `DemoReadOnlyGuard` refuses every mutating verb it presents. Nothing a
   * caller sends can change who they become, so there is nothing to validate
   * and no account list to probe.
   *
   * Off by default, and absent rather than forbidden when off, for the same
   * reason as the development endpoint: a 403 would tell a scanner which
   * deployment to come back to.
   */
  @Public()
  @Post('auth/demo')
  @HttpCode(200)
  async issueDemoToken(@Req() request: AliquotRequest): Promise<DemoSession> {
    if (!this.config.demo.enabled) {
      throw new RouteNotFoundError('POST', '/v1/auth/demo');
    }

    // Keyed by source address. Fastify is constructed with `trustProxy`, so
    // behind the reverse proxy this is deployed under, `ip` is the left-most
    // X-Forwarded-For entry rather than the proxy's own address. A request with
    // no address at all -- an in-process injection, which is how the tests
    // reach this -- shares one bucket rather than being exempted, because an
    // exemption is a hole that only ever gets found by accident.
    const decision = this.demoLimiter.consume(
      request.ip ?? 'unknown',
      this.config.demo.rateLimitPerMinute,
    );

    if (!decision.allowed) {
      throw new RateLimitedError(
        `The demo sign-in accepts ${this.config.demo.rateLimitPerMinute} requests per minute ` +
          `from one address. Retry in ${decision.retryAfterSeconds}s.`,
        decision.retryAfterSeconds,
      );
    }

    return this.identity.issueDemoSession(correlationIdOf(request));
  }
}
