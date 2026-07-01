import { AliquotError, ProblemType } from '../common/problem-details';
import type { RunState } from '../database/schema';

/**
 * Problem types the upload flow raises that nothing else already provides a
 * class for.
 *
 * `ArtifactNotDeclaredError` is deliberately not here -- ingestion owns it in
 * `src/ingestion/manifest.ts`, because the manifest is its concept and two
 * classes carrying the same `ProblemType` with different status codes would be
 * a contradiction visible to clients.
 *
 * `RunNotOpenError` attaches a class to a `ProblemType` constant that already
 * existed and had none. `SizeMismatchError` declares its own URI, the same way
 * `NotReadyError` does in the health controller: a size mismatch is not a digest
 * mismatch, and reporting it as one would send a client looking for corruption
 * when what actually happened is that it uploaded a different number of bytes
 * than it promised.
 */

const SIZE_MISMATCH_TYPE = 'https://aliquot.dev/problems/size-mismatch';

/** Uploads only happen while a run is OPEN. Everything past that point is frozen. */
export class RunNotOpenError extends AliquotError {
  constructor(runId: string, state: RunState) {
    super(
      ProblemType.RUN_SEALED,
      409,
      'Run is not open for upload',
      `Run ${runId} is ${state}; artifact bindings can only change while a run is OPEN.`,
      { runId, state },
    );
  }
}

/**
 * Stored size disagrees with the declared size.
 *
 * Both numbers are rendered as strings because they are `bigint` values and a
 * problem document is serialised as JSON, which has no way to carry one.
 */
export class SizeMismatchError extends AliquotError {
  constructor(logicalName: string, declared: bigint, stored: bigint) {
    super(
      SIZE_MISMATCH_TYPE,
      422,
      'Stored object is not the declared size',
      `Artifact ${logicalName} was declared as ${declared} bytes but ${stored} bytes were stored.`,
      {
        logicalName,
        declaredSize: declared.toString(),
        storedSize: stored.toString(),
      },
    );
  }
}
