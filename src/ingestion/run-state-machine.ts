import { IllegalTransitionError } from '../common/problem-details';
import type { RunState, RunTable } from '../database/schema';

/**
 * The run lifecycle, written once as data.
 *
 * This table exists in two places -- here and in
 * `aliquot.enforce_run_immutability()` in `migrations/0004_runs.sql` -- and the
 * duplication is deliberate. The trigger is the one that holds when a row is
 * reached by a migration script, a psql session, or a service method somebody
 * writes next year; this file is the one a reader can understand in thirty
 * seconds and the one the unit suite can exhaust. **If they ever disagree, the
 * database is right and this file is the bug.**
 *
 * The two are not symmetric, and it matters where they differ:
 *
 *   - Out of `OPEN`, the trigger permits everything. It returns early because an
 *     open run is still ordinary mutable data, so nothing below the application
 *     rejects `OPEN -> PROCESSED`. The `OPEN` row here is therefore the *only*
 *     definition of what an open run may become.
 *   - Out of every other state, the trigger enumerates exactly four transitions.
 *     Those four are reproduced in `DATABASE_ENFORCED_TRANSITIONS` so the
 *     containment property -- this table never permits a post-seal transition the
 *     database would reject -- is mechanically checkable rather than a claim in a
 *     comment.
 *   - `QUARANTINED` and `ABANDONED` are stronger than "no outgoing transitions":
 *     the trigger rejects *any* update to such a row, including one that changes
 *     nothing. See `FROZEN_RUN_STATES`.
 */

/**
 * Every legal transition, keyed by origin state.
 *
 * A `Record<RunState, ...>` rather than a list of pairs, so that adding a state
 * to the enum is a compile error here rather than a quietly missing row that
 * reads as "no transitions defined" and behaves as a dead end.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = Object.freeze({
  // Registration lands here, and everything that can go wrong with a run goes
  // wrong from here: it is sealed when the manifest is complete, quarantined
  // when stored bytes contradict the declaration, abandoned when the operator
  // gives up on it.
  OPEN: ['SEALED', 'QUARANTINED', 'ABANDONED'],

  // The immutability boundary. The only thing that may happen to a sealed run is
  // that something starts processing it; correcting it means minting a new run
  // that supersedes it (ADR-010), which is a registration, not a transition.
  SEALED: ['PROCESSING'],

  PROCESSING: ['PROCESSED', 'PROCESSING_FAILED'],

  // Retry. The worker's attempt budget lives on the job row, not here -- this
  // edge says a retry is legal, not that another one is owed.
  PROCESSING_FAILED: ['PROCESSING'],

  PROCESSED: [],
  QUARANTINED: [],
  ABANDONED: [],
});

/**
 * Every state, as values.
 *
 * Derived from the keys of the transition table rather than written out a second
 * time: `RUN_TRANSITIONS` is a total `Record<RunState, ...>`, so its keys are
 * exactly the states, and a list maintained alongside it would eventually not be.
 */
export const RUN_STATES: readonly RunState[] = Object.freeze(
  Object.keys(RUN_TRANSITIONS).filter(isRunState),
);

export function isRunState(value: string): value is RunState {
  return Object.hasOwn(RUN_TRANSITIONS, value);
}

/**
 * The transitions `enforce_run_immutability()` enumerates, verbatim.
 *
 * Transcribed from the trigger rather than derived from `RUN_TRANSITIONS`, since
 * deriving it would make the two agree by construction and prove nothing.
 */
export const DATABASE_ENFORCED_TRANSITIONS: readonly (readonly [RunState, RunState])[] =
  Object.freeze([
    ['SEALED', 'PROCESSING'],
    ['PROCESSING', 'PROCESSED'],
    ['PROCESSING', 'PROCESSING_FAILED'],
    ['PROCESSING_FAILED', 'PROCESSING'],
  ]);

/**
 * States in which the database rejects every UPDATE to the run row, whatever it
 * touches. A caller cannot record anything further about such a run -- not a
 * processing attempt, not a correction -- which is what makes them terminal in a
 * stronger sense than `PROCESSED`.
 */
export const FROZEN_RUN_STATES: readonly RunState[] = Object.freeze(['QUARANTINED', 'ABANDONED']);

/**
 * The allow-list the trigger diffs against: columns that may still move once a
 * run is sealed, because they describe what was done *to* the run rather than
 * what the run is.
 *
 * Typed as `keyof RunTable` so a column renamed in `schema.ts` fails to compile
 * here, which is the cheapest available reminder that the trigger's array needs
 * a migration to match.
 */
export const POST_SEAL_MUTABLE_COLUMNS: readonly (keyof RunTable)[] = Object.freeze([
  'state',
  'processing_attempts',
  'processing_started_at',
  'processing_completed_at',
  'processing_error',
]);

export function canTransition(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

/**
 * The same check as `canTransition`, as the guard clause callers actually want.
 *
 * The run id is a parameter rather than a field on some context object because
 * the resulting problem document names it, and "illegal transition" without the
 * subject is an error report nobody can act on.
 */
export function assertTransition(runId: string, from: RunState, to: RunState): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(runId, from, to);
  }
}

export function nextStates(from: RunState): readonly RunState[] {
  return RUN_TRANSITIONS[from];
}

/** No outgoing transitions. Not the same as frozen -- see `FROZEN_RUN_STATES`. */
export function isTerminal(state: RunState): boolean {
  return RUN_TRANSITIONS[state].length === 0;
}

/** The database rejects every UPDATE to a run in this state. */
export function isFrozen(state: RunState): boolean {
  return FROZEN_RUN_STATES.includes(state);
}
