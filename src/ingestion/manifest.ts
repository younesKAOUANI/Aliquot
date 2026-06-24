import { digestCanonical, isSha256Hex } from '../common/digest';
import type { Sha256Hex } from '../common/digest';
import { AliquotError, ProblemType, ValidationError } from '../common/problem-details';

/**
 * The declared manifest and the digest taken over it.
 *
 * `manifest_digest` is fixed at registration and recomputed from the
 * `run_artifact` rows at seal. That comparison is the only thing standing
 * between "this run uploaded everything it said it would" and "this run uploaded
 * everything it decided to admit to", so the byte string being digested has to
 * be pinned exactly, in one place, used by both sides.
 */

/**
 * One declared artifact, normalised.
 *
 * `sizeBytes` is a decimal string rather than a number, and that is the whole
 * reason this type exists separately from the request schema. `declared_size` is
 * a bigint, so it arrives back from the driver as a string; if registration
 * digested a JSON number and seal digested the string the driver returned, the
 * digest would move for every run and the check would fail closed on healthy
 * data. Fixing the canonical form as a string means the value that goes in and
 * the value that comes back are the same characters.
 */
export interface ManifestEntry {
  readonly logicalName: string;
  readonly digest: Sha256Hex;
  /** Unsigned decimal, no leading zeros -- one spelling per value. */
  readonly sizeBytes: string;
  readonly mediaType: string;
}

/**
 * The exact JSON that gets canonicalised and hashed.
 *
 * Declared as its own type so that adding a field to `ManifestEntry` is not
 * silently a change to every stored `manifest_digest`. Key order is irrelevant
 * -- RFC 8785 sorts it -- but the field *set* is the contract.
 */
export interface CanonicalManifestEntry {
  logicalName: string;
  digest: string;
  sizeBytes: string;
  mediaType: string;
}

const UNSIGNED_DECIMAL = /^(0|[1-9]\d*)$/;

/** Mirrors `run_artifact_name_shape` and `run_artifact_name_length` in migration 0004. */
const LOGICAL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const LOGICAL_NAME_MAX = 512;

/**
 * The canonical manifest: entries sorted by logical name, each reduced to the
 * four fields that constitute a declaration.
 *
 * Sorted with a plain code-unit comparison rather than `localeCompare`, which is
 * locale-dependent -- a service started under a different `LANG` would order
 * `a-b` and `ab` differently and compute a different digest for an untouched
 * manifest. The sort is total because logical names are unique per run, enforced
 * by `run_artifact_name_unique_per_run` and re-checked here.
 */
export function canonicalManifest(entries: readonly ManifestEntry[]): CanonicalManifestEntry[] {
  return [...entries]
    .sort((left, right) => compareCodeUnits(left.logicalName, right.logicalName))
    .map((entry) => ({
      logicalName: entry.logicalName,
      digest: entry.digest,
      sizeBytes: entry.sizeBytes,
      mediaType: entry.mediaType,
    }));
}

export function manifestDigest(entries: readonly ManifestEntry[]): Sha256Hex {
  return digestCanonical(canonicalManifest(entries));
}

/**
 * Reject a manifest that cannot be a manifest.
 *
 * Run on the way in from a client and again on the way back out of the database
 * at seal. The second call can only fail if a stored row has become something
 * the schema says is impossible, and it costs a regex per artifact -- cheap
 * insurance for the one check the integrity guarantee rests on.
 *
 * An empty manifest is rejected rather than treated as a run with nothing in it.
 * A run that declares nothing can be sealed the instant it is registered, and
 * "sealed" would then mean nothing at all.
 */
export function assertWellFormedManifest(entries: readonly ManifestEntry[]): void {
  if (entries.length === 0) {
    throw new ValidationError('manifest must declare at least one artifact');
  }

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.logicalName)) {
      throw new ValidationError(
        `manifest declares ${JSON.stringify(entry.logicalName)} more than once`,
      );
    }
    seen.add(entry.logicalName);

    if (entry.logicalName.length > LOGICAL_NAME_MAX || !LOGICAL_NAME.test(entry.logicalName)) {
      throw new ValidationError(
        `manifest logical names must be 1-${LOGICAL_NAME_MAX} characters, must start with a ` +
          'letter or digit, and may contain only letters, digits, dot, underscore, slash and ' +
          `hyphen; got ${JSON.stringify(entry.logicalName)}`,
      );
    }

    if (!isSha256Hex(entry.digest)) {
      throw new ValidationError(
        `manifest entry ${entry.logicalName} declares ${JSON.stringify(entry.digest)}, ` +
          'which is not 64 lower-case hex characters',
      );
    }

    if (!UNSIGNED_DECIMAL.test(entry.sizeBytes)) {
      throw new ValidationError(
        `manifest entry ${entry.logicalName} declares a size of ` +
          `${JSON.stringify(entry.sizeBytes)}, which is not an unsigned decimal integer`,
      );
    }
  }
}

/**
 * A logical name that is not in the run's manifest.
 *
 * `ProblemType.ARTIFACT_NOT_DECLARED` is part of the published error vocabulary
 * but has no class in `src/common/problem-details.ts`; declaring it here rather
 * than reaching for a generic 404 keeps the `type` field stable for clients that
 * switch on it, which is the entire point of RFC 9457's `type`.
 */
export class ArtifactNotDeclaredError extends AliquotError {
  constructor(runId: string, logicalName: string) {
    super(
      ProblemType.ARTIFACT_NOT_DECLARED,
      404,
      'Artifact is not declared in this run',
      `Run ${runId} declares no artifact named ${logicalName}. The manifest is fixed at ` +
        'registration; an artifact that was not declared cannot be added to it.',
      { runId, logicalName },
    );
  }
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
