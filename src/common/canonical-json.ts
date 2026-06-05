/**
 * JSON Canonicalization Scheme (RFC 8785).
 *
 * Every digest in this service is taken over JSON: idempotency fingerprints,
 * audit payloads, derivation parameters. `JSON.stringify` is not a defined
 * byte representation of a value -- key order follows insertion order, so two
 * structurally identical objects built by different code paths serialise
 * differently and hash differently.
 *
 * That failure is quiet and it is delayed. A chain built on non-canonical
 * serialisation verifies perfectly until the day a library upgrade, an added
 * field, or a different code path changes an insertion order, at which point
 * history that was never touched starts failing verification. By then the real
 * cause is months behind you.
 *
 * This is written rather than taken from a package because it is ~90 lines, it
 * is load-bearing for every integrity claim the service makes, and its
 * correctness is fully pinned by the RFC's own test vectors (see the spec
 * tests). A dependency here would be a dependency on someone else's reading of
 * the same document.
 *
 * Scope, deliberately narrow: the input must already be JSON data. Dates, Maps,
 * class instances and `toJSON` methods are rejected rather than coerced,
 * because every coercion is a place where two different inputs could
 * canonicalise to the same bytes.
 */

export class CanonicalizationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (at ${path || '<root>'})`);
    this.name = 'CanonicalizationError';
  }
}

/**
 * Serialise a JSON value to its RFC 8785 canonical form.
 *
 * @throws {CanonicalizationError} if the value is not JSON data.
 */
export function canonicalize(value: unknown): string {
  return write(value, '');
}

function write(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      return writeNumber(value, path);

    case 'string':
      // RFC 8785 §3.2.2.2 defers to ECMAScript's JSON.stringify for strings,
      // which is exactly what this is. Lone surrogates are preserved as
      // \uXXXX escapes, which the RFC requires and hand-rolled escaping
      // routinely gets wrong.
      return JSON.stringify(value);

    case 'object':
      return Array.isArray(value)
        ? writeArray(value, path)
        : writeObject(value as Record<string, unknown>, path);

    default:
      // undefined, function, symbol, bigint. A bigint in particular must not
      // be silently narrowed to a double.
      throw new CanonicalizationError(`cannot canonicalize ${typeof value}`, path);
  }
}

function writeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(`${value} is not representable in JSON`, path);
  }
  // RFC 8785 §3.2.2.3 specifies ECMAScript number-to-string, which is what
  // JSON.stringify emits. -0 renders as "0", which is intended: the RFC treats
  // negative zero as zero, so +0 and -0 must not produce different digests.
  return JSON.stringify(value);
}

function writeArray(value: unknown[], path: string): string {
  const parts = value.map((element, index) => {
    if (element === undefined) {
      // JSON.stringify turns a hole or an undefined element into null, which
      // would make [undefined] and [null] indistinguishable after hashing.
      throw new CanonicalizationError('array contains undefined', `${path}[${index}]`);
    }
    return write(element, `${path}[${index}]`);
  });
  return `[${parts.join(',')}]`;
}

function writeObject(value: Record<string, unknown>, path: string): string {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalizationError(
      'only plain objects can be canonicalized; convert dates, maps and class ' +
        'instances to JSON data at the boundary',
      path,
    );
  }

  const parts: string[] = [];
  // RFC 8785 §3.2.3: sort by UTF-16 code unit. JavaScript's default string
  // comparison is exactly that, so no collator and no localeCompare -- both of
  // which would be locale-sensitive and therefore not canonical.
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    // Absent and explicitly-undefined are the same thing in JSON, so dropping
    // the key is correct rather than lossy: {a:1} and {a:1,b:undefined} denote
    // the same JSON document and must hash identically.
    if (entry === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${write(entry, path ? `${path}.${key}` : key)}`);
  }
  return `{${parts.join(',')}}`;
}
