import { describe, expect, it } from 'vitest';

import {
  assertSha256Hex,
  digestCanonical,
  digestOfDigestSet,
  digestsEqual,
  isSha256Hex,
  sha256Hex,
  storageKeyForDigest,
} from '../../src/common/digest';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

describe('sha256Hex', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
  ])('matches the published vector for %j', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it("hashes strings as UTF-8, matching what PostgreSQL convert_to(..., 'UTF8') produces", () => {
    // The audit chain is hashed on the database side and verified here. If the
    // two disagreed on encoding, every event containing a non-ASCII character
    // would report as tampered.
    expect(sha256Hex('€')).toBe(sha256Hex(Buffer.from([0xe2, 0x82, 0xac])));
  });
});

describe('isSha256Hex / assertSha256Hex', () => {
  it.each([
    [A, true],
    ['A'.repeat(64), false], // upper case: the database domain is lower case only
    ['a'.repeat(63), false],
    ['a'.repeat(65), false],
    ['g'.repeat(64), false],
    ['', false],
  ])('classifies %j as %p', (value, expected) => {
    expect(isSha256Hex(value)).toBe(expected);
  });

  it('throws with the offending value named', () => {
    expect(() => assertSha256Hex('nope', 'declared digest')).toThrow(/declared digest.*nope/s);
  });
});

describe('digestCanonical', () => {
  it('is insensitive to key insertion order', () => {
    // The property the idempotency fingerprint depends on: a client that
    // re-serialises the same body on retry must be recognised as retrying.
    expect(digestCanonical({ a: 1, b: 2 })).toBe(digestCanonical({ b: 2, a: 1 }));
  });

  it('distinguishes values that differ only in type', () => {
    expect(digestCanonical({ a: 1 })).not.toBe(digestCanonical({ a: '1' }));
    expect(digestCanonical({ a: null })).not.toBe(digestCanonical({ a: false }));
  });

  it('distinguishes array order', () => {
    expect(digestCanonical([1, 2])).not.toBe(digestCanonical([2, 1]));
  });

  it('produces a valid sha256 hex digest', () => {
    expect(isSha256Hex(digestCanonical({ any: 'thing' }))).toBe(true);
  });
});

describe('digestOfDigestSet', () => {
  it('ignores input order, because the same inputs are the same work', () => {
    // This is what stops an identical processing job from recording a second
    // derivation just because the inputs arrived in a different order.
    expect(digestOfDigestSet([A, B, C])).toBe(digestOfDigestSet([C, A, B]));
  });

  it('collapses duplicates', () => {
    expect(digestOfDigestSet([A, A, B])).toBe(digestOfDigestSet([A, B]));
  });

  it('distinguishes different sets', () => {
    expect(digestOfDigestSet([A, B])).not.toBe(digestOfDigestSet([A, C]));
  });

  it('distinguishes the empty set from a single input', () => {
    expect(digestOfDigestSet([])).not.toBe(digestOfDigestSet([A]));
  });

  it('is not vulnerable to concatenation ambiguity', () => {
    // A naive implementation joining without a separator would hash
    // [aa, bb] and [aabb] identically. The separator is load-bearing.
    const twoShort = digestOfDigestSet(['a'.repeat(64), 'b'.repeat(64)]);
    const oneLong = sha256Hex('a'.repeat(64) + 'b'.repeat(64));
    expect(twoShort).not.toBe(oneLong);
  });
});

describe('digestsEqual', () => {
  it('compares equal values as equal', () => {
    expect(digestsEqual(A, A)).toBe(true);
  });

  it('compares different values as different', () => {
    expect(digestsEqual(A, B)).toBe(false);
  });

  it('handles length mismatch without throwing', () => {
    // timingSafeEqual throws on unequal lengths; the wrapper must not.
    expect(digestsEqual('short', A)).toBe(false);
    expect(digestsEqual('', '')).toBe(true);
  });
});

describe('storageKeyForDigest', () => {
  it('fans out two levels from the digest prefix', () => {
    const digest = 'abcdef' + '0'.repeat(58);
    expect(storageKeyForDigest(digest)).toBe(`sha256/ab/cd/${digest}`);
  });

  it('is a pure function of the digest, so the same content always lands in the same place', () => {
    // Content addressing depends on this: writing identical bytes to a
    // digest-derived key is itself idempotent, which is what makes a crashed
    // worker safe to retry.
    expect(storageKeyForDigest(A)).toBe(storageKeyForDigest(A));
  });

  it('refuses a malformed digest rather than producing a nonsense key', () => {
    expect(() => storageKeyForDigest('not-a-digest')).toThrow();
  });
});
