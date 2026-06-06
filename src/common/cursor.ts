import { ValidationError } from './problem-details';

/**
 * Opaque cursor pagination.
 *
 * Offset pagination is the obvious alternative and it is wrong for the
 * collection this service is asked to page most often. The audit stream is
 * append-only and it is read while it is being written: `OFFSET 200` is
 * evaluated against the log as it looks at the instant the query runs, so
 * twenty events appended between page three and page four displace every row
 * behind them. A descending reader is served twenty rows it has already seen; an
 * ascending reader is never served twenty rows at all. Silently skipping entries
 * of a log whose entire purpose is completeness is not a pagination artefact, it
 * is a correctness failure.
 *
 * A cursor names a position in the sort key rather than a count of rows in front
 * of it, so a concurrent insert cannot move it. It is base64url so that clients
 * do not parse it: which fields a collection sorts on is an implementation
 * detail we intend to keep changing, and a client that decoded the cursor would
 * turn that into a breaking change.
 */

/**
 * Unit separator between fields, and the marker for a null field. Neither may
 * appear inside a string field -- `encodeCursor` rejects them -- so decoding is
 * unambiguous and a null is never confused with an empty string. That
 * distinction is load-bearing: a nullable sort key such as `sealed_at` orders
 * nulls as a group of their own, and a cursor that could not tell `null` from
 * `''` would restart the scan at the wrong end of that group.
 */
const FIELD_SEPARATOR = '\u001f';
export const CURSOR_NULL = '\u0000';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type CursorField = string | number | Date | null;

/**
 * Encode a tuple of sort key values.
 *
 * Dates render at millisecond precision, which is all a JavaScript `Date`
 * carries. A cursor over a `timestamptz` column must therefore always pair the
 * timestamp with a unique tie-breaker (an id, or `seq`); two rows sharing a
 * millisecond are indistinguishable to the cursor and one of them would be
 * skipped.
 */
export function encodeCursor(fields: CursorField[]): string {
  if (fields.length === 0) {
    throw new Error('a cursor must carry at least one sort key field');
  }
  const rendered = fields.map(renderField).join(FIELD_SEPARATOR);
  return Buffer.from(rendered, 'utf8').toString('base64url');
}

/**
 * Decode a cursor, rejecting one that does not carry exactly `arity` fields.
 *
 * The arity check is what stops a cursor from one endpoint being pasted into
 * another and paging from a position that means something else there. Failing
 * loudly is the point: the alternative is a query that returns rows, looks
 * healthy, and is wrong.
 *
 * Null fields come back as `CURSOR_NULL` rather than as `null`, so the caller
 * still receives a `string[]` and can feed the tuple straight into a query
 * builder after mapping the marker.
 */
export function decodeCursor(cursor: string, arity: number): string[] {
  if (cursor.length === 0 || !BASE64URL.test(cursor)) {
    throw new ValidationError('cursor is not a valid pagination cursor');
  }

  const decoded = Buffer.from(cursor, 'base64url');
  // base64url decoding is lenient -- it discards characters it does not
  // recognise rather than failing -- so a mangled cursor would decode to
  // something plausible. Re-encoding and comparing is the cheap way to insist
  // on exactly one valid spelling.
  if (decoded.toString('base64url') !== cursor) {
    throw new ValidationError('cursor is not a valid pagination cursor');
  }

  const fields = decoded.toString('utf8').split(FIELD_SEPARATOR);
  if (fields.length !== arity) {
    throw new ValidationError(
      `cursor carries ${fields.length} field(s); this collection paginates on ${arity}. ` +
        'A cursor is only valid for the endpoint that issued it.',
    );
  }
  return fields;
}

export function isCursorNull(field: string): boolean {
  return field === CURSOR_NULL;
}

/**
 * Turn an over-fetched result set into a page.
 *
 * Callers select `limit + 1` rows: the extra row is how we know another page
 * exists without a second `count(*)` over a table that is still growing.
 */
export function buildPage<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => CursorField[],
): Page<T> {
  const items = rows.slice(0, limit);
  if (rows.length <= limit) {
    return { items, nextCursor: null };
  }
  const last = items[items.length - 1];
  return { items, nextCursor: last === undefined ? null : encodeCursor(cursorOf(last)) };
}

function renderField(field: CursorField, index: number): string {
  if (field === null) return CURSOR_NULL;

  if (field instanceof Date) {
    const time = field.getTime();
    if (!Number.isFinite(time)) {
      throw new Error(`cursor field ${index} is an invalid Date`);
    }
    return field.toISOString();
  }

  if (typeof field === 'number') {
    if (!Number.isFinite(field)) {
      throw new Error(`cursor field ${index} is not a finite number`);
    }
    return String(field);
  }

  if (field.includes(FIELD_SEPARATOR) || field.includes(CURSOR_NULL)) {
    throw new Error(`cursor field ${index} contains a reserved control character`);
  }
  return field;
}
