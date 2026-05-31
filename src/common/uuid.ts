import { randomBytes, randomUUID } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562 §5.7): 48-bit Unix millisecond timestamp, then version and
 * variant bits, then randomness.
 *
 * Time-ordered identifiers matter here for one specific reason: every primary
 * key in this service is a UUID, and a random UUID as a B-tree key writes to a
 * uniformly random leaf page on every insert. At the volumes in the PRD that is
 * irrelevant; at the volumes a busy sequencing core produces it is the
 * difference between an index that stays in cache and one that does not.
 * UUIDv7 inserts at the right-hand edge like a sequence, without needing the
 * database to hand out values.
 *
 *   ┌─ 48 bits ─┬─ 4 ─┬─ 12 bits ─┬─ 2 ─┬──── 62 bits ────┐
 *   │ unix_ms   │ ver │ counter   │ var │ random          │
 *   └───────────┴─────┴───────────┴─────┴─────────────────┘
 *
 * rand_a is used as a monotonic sub-millisecond counter (the "replace" method
 * of RFC 9562 §6.2). Without it, two ids minted in the same millisecond order
 * randomly relative to each other, which quietly breaks any cursor that assumes
 * id order matches creation order -- and this service paginates audit events by
 * exactly that assumption.
 */

const MAX_COUNTER = 0xfff;

let lastTimestamp = -1;
let counter = 0;

export function uuidv7(): string {
  let now = Date.now();

  if (now === lastTimestamp) {
    counter += 1;
    if (counter > MAX_COUNTER) {
      // 4096 ids in one millisecond. Waiting for the clock to advance is
      // correct and effectively unreachable; the alternative -- borrowing from
      // the next millisecond -- makes the embedded timestamp a lie.
      now = waitForNextMillisecond(lastTimestamp);
      lastTimestamp = now;
      counter = 0;
    }
  } else if (now > lastTimestamp) {
    lastTimestamp = now;
    counter = 0;
  } else {
    // The wall clock went backwards (NTP step, VM migration). Holding the last
    // observed timestamp keeps ids monotonic; the counter absorbs the drift.
    // Correctness never depends on the embedded time, only on ordering.
    counter += 1;
    if (counter > MAX_COUNTER) {
      lastTimestamp += 1;
      counter = 0;
    }
    now = lastTimestamp;
  }

  const bytes = randomBytes(16);

  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f);
  bytes[7] = counter & 0xff;

  // Read through a local rather than asserting non-null: randomBytes(16)
  // always has this index, but the compiler cannot know that and an
  // assertion here would be indistinguishable from one that is wrong.
  const variantByte = bytes[8] ?? 0;
  bytes[8] = 0x80 | (variantByte & 0x3f);

  return format(bytes);
}

function waitForNextMillisecond(after: number): number {
  let now = Date.now();
  while (now <= after) now = Date.now();
  return now;
}

function format(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

/** Milliseconds encoded in a v7 identifier. Diagnostics only -- never authoritative. */
export function timestampOf(uuid: string): number {
  return Number.parseInt(uuid.replace(/-/g, '').slice(0, 12), 16);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * v4, for values that must not leak a creation time.
 *
 * Instrument API keys are the case: a v7 key would tell anyone holding it when
 * the credential was issued, which is a small but free piece of reconnaissance.
 */
export function uuidv4(): string {
  return randomUUID();
}
