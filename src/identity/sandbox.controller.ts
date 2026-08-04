import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';

import { RateLimitedError, RouteNotFoundError } from '../common/problem-details';
import { AppConfig } from '../config/config';
import type { RequestContext } from '../database/request-context';
import { correlationIdOf } from '../http/correlation';
import { Ctx } from '../http/principal';
import type { AliquotRequest } from '../http/principal';
import { Public } from './auth.guard';
import { FixedWindowRateLimiter } from './rate-limiter';
import { SandboxService } from './sandbox.service';
import type { ProvisionedSandbox, SandboxStatus } from './sandbox.service';

/**
 * The sandbox surface: two endpoints, one of which creates a tenant.
 *
 * Provisioning is `@Public()` for the same reason the demo sign-in is -- it is
 * what produces the credential everything else needs -- and it takes no request
 * body at all, which is the whole of the argument for publishing it. There is no
 * parameter to influence, no address to enumerate and nothing to validate; the
 * tenant, the study, the operator, the instrument and the lifetime are all
 * decided here from configuration fixed at boot.
 *
 * It is absent rather than forbidden when switched off. A 403 would confirm the
 * route exists and is merely disabled, which tells a scanner exactly which
 * deployment to come back to.
 */
@Controller('v1/sandbox')
export class SandboxController {
  constructor(
    private readonly sandbox: SandboxService,
    private readonly config: AppConfig,
    private readonly limiter: FixedWindowRateLimiter,
  ) {}

  /**
   * 200 rather than 201, and not because a tenant was not created.
   *
   * The useful part of the response is a credential, and a credential is not a
   * resource this API will serve at a URL -- there is no `Location` to give, and
   * a 201 promises one. `POST /v1/auth/demo` answers 200 for the same reason.
   */
  @Public()
  @Post()
  @HttpCode(200)
  async provision(@Req() request: AliquotRequest): Promise<ProvisionedSandbox> {
    if (!this.config.sandbox.enabled) {
      throw new RouteNotFoundError('POST', '/v1/sandbox');
    }

    // Keyed by source address and namespaced away from the demo sign-in's
    // budget. Fastify is constructed with `trustProxy`, so behind the reverse
    // proxy this is deployed under, `ip` is the left-most X-Forwarded-For entry.
    // A request with no address at all -- an in-process injection, which is how
    // the tests reach this -- shares one bucket rather than being exempted,
    // because an exemption is a hole that only ever gets found by accident.
    //
    // This limit does more work than the demo's. Each admitted request creates a
    // tenant, five rows and an audit chain, and the rate is the only thing
    // standing between that and a script.
    const decision = this.limiter.consume(
      `sandbox:${request.ip ?? 'unknown'}`,
      this.config.sandbox.rateLimitPerMinute,
    );

    if (!decision.allowed) {
      throw new RateLimitedError(
        `Sandbox provisioning accepts ${this.config.sandbox.rateLimitPerMinute} requests per ` +
          `minute from one address. Retry in ${decision.retryAfterSeconds}s.`,
        decision.retryAfterSeconds,
      );
    }

    return this.sandbox.provision(correlationIdOf(request));
  }

  /**
   * The sandbox behind the calling session, with what it has spent.
   *
   * Authenticated, and deliberately not gated on `SANDBOX_MODE`: a session
   * issued while the feature was on must keep working if an operator switches it
   * off, or turning the tap off would strand every visitor mid-run rather than
   * merely stopping new ones. The reaper is what ends a sandbox, not a flag.
   */
  @Get()
  async status(@Ctx() ctx: RequestContext): Promise<SandboxStatus> {
    return this.sandbox.describe(ctx);
  }
}
