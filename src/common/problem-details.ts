/**
 * RFC 9457 problem details.
 *
 * Chosen over a bespoke `{ error: { code, message } }` envelope because the
 * clients here are instrument agents written in whatever the vendor shipped,
 * often years ago, by someone who is not going to read our error documentation.
 * A registered media type with a documented shape gives them something to
 * program against generically, and `type` gives us a stable identifier to hang
 * per-error documentation off without churning the human-readable `title`.
 */

export interface ProblemDetails {
  /** URI reference identifying the problem type. Stable; safe to switch on. */
  type: string;
  /** Short human-readable summary. May be reworded without it being a breaking change. */
  title: string;
  status: number;
  /** Human-readable explanation specific to this occurrence. */
  detail?: string;
  /** URI reference identifying the specific occurrence. */
  instance?: string;
  [extension: string]: unknown;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

const TYPE_BASE = 'https://aliquot.dev/problems';

export const ProblemType = {
  VALIDATION_FAILED: `${TYPE_BASE}/validation-failed`,
  IDEMPOTENCY_KEY_REUSED: `${TYPE_BASE}/idempotency-key-reused`,
  IDEMPOTENT_REQUEST_IN_FLIGHT: `${TYPE_BASE}/idempotent-request-in-flight`,
  ILLEGAL_STATE_TRANSITION: `${TYPE_BASE}/illegal-state-transition`,
  MANIFEST_INCOMPLETE: `${TYPE_BASE}/manifest-incomplete`,
  DIGEST_MISMATCH: `${TYPE_BASE}/digest-mismatch`,
  ARTIFACT_NOT_DECLARED: `${TYPE_BASE}/artifact-not-declared`,
  RUN_SEALED: `${TYPE_BASE}/run-sealed`,
  NOT_FOUND: `${TYPE_BASE}/not-found`,
  FORBIDDEN: `${TYPE_BASE}/forbidden`,
  UNAUTHENTICATED: `${TYPE_BASE}/unauthenticated`,
  CHAIN_BROKEN: `${TYPE_BASE}/chain-broken`,
  CONFLICT: `${TYPE_BASE}/conflict`,
  RATE_LIMITED: `${TYPE_BASE}/rate-limited`,
  DEMO_UNAVAILABLE: `${TYPE_BASE}/demo-unavailable`,
  INTERNAL: `${TYPE_BASE}/internal`,
} as const;

/**
 * Base class for every error this service raises deliberately.
 *
 * Errors that reach the filter without being one of these are logged with a
 * stack and rendered as a bare 500 with no detail, because an unplanned error
 * message is exactly the kind of thing that leaks a table name or a file path.
 */
export class AliquotError extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
    this.name = new.target.name;
  }

  toProblem(instance?: string): ProblemDetails {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      ...(instance !== undefined ? { instance } : {}),
      ...this.extensions,
    };
  }
}

export class ValidationError extends AliquotError {
  constructor(detail: string, issues: unknown[] = []) {
    super(ProblemType.VALIDATION_FAILED, 400, 'Request validation failed', detail, { issues });
  }
}

export class UnauthenticatedError extends AliquotError {
  constructor(detail = 'A valid credential is required.') {
    super(ProblemType.UNAUTHENTICATED, 401, 'Unauthenticated', detail);
  }
}

export class ForbiddenError extends AliquotError {
  constructor(detail: string, required?: string) {
    super(ProblemType.FORBIDDEN, 403, 'Forbidden', detail, {
      ...(required ? { requiredPermission: required } : {}),
    });
  }
}

export class NotFoundError extends AliquotError {
  /**
   * Note that a row hidden by row-level security is indistinguishable from a
   * row that does not exist, and that is intentional: a 403 would confirm the
   * identifier is real and belongs to somebody.
   */
  constructor(resource: string, id: string) {
    super(ProblemType.NOT_FOUND, 404, 'Not found', `No ${resource} with id ${id}.`, {
      resource,
      resourceId: id,
    });
  }
}

export class ConflictError extends AliquotError {
  constructor(detail: string, extensions: Record<string, unknown> = {}) {
    super(ProblemType.CONFLICT, 409, 'Conflict', detail, extensions);
  }
}

export class IdempotencyKeyReusedError extends AliquotError {
  constructor(key: string, endpoint: string) {
    super(
      ProblemType.IDEMPOTENCY_KEY_REUSED,
      409,
      'Idempotency key reused with a different request body',
      `Key ${key} was already used on ${endpoint} with a materially different body. ` +
        'Use a new key for a new request, or resend the original body to replay.',
      { idempotencyKey: key, endpoint },
    );
  }
}

export class IdempotentRequestInFlightError extends AliquotError {
  constructor(
    key: string,
    readonly retryAfterSeconds: number,
  ) {
    super(
      ProblemType.IDEMPOTENT_REQUEST_IN_FLIGHT,
      409,
      'An identical request is already in flight',
      `Key ${key} is being processed. Retry after ${retryAfterSeconds}s to collect the result.`,
      { idempotencyKey: key, retryAfterSeconds },
    );
  }
}

/**
 * Too many requests from one caller inside a window.
 *
 * `retryAfterSeconds` is both an extension member and the value the filter
 * renders into the `Retry-After` header, for the same reason
 * `IdempotentRequestInFlightError` carries one: a 429 without it invites an
 * immediate retry, and a client that retries immediately turns a limiter into a
 * busy loop it is paying for.
 */
export class RateLimitedError extends AliquotError {
  constructor(
    detail: string,
    readonly retryAfterSeconds: number,
  ) {
    super(ProblemType.RATE_LIMITED, 429, 'Too many requests', detail, { retryAfterSeconds });
  }
}

/**
 * The demo is switched on but the data it is configured against is not there.
 *
 * 503 and not 401. The caller supplied nothing and got nothing wrong; the
 * deployment is incompletely provisioned, and saying so is the only way an
 * operator finds out. Minting a session for some other account, or creating the
 * configured one on the fly, would turn a visible misconfiguration into a
 * principal nobody decided to grant.
 */
export class DemoUnavailableError extends AliquotError {
  constructor(detail: string) {
    super(ProblemType.DEMO_UNAVAILABLE, 503, 'Demo dataset unavailable', detail);
  }
}

export class IllegalTransitionError extends AliquotError {
  constructor(runId: string, from: string, to: string) {
    super(
      ProblemType.ILLEGAL_STATE_TRANSITION,
      409,
      'Illegal state transition',
      `Run ${runId} is ${from}; ${to} is not reachable from there.`,
      { runId, fromState: from, toState: to },
    );
  }
}

export class ManifestIncompleteError extends AliquotError {
  constructor(runId: string, outstanding: { logicalName: string; state: string }[]) {
    super(
      ProblemType.MANIFEST_INCOMPLETE,
      409,
      'Manifest is not fully verified',
      `Run ${runId} cannot be sealed: ${outstanding.length} declared artifact(s) are not verified.`,
      { runId, outstanding },
    );
  }
}

export class DigestMismatchError extends AliquotError {
  constructor(logicalName: string, declared: string, computed: string) {
    super(
      ProblemType.DIGEST_MISMATCH,
      422,
      'Stored bytes do not match the declared digest',
      `Artifact ${logicalName} was declared as ${declared} but stored as ${computed}.`,
      { logicalName, declaredDigest: declared, computedDigest: computed },
    );
  }
}
