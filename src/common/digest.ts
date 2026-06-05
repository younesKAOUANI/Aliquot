import { createHash, timingSafeEqual } from 'node:crypto';

import { canonicalize } from './canonical-json';

/** Lower-case hex SHA-256. The only digest format this service stores. */
export type Sha256Hex = string;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: string): value is Sha256Hex {
  return SHA256_HEX.test(value);
}

export function assertSha256Hex(value: string, what = 'digest'): Sha256Hex {
  if (!isSha256Hex(value)) {
    throw new Error(`${what} must be 64 lower-case hex characters, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function sha256Hex(input: string | Uint8Array): Sha256Hex {
  return createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input)
    .digest('hex');
}

/**
 * Digest of a JSON value over its RFC 8785 canonical form.
 *
 * This is the only way JSON should be hashed anywhere in the service. Anything
 * that reaches for `sha256Hex(JSON.stringify(x))` has reintroduced the key
 * ordering problem that canonicalisation exists to remove.
 */
export function digestCanonical(value: unknown): Sha256Hex {
  return sha256Hex(canonicalize(value));
}

/**
 * Digest over an unordered set of digests.
 *
 * Used for a derivation's `inputs_digest`. Sorting first is what makes it a set
 * digest rather than a list digest: the same inputs supplied in a different
 * order are the same inputs, and a positional digest would let identical work
 * run twice and record two derivations.
 */
export function digestOfDigestSet(digests: readonly Sha256Hex[]): Sha256Hex {
  const unique = [...new Set(digests)].sort();
  return sha256Hex(unique.join('\n'));
}

/**
 * Constant-time comparison for digests and credentials.
 *
 * Digest comparison is not obviously timing-sensitive, but the same helper is
 * used for API key verification where it certainly is, and having one
 * comparison function means nobody has to remember which case they are in.
 */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Object storage key for a digest: `sha256/ab/cd/abcd...`.
 *
 * The two-level fan-out is not for S3's benefit -- it stopped needing prefix
 * sharding years ago -- it is for every filesystem-backed store and every
 * `aws s3 ls` a human will ever run against this bucket. A flat namespace with
 * a million siblings is technically fine and operationally miserable.
 */
export function storageKeyForDigest(digest: Sha256Hex): string {
  assertSha256Hex(digest);
  return `sha256/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
}
