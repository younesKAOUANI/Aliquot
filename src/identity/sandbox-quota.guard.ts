import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

import { AppConfig } from '../config/config';
import type { AliquotRequest } from '../http/principal';
import { SandboxService } from './sandbox.service';

/**
 * A sandbox may do anything an operator may do, up to its allowance and until
 * its clock runs out.
 *
 * ## Why this is a guard and not a check in each service
 *
 * The same reason `DemoReadOnlyGuard` is a guard. The quota is a property of the
 * *deployment* -- this instance hands sessions to strangers, so a stranger must
 * not be able to fill the bucket -- and a property of the deployment cannot live
 * in the handlers, because the set of handlers grows. A new mutating endpoint
 * added next month is covered by this the moment it is routed; a new mutating
 * endpoint that has to remember to call `assertWithinQuota` is covered until
 * somebody forgets, and forgetting is silent.
 *
 * It is registered after `AuthGuard`, which is not incidental: it reads the
 * `request.context` that guard establishes. Registered first it would find none
 * on every request and let every sandbox spend without limit. It is also
 * registered after `DemoReadOnlyGuard`, so a demo session is refused as a demo
 * session rather than being told about a quota it does not have.
 *
 * ## What it does not do
 *
 * It does not enforce the per-artifact size cap. That belongs where a manifest
 * is declared, because refusing a 4 GB artifact needs to happen *before* an
 * upload URL is issued for it -- see `SandboxService.assertDeclarationsWithinQuota`,
 * called from `RunService.register`. A guard that only sees the HTTP method
 * cannot tell a small manifest from a large one without parsing the body, and a
 * guard that parses bodies is a second, competing validation layer.
 *
 * It also does not enforce the quota on reads. A sandbox that has run out of
 * runs can still be looked at, and being able to look at what you made is the
 * entire point of having made it.
 */

/** Verbs that cannot change state. `HEAD` and `OPTIONS` are reads by definition. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class SandboxQuotaGuard implements CanActivate {
  constructor(
    private readonly sandbox: SandboxService,
    private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // A deployment that cannot create sandboxes cannot be holding one, so this
    // costs nothing at all where it buys nothing at all.
    if (!this.config.sandbox.enabled) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AliquotRequest>();
    if (SAFE_METHODS.has(request.method.toUpperCase())) {
      return true;
    }

    // Absent on public routes and on anything the authentication guard did not
    // resolve. `POST /v1/sandbox` is one of those -- provisioning must not be
    // gated on a quota belonging to a tenant the caller does not yet have.
    const ctx = request.context;
    if (ctx === undefined) {
      return true;
    }

    // Null for a permanent tenant, which is the common case and is answered
    // from memory after the first request. One statement carries kind, expiry
    // and both usage counters, so a sandbox request costs one round trip here
    // rather than three.
    const state = await this.sandbox.state(ctx);
    if (state === null) {
      return true;
    }

    this.sandbox.assertWithinQuota(state);
    // After the stored quotas, because a sandbox that is already over its run
    // or byte allowance should say so rather than reporting a write count.
    this.sandbox.countWrite(ctx.tenantId);
    return true;
  }
}
