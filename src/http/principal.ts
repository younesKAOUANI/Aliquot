import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';

import { UnauthenticatedError } from '../common/problem-details';
import type { RequestContext } from '../database/request-context';

/**
 * Who is making the request, as resolved from the credential.
 *
 * Separate from `RequestContext` on purpose. A principal is an authentication
 * outcome; a `RequestContext` is an authorisation and database-session
 * decision derived from it, and the two diverge -- a worker builds a context
 * for a tenant with no principal at all.
 */
export interface Principal {
  tenantId: string;
  actorType: 'user' | 'instrument';
  actorId: string;
  label: string;
  /**
   * True only for a session minted by `POST /v1/auth/demo`.
   *
   * Not optional. `DemoReadOnlyGuard` refuses a request when this is true, so
   * an undefined that some future principal-producing path forgot to set would
   * fail open, and the failure would be silent. A required boolean makes
   * forgetting it a compile error.
   */
  isDemo: boolean;
}

/**
 * The request object as everything downstream of the guard sees it.
 *
 * Declared here rather than as a global `declare module` augmentation of
 * Fastify: an ambient augmentation would make `request.principal` appear on
 * every request in the codebase, including the ones that never passed a guard,
 * and the optionality is exactly the signal that matters. It is exported so
 * identity, ingestion and the exception filter share one definition instead of
 * each redeclaring a slightly different one.
 */
export interface AliquotRequest {
  /** Assigned by CorrelationMiddleware; read it through `correlationIdOf`. */
  correlationId: string;
  /** Attached by the authentication guard. Absent on public routes. */
  principal?: Principal;
  /** Attached by the authentication guard, derived from the principal. */
  context?: RequestContext;
  headers: IncomingHttpHeaders;
  url: string;
  method: string;
  /**
   * Source address as Fastify resolved it, honouring `X-Forwarded-For` because
   * the adapter is constructed with `trustProxy`.
   *
   * Optional because this interface describes the request as *our* code sees
   * it, and the in-process injection the integration suite uses does not always
   * carry one. A caller that needs it must decide what an absent address means
   * rather than being handed a plausible default.
   */
  ip?: string;
}

/**
 * The authenticated principal, or a 401.
 *
 * Throwing when the guard has not run is deliberate. The alternative -- handing
 * the handler `undefined` and letting it decide -- turns a missing guard into a
 * null dereference somewhere further in, long after the request stopped being
 * attributable.
 */
export const CurrentPrincipal: () => ParameterDecorator = createParamDecorator(
  (_data: unknown, host: ExecutionContext): Principal => {
    const request = host.switchToHttp().getRequest<AliquotRequest>();
    if (!request.principal) {
      throw new UnauthenticatedError();
    }
    return request.principal;
  },
);

/** The tenant-scoped database context for this request, or a 401. */
export const Ctx: () => ParameterDecorator = createParamDecorator(
  (_data: unknown, host: ExecutionContext): RequestContext => {
    const request = host.switchToHttp().getRequest<AliquotRequest>();
    if (!request.context) {
      throw new UnauthenticatedError();
    }
    return request.context;
  },
);
