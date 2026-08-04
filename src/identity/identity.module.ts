import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuditModule } from '../audit/audit.module';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { DemoReadOnlyGuard } from './demo-readonly.guard';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { FixedWindowRateLimiter } from './rate-limiter';
import { SandboxController } from './sandbox.controller';
import { SandboxQuotaGuard } from './sandbox-quota.guard';
import { SandboxReaper } from './sandbox-reaper';
import { SandboxService } from './sandbox.service';
import { TenantRegistry } from './tenant-registry';

/**
 * Identity: principals, credentials, authorisation, and the administrative
 * endpoints for the tenant's own identity data.
 *
 * `@Global` because `AuthService` is a genuine cross-cutting concern -- audit,
 * ingestion and provenance all authorise against study roles -- and the
 * alternative is every feature module importing this one to reach a single
 * stateless service. It is also not merely stateless: `TenantRegistry` memoises
 * credential lookups and `SandboxService` memoises which tenants are permanent,
 * so a second instance would be a second cache with the same misses to pay.
 *
 * `APP_GUARD` is bound here rather than left to the root composition, which is
 * the load-bearing decision in this file. Authentication that has to be
 * remembered somewhere else is authentication that will one day be forgotten
 * there, and the failure is silent: routes serve tenant data and nothing looks
 * wrong. Importing this module makes every Nest route require a credential, and
 * a route that should not is marked `@Public()` at the route. **The root module
 * must not bind `AuthGuard` again** -- a second binding would resolve the
 * principal twice per request, at the cost of a second scrypt derivation on
 * every instrument call.
 *
 * `DatabaseService`, `AppConfig`, `Logger` and `ObjectStore` are not provided
 * here. They are process singletons -- one pool, one parsed configuration, one
 * S3 client -- and re-providing them in a feature module would quietly create a
 * second of each. `ObjectStore` reaches `SandboxReaper` through
 * `StorageModule`'s `@Global()` binding.
 */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [IdentityController, SandboxController],
  providers: [
    AuthService,
    AuthGuard,
    DemoReadOnlyGuard,
    FixedWindowRateLimiter,
    IdentityService,
    SandboxService,
    SandboxQuotaGuard,
    // Provided here, started nowhere here. `src/worker.ts` calls `run()`
    // explicitly, for the same reason `WorkerRuntime` is started explicitly: the
    // API imports this module too, and an `onApplicationBootstrap` would turn
    // every API replica into a second reaper racing the first.
    SandboxReaper,
    TenantRegistry,
    { provide: APP_GUARD, useExisting: AuthGuard },
    // Ordered, not merely listed. Global guards run in registration order.
    //
    // `DemoReadOnlyGuard` reads the `request.principal` that `AuthGuard`
    // establishes; registered first it would find none on every request and
    // would let a demo session mutate. `test/integration/demo-mode.spec.ts`
    // asserts the outcome rather than the ordering, so a future reshuffle fails
    // as a demo session successfully registering a run.
    //
    // `SandboxQuotaGuard` reads `request.context` from the same place and sits
    // after the demo guard so that a demo session -- which may not write at all
    // -- is refused as a demo session rather than being told about a quota it
    // does not have.
    { provide: APP_GUARD, useExisting: DemoReadOnlyGuard },
    { provide: APP_GUARD, useExisting: SandboxQuotaGuard },
  ],
  exports: [AuthService, AuthGuard, SandboxService, SandboxReaper],
})
export class IdentityModule {}
