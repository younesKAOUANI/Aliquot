import { describe, expect, it } from 'vitest';

import { isUuid, timestampOf, uuidv4, uuidv7 } from '../../src/common/uuid';

describe('uuidv7', () => {
  it('sets the version and variant bits required by RFC 9562', () => {
    const id = uuidv7();
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]);
    expect(isUuid(id)).toBe(true);
  });

  it('encodes the current time in the leading 48 bits', () => {
    const before = Date.now();
    const encoded = timestampOf(uuidv7());
    const after = Date.now();

    expect(encoded).toBeGreaterThanOrEqual(before);
    expect(encoded).toBeLessThanOrEqual(after);
  });

  it('is unique across a large batch', () => {
    const ids = Array.from({ length: 50_000 }, () => uuidv7());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is lexicographically monotonic, including within a single millisecond', () => {
    // This is the property that matters, and the one a naive v7 gets wrong.
    // Cursor pagination over the audit stream orders by id; if two ids minted
    // in the same millisecond can order randomly against each other, a page
    // boundary landing between them silently drops or repeats a row.
    const ids = Array.from({ length: 20_000 }, () => uuidv7());
    const sorted = [...ids].sort();

    expect(ids).toEqual(sorted);
  });

  it('stays monotonic across a millisecond boundary', () => {
    const first = uuidv7();
    const start = Date.now();
    while (Date.now() === start) {
      /* spin to guarantee the clock advances */
    }
    const second = uuidv7();

    expect(second > first).toBe(true);
  });

  it('sorts in the same order as a byte-wise comparison of the raw uuid', () => {
    // Postgres compares uuid values as 16 bytes, not as text. If the two
    // orderings disagreed, an index scan would return a different order than
    // the cursor assumed.
    const ids = Array.from({ length: 500 }, () => uuidv7());
    const asBytes = [...ids].sort((a, b) =>
      Buffer.from(a.replace(/-/g, ''), 'hex').compare(Buffer.from(b.replace(/-/g, ''), 'hex')),
    );

    expect(ids).toEqual(asBytes);
  });
});

describe('uuidv4', () => {
  it('sets version 4', () => {
    const id = uuidv4();
    expect(id[14]).toBe('4');
    expect(isUuid(id)).toBe(true);
  });

  it('does not encode a usable timestamp', () => {
    // Instrument API keys use v4 precisely so a credential does not disclose
    // when it was issued. If these ever became time-ordered that property is
    // quietly gone.
    const ids = Array.from({ length: 200 }, () => uuidv4());
    expect(ids).not.toEqual([...ids].sort());
  });
});

describe('isUuid', () => {
  it.each([
    ['0189d6f2-8f6b-7000-8000-000000000000', true],
    ['0189D6F2-8F6B-7000-8000-000000000000', true],
    ['0189d6f2-8f6b-7000-0000-000000000000', false], // invalid variant nibble
    ['0189d6f28f6b70008000000000000000', false], // unhyphenated
    ['not-a-uuid', false],
    ['', false],
  ])('classifies %j as %p', (value, expected) => {
    expect(isUuid(value)).toBe(expected);
  });
});
