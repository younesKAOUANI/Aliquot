import { Injectable, SetMetadata } from '@nestjs/common';
import type { CanActivate, CustomDecorator, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { correlationIdOf } from '../http/correlation';
import type { AliquotRequest } from '../http/principal';
import { AuthService } from './auth.service';

/**
 * Authentication for every route, unless a route says otherwise.
 *
 * Bound as an `APP_GUARD` by `IdentityModule`, so the default for a new
 * controller is that it requires a credential. The opposite default -- opt in
 * per controller -- fails silently: a route added without the decorator serves
 * tenant data to anyone, and nothing about it looks wrong in review.
 *
 * The guard resolves the principal and builds the `RequestContext` from it. It
 * does not decide what the principal may do; that is `requireStudyRole`, called
 * by the handler that knows which study is involved.
 */

export const PUBLIC_ROUTE = 'aliquot:public-route';

/** Marks a handler or controller as reachable without a credential. */
export const Public = (): CustomDecorator<string> => SetMetadata(PUBLIC_ROUTE, true);

/**
 * Routes that must stay open but are declared in modules this one does not own.
 *
 * The probes are the case that matters: `readyz` is what the container
 * orchestrator polls, and a 401 there means the service never becomes healthy
 * and is restarted forever. Relying on the root module to remember to exclude
 * them makes a bootstrap loop the cost of forgetting, so the guard carries the
 * list itself. Swagger and the static viewer are absent deliberately -- both are
 * registered directly on the HTTP adapter rather than as Nest handlers, so no
 * guard runs for them at all.
 */
const ALWAYS_PUBLIC = new Set(['/healthz', '/readyz']);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AliquotRequest>();

    const declaredPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (declaredPublic === true || ALWAYS_PUBLIC.has(pathOf(request.url))) {
      return true;
    }

    const principal = await this.auth.resolvePrincipal(request.headers.authorization);

    request.principal = principal;
    request.context = this.auth.contextFor(principal, correlationIdOf(request));

    return true;
  }
}

/** Path without the query string, and without a trailing slash except at the root. */
function pathOf(url: string): string {
  const [path] = url.split('?');
  if (path === undefined || path.length === 0) {
    return '/';
  }
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}
