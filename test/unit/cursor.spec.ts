import { describe, expect, it } from 'vitest';

import {
  CURSOR_NULL,
  buildPage,
  decodeCursor,
  encodeCursor,
  isCursorNull,
} from '../../src/common/cursor';
import { ValidationError } from '../../src/common/problem-details';

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a tuple of strings', () => {
    expect(decodeCursor(encodeCursor(['a', 'b']), 2)).toEqual(['a', 'b']);
  });

  it('round-trips numbers as their decimal form', () => {
    expect(decodeCursor(encodeCursor([42, -1]), 2)).toEqual(['42', '-1']);
  });

  it('round-trips dates at millisecond precision', () => {
    const when = new Date('2026-06-14T09:31:22.481Z');
    expect(decodeCursor(encodeCursor([when]), 1)).toEqual(['2026-06-14T09:31:22.481Z']);
  });

  it('distinguishes null from the empty string', () => {
    // A nullable sort key such as sealed_at orders nulls as their own group. A
    // cursor that conflated the two would resume at the wrong end of it.
    const withNull = decodeCursor(encodeCursor([null, 'x']), 2);
    const withEmpty = decodeCursor(encodeCursor(['', 'x']), 2);

    expect(withNull).not.toEqual(withEmpty);
    expect(isCursorNull(withNull[0] ?? '')).toBe(true);
    expect(isCursorNull(withEmpty[0] ?? '')).toBe(false);
  });

  it('is opaque: the encoded form is not the plain sort key', () => {
    // Clients must not parse cursors. Which fields a collection sorts on is an
    // implementation detail we intend to keep changing.
    expect(encodeCursor(['run-42'])).not.toContain('run-42');
  });

  it('survives unicode in a sort key', () => {
    expect(decodeCursor(encodeCursor(['ch0/stück-€.tif']), 1)).toEqual(['ch0/stück-€.tif']);
  });

  it('rejects a cursor whose arity does not match the collection', () => {
    // The check that stops a cursor from one endpoint paging another from a
    // position that means something else there.
    const twoField = encodeCursor(['a', 'b']);
    expect(() => decodeCursor(twoField, 3)).toThrow(ValidationError);
    expect(() => decodeCursor(twoField, 1)).toThrow(ValidationError);
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'not a cursor!!'],
    ['standard base64 padding', 'YQ=='],
    ['plus and slash from standard base64', 'a+b/c'],
  ])('rejects a malformed cursor (%s)', (_label, cursor) => {
    expect(() => decodeCursor(cursor, 1)).toThrow(ValidationError);
  });

  it('rejects a mangled cursor rather than decoding it leniently', () => {
    // Buffer.from(x, 'base64url') discards characters it does not recognise
    // instead of failing, so without the re-encode check a truncated cursor
    // decodes to something plausible and pages from the wrong place.
    const valid = encodeCursor(['abcdefgh']);
    const truncated = valid.slice(0, -1);
    if (truncated !== Buffer.from(truncated, 'base64url').toString('base64url')) {
      expect(() => decodeCursor(truncated, 1)).toThrow(ValidationError);
    }
  });

  it('refuses to encode an empty tuple', () => {
    expect(() => encodeCursor([])).toThrow();
  });

  it('refuses a string field containing a reserved separator', () => {
    expect(() => encodeCursor([`a${CURSOR_NULL}b`])).toThrow();
    expect(() => encodeCursor(['ab'])).toThrow();
  });

  it('refuses a non-finite number or an invalid date', () => {
    expect(() => encodeCursor([Number.NaN])).toThrow();
    expect(() => encodeCursor([new Date('nonsense')])).toThrow();
  });
});

describe('buildPage', () => {
  const cursorOf = (row: { id: string }) => [row.id];

  it('returns no cursor when the result set fits in one page', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    expect(buildPage(rows, 5, cursorOf)).toEqual({ items: rows, nextCursor: null });
  });

  it('returns no cursor when the result set exactly fills the page', () => {
    // The boundary case. Over-fetching limit+1 is what distinguishes "exactly
    // full" from "there is more", without a count(*) over a growing table.
    const rows = [{ id: 'a' }, { id: 'b' }];
    expect(buildPage(rows, 2, cursorOf).nextCursor).toBeNull();
  });

  it('trims the over-fetched row and emits a cursor from the last kept row', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const page = buildPage(rows, 2, cursorOf);

    expect(page.items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor ?? '', 1)).toEqual(['b']);
  });

  it('handles an empty result set', () => {
    expect(buildPage([], 10, cursorOf)).toEqual({ items: [], nextCursor: null });
  });
});
