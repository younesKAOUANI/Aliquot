import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuditModule } from '../audit/audit.module';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { TenantRegistry } from './tenant-registry';

/**
 * Identity: principals, credentials, authorisation, and the administrative
 * endpoints for the tenant's own identity data.
 *
 * `@Global` because `AuthService` is a genuine cross-cutting concern -- audit,
 * ingestion and provenance all authorise against study roles -- and the
 * alternative is every feature module importing this one to reach a single
 * stateless service. It is also not merely stateless: `TenantRegistry` memoises
 * credential lookups, so a second instance would be a second cache with the same
 * misses to pay.
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
 * `DatabaseService`, `AppConfig` and `Logger` are not provided here. They are
 * process singletons -- one pool, one parsed configuration -- and re-providing
 * them in a feature module would quietly create a second of each.
 */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [IdentityController],
  providers: [
    AuthService,
    AuthGuard,
    IdentityService,
    TenantRegistry,
    { provide: APP_GUARD, useExisting: AuthGuard },
  ],
  exports: [AuthService, AuthGuard],
})
export class IdentityModule {}
