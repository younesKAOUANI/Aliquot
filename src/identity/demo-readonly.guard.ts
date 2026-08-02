import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

import { ForbiddenError } from '../common/problem-details';
import type { AliquotRequest } from '../http/principal';
import { pathOf } from '../http/request-path';

/**
 * A demo session may read. It may not write. Nothing else about it is special.
 *
 * ## Why a method guard sits on top of the role checks
 *
 * The roles in this service are per study and they are data: a membership row
 * can be granted, and the demo account is a real account that a future seed, a
 * fixture, or an administrator clicking the wrong row could grant `steward` on.
 * Every authorisation decision downstream would then be correct and the demo
 * would be able to create checkpoints. "No demo session may ever mutate" is not
 * a statement about who the account is, it is a property of the deployment --
 * this instance is published on the open internet with a credential printed on
 * the front page -- and a property of the deployment belongs somewhere the data
 * cannot move it.
 *
 * So the two layers answer different questions and neither subsumes the other.
 * `requireStudyRole` asks what this principal is entitled to. This asks whether
 * this request can change anything at all, and the answer for a demo session is
 * no regardless of entitlement.
 *
 * ## Why an allow-list and not a substring match
 *
 * `POST /v1/audit/verify` is a read that happens to need a body, and it is the
 * most interesting thing on the site, so it is allowed. Matching that by asking
 * whether the URL contains `verify` would also allow anything a future route
 * spells with those characters, including a query parameter a caller chooses.
 * The list is exact method plus exact path, compared against the path with the
 * query string removed.
 *
 * The cost is stated plainly in ADR-0020: a new non-GET read endpoint is
 * blocked for demo sessions until it is added here, and the symptom is a 403
 * rather than a crash. That is the direction the mistake should fall.
 */

/** Verbs that cannot change state. `HEAD` and `OPTIONS` are reads by definition. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * `${method} ${path}`, exact. Two entries, both deliberate:
 *
 *   - chain verification, which reads the audit chain end to end and writes
 *     nothing. Checkpoint creation, on the same controller, is a write and is
 *     deliberately absent;
 *   - the demo sign-in itself. It is `@Public()`, so `AuthGuard` returns before
 *     resolving a principal and this guard sees none regardless -- the entry
 *     exists so that re-signing-in stays allowed if that route ever stops being
 *     public, rather than becoming unreachable to the sessions it issues.
 */
const ALLOWED_WRITES = new Set(['POST /v1/auth/demo', 'POST /v1/audit/verify']);

@Injectable()
export class DemoReadOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AliquotRequest>();

    // Absent on public routes and on anything the authentication guard did not
    // resolve. Those are unauthenticated requests, which have no demo session to
    // restrict; whether they are allowed at all is AuthGuard's decision.
    if (request.principal?.isDemo !== true) {
      return true;
    }

    const method = request.method.toUpperCase();
    if (SAFE_METHODS.has(method)) {
      return true;
    }
    if (ALLOWED_WRITES.has(`${method} ${pathOf(request.url)}`)) {
      return true;
    }

    throw new ForbiddenError(
      `This is a read-only demo session. ${method} is not available on it; ` +
        'the demo may read every endpoint and change nothing.',
      'a non-demo session',
    );
  }
}
