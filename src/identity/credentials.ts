import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Instrument API keys.
 *
 * The key is `aliq_` followed by 32 base64url characters -- 192 bits of
 * randomness from `randomBytes`, rendered without padding. The scheme prefix is
 * not decoration: it is what lets the authentication path decide between a
 * machine credential and a user session token by looking at the first five
 * characters, and it is what makes a leaked key greppable in a log aggregator or
 * a git history.
 *
 * Only the hash is stored. The first twelve characters are stored in clear as
 * well, so an incoming credential is located by an indexed lookup rather than by
 * deriving a hash against every instrument in the database. Those twelve
 * characters carry ~42 bits of the key, which is far too little to be worth
 * attacking and far more than enough to be unique.
 *
 * ## Why scrypt from node:crypto rather than argon2
 *
 * Argon2id is the better password hash and it is what this would use if the cost
 * were only technical. It is not: every argon2 binding for Node is a native
 * module, and a native module is a compiler in the image, a prebuild that may not
 * exist for the reviewer's architecture, and a `docker compose up` that fails on
 * a machine nobody here can inspect. That is a real, recurring cost paid by
 * everyone who clones this repository, weighed against a marginal gain -- the
 * secret being protected is 192 uniformly random bits, not a human-chosen
 * password, so the offline attack that argon2's memory hardness is designed to
 * frustrate is already infeasible against a single SHA-256 of the same input.
 * scrypt ships in the standard library, is memory-hard, and is sufficient here.
 *
 * The honest counterpoint: scrypt at these parameters costs tens of milliseconds
 * per verification, and instruments authenticate on every upload call. If that
 * latency ever matters, the answer is not weaker scrypt parameters -- it is to
 * recognise that a high-entropy random token does not need a slow KDF at all and
 * move to an HMAC under a server-held key.
 */

/** Distinguishes an instrument credential from a session token in one comparison. */
export const API_KEY_SCHEME = 'aliq_';

/** Stored in clear in `instrument.api_key_prefix`, which carries a unique index. */
export const API_KEY_PREFIX_LENGTH = 12;

/** 24 bytes render as exactly 32 base64url characters, so the key has a fixed length. */
const KEY_RANDOM_BYTES = 24;

const KEY_PATTERN = /^aliq_[A-Za-z0-9_-]{32}$/;

/**
 * N=2^14, r=8, p=1 are the parameters RFC 7914 suggests for interactive use and
 * cost 16 MiB of memory per derivation. They are recorded in the stored string
 * rather than assumed, so raising them later does not invalidate every existing
 * credential -- an old key keeps verifying under the parameters it was created
 * with, and is upgraded when it is rotated.
 */
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;

/**
 * Bounds on what a stored string may ask us to compute. The values come from our
 * own database and are not attacker-controlled, but an unbounded N read out of a
 * corrupted row would try to allocate its way through the heap, and a lower bound
 * stops a silently weakened parameter set from being accepted as valid.
 */
const MIN_COST = 1 << 12;
const MAX_COST = 1 << 17;
const MAX_MEMORY_BYTES = 128 * 1024 * 1024;

export interface GeneratedApiKey {
  /** Plaintext. Returned to the caller exactly once and never stored or logged. */
  key: string;
  prefix: string;
  /** Self-describing: `scrypt$N$r$p$salt$hash`, both fields base64url. */
  hash: string;
}

export async function generateApiKey(): Promise<GeneratedApiKey> {
  const key = API_KEY_SCHEME + randomBytes(KEY_RANDOM_BYTES).toString('base64url');
  return { key, prefix: apiKeyPrefix(key), hash: await hashApiKey(key) };
}

/** True for anything claiming to be an instrument credential, well-formed or not. */
export function usesApiKeyScheme(value: string): boolean {
  return value.startsWith(API_KEY_SCHEME);
}

/** True only for a credential of exactly the shape this service issues. */
export function isApiKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

export function apiKeyPrefix(key: string): string {
  return key.slice(0, API_KEY_PREFIX_LENGTH);
}

export async function hashApiKey(key: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await derive(key, salt, COST, BLOCK_SIZE, PARALLELISM, KEY_LENGTH);

  return [
    'scrypt',
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Constant-time verification.
 *
 * The derivation is asked for exactly as many bytes as the stored digest holds,
 * so the comparison is always length-matched -- `timingSafeEqual` throws rather
 * than returning false when it is not, and a throw here would be a 500 in place
 * of a 401. The parameters come from the stored string, so a credential issued
 * under an older cost keeps verifying after the cost is raised.
 */
export async function verifyApiKey(key: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  const derived = await derive(
    key,
    parsed.salt,
    parsed.cost,
    parsed.blockSize,
    parsed.parallelism,
    parsed.hash.length,
  );

  return timingSafeEqual(derived, parsed.hash);
}

interface StoredHash {
  cost: number;
  blockSize: number;
  parallelism: number;
  salt: Buffer;
  hash: Buffer;
}

/**
 * A stored value that cannot be parsed throws rather than returning `false`.
 *
 * The distinction matters operationally: a wrong key is a 401 the caller can act
 * on, and an unparseable stored hash is a corrupted row that needs a human.
 * Collapsing the second into the first would present a broken credential as a
 * rejected one and send the operator looking in the wrong place.
 */
function parseStoredHash(stored: string): StoredHash {
  const parts = stored.split('$');
  const [algorithm, cost, blockSize, parallelism, salt, hash] = parts;

  if (
    parts.length !== 6 ||
    algorithm !== 'scrypt' ||
    cost === undefined ||
    blockSize === undefined ||
    parallelism === undefined ||
    salt === undefined ||
    hash === undefined
  ) {
    throw new Error('stored credential is not in scrypt$N$r$p$salt$hash form');
  }

  const parsed: StoredHash = {
    cost: positiveInteger(cost, 'N'),
    blockSize: positiveInteger(blockSize, 'r'),
    parallelism: positiveInteger(parallelism, 'p'),
    salt: Buffer.from(salt, 'base64url'),
    hash: Buffer.from(hash, 'base64url'),
  };

  if (parsed.cost < MIN_COST || parsed.cost > MAX_COST || (parsed.cost & (parsed.cost - 1)) !== 0) {
    throw new Error(`stored credential asks for an unsupported scrypt cost (${parsed.cost})`);
  }
  if (128 * parsed.cost * parsed.blockSize > MAX_MEMORY_BYTES) {
    throw new Error('stored credential asks for more memory than scrypt is permitted here');
  }
  if (parsed.salt.length === 0 || parsed.hash.length === 0) {
    throw new Error('stored credential has an empty salt or digest');
  }

  return parsed;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`stored credential has a non-numeric scrypt ${name}`);
  }
  return parsed;
}

/**
 * Wrapped by hand rather than with `promisify` so the callback types survive.
 *
 * The callback form matters more than the ergonomics: it runs the derivation on
 * the libuv thread pool, where tens of milliseconds of memory-hard work belong.
 * `scryptSync` would block the event loop for the same duration on every
 * instrument request, which on a busy upload is the whole process stalling.
 */
function derive(
  password: string,
  salt: Buffer,
  cost: number,
  blockSize: number,
  parallelism: number,
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      { N: cost, r: blockSize, p: parallelism, maxmem: MAX_MEMORY_BYTES },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}
