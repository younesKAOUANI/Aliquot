# ADR-0009: JCS (RFC 8785) canonical JSON for all digests

**Status:** Accepted
**Date:** 2026-06-04
**Deciders:** Younes Kaouani

## Context

Four of this service's guarantees are digests taken over JSON:

- `idempotency_key.request_fingerprint` — separates a retry from a key reused with different
  content (`0005_idempotency.sql`, ADR-0001).
- `audit_event.payload_digest` — the one hash input the application supplies to
  `aliquot.append_audit_event()`, so the only part of the chain preimage it controls
  (`0003_audit_chain.sql`, ADR-0015).
- `derivation.parameters_digest` — half of `derivation_identity_unique`, which stops a
  retried worker recording the same work twice (`0006_provenance.sql`).
- `run.manifest_digest` — fixed at registration, recomputed at seal and compared
  (`manifestDigest()` in `src/ingestion/manifest.ts`).

The obvious implementation is `sha256(JSON.stringify(value))`, and why it is wrong is not
obvious, because `JSON.stringify` *is* deterministic: given one object it always emits the
same bytes. The nondeterminism is one level up, in object construction. Property order is
insertion order, so `{a, b}` built by a request handler and `{b, a}` rebuilt from a database
row compare equal under every check anyone would write and serialise differently — and a
client that re-serialises its retry in a different order gets a `409` from
`IdempotencyKeyReusedError` on a legitimate retry.

The failure mode is what makes this an ADR rather than a code comment. Nothing breaks when
the mistake is made — the chain verifies, the tests pass. It breaks later, when a library
upgrade reorders a field or a second code path builds the same payload, and it breaks
*retroactively*: `verifyRow()` in `src/audit/chain-verifier.ts` starts returning
`reason: 'payload_digest'` for events nobody has touched in months. The system reports
tampering, falsely, and nothing in the data separates a false report from a true one. Tamper
evidence that cries wolf is worse than none.

## Decision

Every digest taken over JSON is taken over the RFC 8785 (JSON Canonicalization Scheme) form
of the value, produced by `canonicalize()` in `src/common/canonical-json.ts`, and
`digestCanonical()` in `src/common/digest.ts` is the only sanctioned way to hash a JSON
value. That canonicaliser is implemented here rather than taken from a package.

## Options considered

### Option A: Recursive key-sort, then `JSON.stringify`

| Dimension | Assessment |
|---|---|
| Complexity | Lowest; no specification to read |
| Traps handled | Key ordering, and only key ordering |
| Cross-implementation agreement | None; the digest means "whatever this file did" |

**Pros:** Fixes the failure that prompted the work, in an afternoon.

**Cons:** It handles one trap of six. `JSON.stringify` renders `NaN` and `±Infinity` as
`null`, collapsing three payloads into one digest; `Date` and class instances go through
`toJSON`; `[undefined]` becomes `[null]`; `-0` and `0` are one JSON value that a hand-rolled
path can emit two spellings of; a hand-written escaper replaces lone surrogates with U+FFFD,
silently changing content. Number formatting is left to the engine. And the reflexive sort,
`localeCompare`, is locale-sensitive — the same service under a different `LANG` orders `ö`
next to `o` and digests an untouched manifest differently, where §3.2.3 requires UTF-16
code-unit order, which is plain `<`. Worst, the output is defined by the implementation, so
there is nothing to check it against and nothing that will ever agree with it.

### Option B: Depend on a published JCS implementation

| Dimension | Assessment |
|---|---|
| Complexity | Lowest of the conforming options |
| Dependency surface | One package underneath every integrity claim the service makes |
| Input semantics | Delegates to `JSON.stringify` coercions; not configurable |

**Pros:** Someone else has read the RFC and been corrected in public.

**Cons:** Two objections. The general one is scope: the package would sit under the audit
chain, idempotency and derivation identity at once, and a behaviour change in a patch
release produces not an outage but digests that no longer match history. The specific one is
that stock JCS libraries canonicalise *JSON-able* values and so inherit `JSON.stringify`'s
coercions: `new Date(0)` becomes a string, a `Map` becomes `{}`, a `bigint` narrows or
throws, `[undefined]` and `[null]` agree. Aliquot needs those rejected at the boundary,
because every coercion is a place where two different inputs canonicalise to the same bytes.

### Option C: Implement RFC 8785 in this repository

