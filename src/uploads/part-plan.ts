/**
 * How a declared size becomes a multipart layout.
 *
 * Pure arithmetic, in its own module because it is the part of the upload flow
 * that is worth testing exhaustively and the only part that can be tested
 * without a database or an object store. Every off-by-one here is a transfer
 * that either loses its last byte or asks the client for a part that does not
 * exist.
 *
 * The constants are S3's, not ours. They are protocol limits rather than
 * tuning: a part smaller than 5 MiB is rejected unless it is the last one, and
 * an upload of more than 10,000 parts cannot be completed at all.
 */

export const MIN_PART_SIZE_BYTES = 5n * 1024n * 1024n;
export const MAX_PART_SIZE_BYTES = 5n * 1024n * 1024n * 1024n;
export const MAX_PARTS = 10_000;

export interface PartPlan {
  partSize: bigint;
  totalParts: number;
}

export interface PartSpan {
  partNumber: number;
  /** Byte offset of the first byte of this part within the object. */
  offset: bigint;
  sizeBytes: bigint;
}

/**
 * Part size and count for an artifact of `declaredSize`.
 *
 * The configured part size is a floor, not a rule. A 64 MiB part is a good
 * default for a lab network, and it caps out at 640 GB before running out of
 * part numbers -- which a single light-sheet acquisition can exceed. Growing the
 * part size to fit is the only option that does not fail: the alternative,
 * refusing the upload and asking an operator to reconfigure the service, turns a
 * large-but-ordinary run into an outage.
 *
 * A zero-byte artifact still gets one part. It is a degenerate but legitimate
 * manifest entry -- an instrument log that was opened and never written -- and
 * the `total_parts` CHECK constraint requires at least one either way.
 */
export function planParts(declaredSize: bigint, preferredPartSize: number): PartPlan {
  if (declaredSize < 0n) {
    throw new Error(`declared size ${declaredSize} is negative`);
  }

  const preferred = BigInt(preferredPartSize);
  if (preferred < MIN_PART_SIZE_BYTES) {
    throw new Error(
      `configured part size ${preferred} is below the ${MIN_PART_SIZE_BYTES} byte minimum`,
    );
  }

  const partSize = maxBigInt(preferred, ceilDiv(declaredSize, BigInt(MAX_PARTS)));
  if (partSize > MAX_PART_SIZE_BYTES) {
    throw new Error(
      `artifact of ${declaredSize} bytes cannot be uploaded: it needs ${partSize} byte parts, ` +
        `above the ${MAX_PART_SIZE_BYTES} byte limit`,
    );
  }

  const parts = ceilDiv(declaredSize, partSize);
  return { partSize, totalParts: parts === 0n ? 1 : Number(parts) };
}

/**
 * Byte range of one part, so the client does not have to rediscover the
 * arithmetic. A client that computes the last part's length as a full part size
 * uploads padding, and padding changes the digest.
 */
export function partSpan(plan: PartPlan, declaredSize: bigint, partNumber: number): PartSpan {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > plan.totalParts) {
    throw new Error(`part ${partNumber} is outside 1..${plan.totalParts}`);
  }

  const offset = BigInt(partNumber - 1) * plan.partSize;
  const remaining = declaredSize - offset;
  return {
    partNumber,
    offset,
    sizeBytes: remaining < plan.partSize ? maxBigInt(remaining, 0n) : plan.partSize,
  };
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
