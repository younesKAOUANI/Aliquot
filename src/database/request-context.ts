import type { ActorType } from './schema';

/**
 * Everything the database session needs to know about who is asking.
 *
 * This object is threaded explicitly through every call rather than held in
 * async-local storage. Ambient context is more convenient and strictly worse
 * here: an implicit tenant is exactly the kind of thing that gets lost across a
 * queue boundary or a `setTimeout` and comes back as somebody else's, and the
 * failure is silent. Making it a parameter means the type system will not let a
 * data-access function be called without saying whose data it is.
 */
export interface RequestContext {
  readonly tenantId: string;
  readonly actorType: ActorType;
  readonly actorId: string | null;
  /** Human-readable actor, denormalised into every audit event it produces. */
  readonly actorLabel: string;
  /** Propagated from the inbound request through to the worker for log stitching. */
  readonly correlationId: string;
  /**
   * Database role to assume for the transaction. The API always runs as
   * `aliquot_app`; only the worker's claim loop runs as `aliquot_worker`.
   */
  readonly dbRole: DatabaseRole;
}

export type DatabaseRole = 'aliquot_app' | 'aliquot_worker';

/**
 * Context for work the system does on its own behalf -- checkpointing, expiry
 * sweeps, a worker acting on a claimed job. `actorType: 'system'` is a real
 * category in the audit trail, not a null actor: "nobody did this" is never an
 * acceptable answer, so an automated action is attributed to the automation.
 */
export function systemContext(
  tenantId: string,
  correlationId: string,
  options: { label?: string; dbRole?: DatabaseRole } = {},
): RequestContext {
  return {
    tenantId,
    actorType: 'system',
    actorId: null,
    actorLabel: options.label ?? 'aliquot',
    correlationId,
    dbRole: options.dbRole ?? 'aliquot_app',
  };
}
