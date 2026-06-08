# ADR-0015: Audit hash computed in the database, canonicalisation in the application

**Status:** Accepted
**Date:** 2026-06-08
**Deciders:** Younes Kaouani

## Context

ADR-0005 settled that the audit trail is a hash-chained, append-only table in the primary
database. It did not settle where the hash is computed. The first implementation did it in Node:
read `audit_chain_head`, build the preimage in TypeScript, `sha256` it, insert, write the head
back. That works, and it is wrong for a reason that only appears once you write down who the
audited party is.

The audited party is this application. The chain exists so an auditor who does not trust the
service can establish that its record was not edited afterwards. The hash covers five inputs —
`tenant_id`, `seq`, `prev_hash`, `payload_digest`, `occurred_at`. Four are not facts about the
request, they are facts about the write. If the application picks them it is signing its own
attendance sheet: it chooses `occurred_at` freely, and to write the head back it needs `UPDATE` on
`audit_chain_head`, which is the privilege to rewind the chain and re-append over the top of it.

Constraints. Appends run inside the caller's transaction (`AuditService.append()` takes a `Trx`),
because an audit event committing separately from the change it describes is a dual write.
Concurrency correctness comes from the database, not an application mutex. `0001_foundation.sql`
installs no extensions, affordable because `sha256()` has been core since PostgreSQL 13. Canonical
JSON is RFC 8785 (ADR-0009), implemented in `src/common/canonical-json.ts` and pinned by the RFC's
own vectors in `test/unit/canonical-json.spec.ts`.

What breaks if this is got wrong: concurrent appends read the same `prev_hash` and the chain forks
into two branches that each verify; or the tamper-evidence is self-certified; or the verifier
reports untouched history as tampered, which destroys trust as effectively as a missed tamper.

## Decision

The chain hash is computed inside `aliquot.append_audit_event()` over the preimage built by
`aliquot.audit_hash_preimage()`, so `tenant_id`, `seq`, `prev_hash` and `occurred_at` are assigned
by the database and cannot be chosen by the caller. The application supplies exactly one hash
input, `payload_digest`, because RFC 8785 canonicalisation in plpgsql is not an artifact worth
maintaining — and that digest is itself covered by the chain.

The preimage is, byte for byte, `tenant_id | seq | prev_hash | payload_digest | occurred_at`, with
`occurred_at` rendered by `aliquot.audit_timestamp_text()` as `YYYY-MM-DDTHH24:MI:SS.USZ` in UTC,
UTF-8 encoded before hashing.

## Options considered

### Option A: Compute the entire hash in the application

| Dimension | Assessment |
|---|---|
| Complexity | Lowest: no plpgsql beyond the insert |
| Hash inputs the audited process controls | All five |
| Privileges needed on `audit_chain_head` | `SELECT … FOR UPDATE` and `UPDATE` |
| Concurrency safety | Depends on every call site remembering the lock |
| Timestamp fidelity | Node process clock, milliseconds |

**Pros:** One language, one SHA-256 implementation. Unit-testable without a container, and the
preimage sits in the same file as the verifier, so drift between them is visible.

**Cons:** `occurred_at` becomes when the process thought it was, not when the row was written; a
clock that steps backwards yields a chain with decreasing timestamps that still verifies. Holding
`UPDATE` on the chain head is exactly the capability the chain exists to deny. The head lock
becomes a convention rather than an invariant — the next append path added is one missing
`FOR UPDATE` away from forking a chain.

### Option B: Compute everything in the database, including RFC 8785 canonicalisation

| Dimension | Assessment |
|---|---|
| Complexity | High: JCS in plpgsql, plus a second canonicaliser to keep in step |
| Hash inputs the audited process controls | None |
| Correctness against RFC 8785 | Not achievable through `jsonb` |
| Testability | Cannot be driven by the RFC vectors as bytes |

**Pros:** The strongest version of the property being sought. The application supplies no hash
input at all, and the chain would cover the payload directly rather than a digest of it.

**Cons:** It does not actually achieve that, because the payload arrives as `jsonb`. `jsonb`
discards key order, drops duplicate keys and normalises numbers on input, so a plpgsql
canonicaliser canonicalises a value the parser has already rewritten — the bytes hashed are not
the bytes the client sent. Beyond that, JCS requires ECMAScript `Number::toString` formatting and
UTF-16 code-unit ordering of member names; reimplementing those in plpgsql is a permanent
obligation and a second implementation to keep in agreement with the TypeScript one already used
for idempotency fingerprints (ADR-0001) and derivation `inputs_digest`.

### Option C: Database computes the chain hash, application computes the payload digest (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | One plpgsql function plus two `IMMUTABLE` helpers |
| Hash inputs the audited process controls | One of five, re-derivable from the stored row |
| Privileges needed on `audit_chain_head` | None |
| Concurrency safety | Structural: the lock is inside the only path that appends |
| Canonicalisation correctness | One implementation, pinned by RFC vectors |

**Pros:** `aliquot_app` and `aliquot_worker` have no privileges on `audit_chain_head` at all; the
only thing that can move it is `append_audit_event()`, which is `SECURITY DEFINER`. The tenant is
read from the session via `aliquot.current_tenant_id()` rather than taken as an argument, so
`SECURITY DEFINER` does not become a hole through the RLS boundary — an append with no tenant in
session raises `insufficient_privilege`. `occurred_at` is `clock_timestamp()` in the same
statement. The `SELECT … FOR UPDATE` on the head row serialises appends within a tenant while
leaving cross-tenant appends parallel, and cannot be forgotten because there is no other way in.