| Dimension | Assessment |
|---|---|
| Complexity | Moderate; the spec is short and defers the hard parts to ECMAScript |
| Spec conformance | Checkable against published vectors, incl. the Appendix B composite |
| Input semantics | Ours: non-JSON input throws `CanonicalizationError` with the path |

**Pros:** Conformance becomes a property we demonstrate rather than assume —
`test/unit/canonical-json.spec.ts` is the RFC's own vectors, not invented examples.
Rejection semantics are ours to set, so `Date`, `Map`, `Set`, `RegExp`, class instances,
`bigint`, non-finite numbers and `undefined` array elements raise `CanonicalizationError`
naming the path (`a.b[1].c`) instead of becoming plausible bytes.

**Cons:** We own a specification implementation, including the parts we got right by reading
carefully rather than by testing.

## Trade-off analysis

Option A never survived the trap list. It is what gets written when the problem is
understood as "key order" rather than "a JSON value has no defined byte representation", and
the difference between those framings is five further collision sources.

Option B was hard to argue against, and lost on the second objection rather than the first.
The dependency argument is weaker than it sounds — a well-known JCS package is not a serious
supply-chain risk, and pretending otherwise would be posturing. The decisive point is that
RFC 8785 defines a canonical form for JSON *data*, while what we hold is JavaScript values.
The gap is where the coercions live, and a library crosses it silently by design. We need it
to fail loudly: ~90 lines buys an error at the point of the mistake rather than a digest
over a `Date` someone forgot to serialise. Had the input already been known-good JSON, the
dependency would have been the right call.

Where the chosen option is weaker: it does not free us from `JSON.stringify`.
`writeNumber()` and the string branch both delegate to it, because §3.2.2.2 and §3.2.2.3
specify ECMAScript's own serialisation. Our output tracks V8's number formatting and
escaping; implementing it ourselves did not make us independent of the runtime.

Two residual risks. Canonicalisation only guarantees agreement for values that reach it
intact: `verifyRow()` re-derives `payload_digest` from a `jsonb` column read back through
the driver, and `JSON.parse` cannot represent an integer above 2^53 that `jsonb` stored
exactly. No audit payload carries numbers that large — a convention, not a constraint. And
it fixes the serialisation, not the field set, which is why `CanonicalManifestEntry` is
declared separately from `ManifestEntry`.

## Consequences

**Easier:** Two code paths building the same logical value produce the same digest, so a
reordered retry is recognised as a retry and a payload rebuilt from a row verifies against a
hash computed at write time. Derived artifacts become content-addressable by construction:
`ChecksumManifestProcessor` and `MetadataExtractProcessor` write `canonicalize(...)` bytes,
so a re-run after a crash lands on the same key from `storageKeyForDigest()`. And an auditor
can recompute a `payload_digest` with any conforming JCS implementation, in any language.

**Harder:** Callers must hand JSON data across the boundary; a `Date` in a payload is a
thrown error rather than a coerced string, which is friction at every call site and is the
point. Digests are permanent, so changing the canonicaliser or the field set of anything
digested invalidates stored history and needs a versioning story that does not exist yet.
`MANIFEST_VERSION` in the checksum processor is the only place this is anticipated.

**To revisit:** If RFC 8785 is superseded or errata change the emitted form; if a service in
another language computes Aliquot digests and disagrees with ours; or if digest versioning
becomes necessary, in which case the canonical form gets a prefix or the digest a tag — a
new ADR, not an edit to this one.

## Action items

1. [x] Implement `canonicalize()` and `CanonicalizationError` in `src/common/canonical-json.ts`.
2. [x] Pin behaviour to the RFC's own vectors in `test/unit/canonical-json.spec.ts`: §3.2.3
   ordering, number formatting, `-0`, lone surrogates, Appendix B composite.
3. [x] Expose `digestCanonical()` as the only sanctioned way to hash JSON; route all four
   stored digests through it.
4. [x] Reject non-JSON input rather than coercing it, with the path in the message.
5. [x] Store the canonical bytes, not a re-serialisation: `AuditService.append()` passes the
   string it digested as the `jsonb` payload.
6. [x] Add the `no-restricted-syntax` rule in `eslint.config.mjs` failing the build on a
   digest over `JSON.stringify` output, scoped to `sha256Hex`/`createHash` call sites.
7. [ ] Cross-check in CI against an independent JCS implementation, so agreement is verified
   rather than assumed after a dependency bump.
8. [ ] Decide the digest-versioning scheme before any canonicalised field set changes.