**Cons:** The preimage is now specified in two languages that must agree, with nothing enforcing
it. The payload digest is supplied by the party being audited.

## Trade-off analysis

Option B was hardest to argue against. It is the only option where the application contributes
nothing to the digest, and "the audited process supplies one of five inputs" is a real concession.
It lost on a fact rather than a preference: `jsonb` normalises on input, so canonicalising inside
the database canonicalises a value that has already lost the properties canonicalisation exists to
fix. The extra strength was illusory and would have been bought with an RFC reimplementation in a
language with no test framework for it.

The remaining concession is bounded by the verifier rather than by argument. `verifyRow()` in
`src/audit/chain-verifier.ts` re-derives `digestCanonical(row.payload)` and compares it to the
stored `payload_digest` before checking any hash, so a digest that does not describe its own
payload is reported with reason `payload_digest`. What that cannot catch is an application that
logged an untrue payload in the first place — no hashing scheme catches that. The claim is that
the record was not altered after it was written, not that it was true when written.

Option A's attraction was the single implementation, and rejecting it created the one genuine
hazard here: the preimage exists twice. That duplication is deliberate. `ChainVerifier` does not
call `aliquot.audit_hash_preimage()`, does not call PostgreSQL's `sha256()`, and does not trust
`audit_chain_head`; it reads the stored columns and rebuilds the string in TypeScript. A verifier
reusing the appender's code can only prove the appender agrees with itself, which excludes exactly
the class of bug — wrong field order, wrong timestamp precision — that would otherwise sit
undiscovered until an auditor asked. The mitigation for drift is that every case in
`test/integration/audit-chain.spec.ts` appends through the database and verifies through
TypeScript.

The microsecond rendering is where this nearly went wrong. `timestamptz` stores microseconds; a
JavaScript `Date` carries milliseconds. A verifier that parsed and reformatted the timestamp would
drop three digits and report every event in every chain as tampered — a total false positive,
indistinguishable from a catastrophic finding. The read path therefore selects
`aliquot.audit_timestamp_text(e.occurred_at)` as text and treats the string as opaque. The format
is the contract; the computation is not. `AuditService.list()` does the same, so a client
verifying offline receives the exact bytes that were hashed.

Residual risk, restated from ADR-0005: an actor with full database privileges can rewrite an event
and recompute every following hash, and the result verifies. The suite asserts that failure
explicitly ("does NOT detect a rewrite that also recomputes every following hash") alongside the
paired case where the same rewrite is caught once verification is anchored to a prior
`audit_checkpoint`. Computing the hash in the database raises the cost of tampering; only an
external anchor changes what is possible.

## Consequences

**Easier:** Appends are safe by construction — one entry point, which takes the lock, reads the
tenant from the session and stamps the time. Chain forks under concurrency are structurally
excluded, asserted by the parallel-append test that checks the result is contiguous and correctly
linked. The application needs no privileges on the chain head.

**Harder:** The preimage is defined in `migrations/0003_audit_chain.sql` and again in
`chain-verifier.ts`; changing it means changing both, and no migration can retroactively rehash
existing events, so a preimage change is a chain break by definition. Debugging a mismatch spans
two languages. `append_audit_event()` is `SECURITY DEFINER` and permanently on the list of objects
that get read carefully in review. There is no offline append path for tests.

**To revisit:** If append latency under the head lock becomes a bottleneck — the lock serialises
all appends within a tenant, so a tenant driving sustained high-frequency ingestion is the case to
watch — reopen this, because the alternatives (per-stream chains, batched appends) change the
shape of the guarantee, not just its performance. Also reopen if a second writer implementation in
another language appears, at which point the preimage needs a specification and a shared
conformance vector rather than two hand-kept copies.

## Action items

1. - [x] Compute the hash inside `aliquot.append_audit_event()`; return `seq`, `hash` and
   `occurred_at` rather than accepting them.
2. - [x] Factor the preimage into `IMMUTABLE` `aliquot.audit_hash_preimage()` and
   `aliquot.audit_timestamp_text()`, documented in the column comment on `audit_event.hash`.
3. - [x] Lock `audit_chain_head` with `FOR UPDATE` inside the append function; grant the
   application no privileges on that table.
4. - [x] Read the tenant from `aliquot.current_tenant_id()`, never an argument; raise
   `insufficient_privilege` when absent.
5. - [x] Keep RFC 8785 canonicalisation in `src/common/canonical-json.ts`, and store the same
   bytes that were digested by inserting `canonicalize(payload)`.
6. - [x] Select `aliquot.audit_timestamp_text(occurred_at)` as text on every read path
   (`ChainVerifier.fetchBatch()`, `AuditService.list()`) and expose it as `occurredAt`.
7. - [x] Rebuild the preimage independently in `ChainVerifier`, sharing no code with the appender.
8. - [x] Cover concurrency with parallel appends asserting a contiguous chain, and reordering by
   asserting a swapped pair is caught because `seq` is in the preimage.
9. - [ ] Add a fixed golden vector asserted from both plpgsql and TypeScript, so a preimage change
   fails a test that names it rather than a chain test reporting tampering.
10. - [ ] Publish the preimage and timestamp format in the public API documentation so a client can
    verify without reading the migration.
11. - [ ] Mirror checkpoints externally and populate `audit_checkpoint.external_ref`; until then
    the anchoring story is local only.
