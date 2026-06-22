# ADR-0001: Idempotency key with request fingerprint, not natural-key upsert

**Status:** Accepted
**Date:** 2026-06-22
**Deciders:** Younes Kaouani

## Context

The clients are instrument agents on lab networks, written in whatever the vendor shipped,
often years ago. They retry on any timeout — including the one that occurs after the server
has already committed — and we cannot change them.

Registering a run writes a `run` row, one `run_artifact` row per manifest entry, and an audit
event in one transaction. Run it twice and two runs assert the same acquisition. Runs are
immutable and correction is by superseding record (ADR-0010), so a duplicate cannot be
deleted, only abandoned or superseded; it stays in the provenance graph and the audit chain
permanently.

Exactly-once ingestion is G1, the first of the five guarantees. Constraints: one PostgreSQL
instance and no other coordination primitive (CLAUDE.md — concurrency correctness comes from
the database, not an application mutex); three mutating endpoints, one of which
(`POST /v1/runs/{runId}/seal`) carries no body; and duplicates that arrive concurrently,
because a retry timer does not wait for the first request to finish.

## Decision

Every mutating endpoint that is not naturally idempotent requires an `Idempotency-Key`
header, and the service records `(tenant_id, key, endpoint)` in `aliquot.idempotency_key`
together with `request_fingerprint` — SHA-256 over the JCS-canonical form of the parsed
request body. The unique constraint `idempotency_key_unique`, not application code,
arbitrates concurrency; a key replayed with a different fingerprint is a `409`, never a
silent replay.

## Options considered

### Option A: Natural-key upsert on the run

| Dimension | Assessment |
|---|---|
| Complexity | Low — one `ON CONFLICT` clause |
| Retry vs. correction | Cannot distinguish them |
| Requires a natural key | Yes, and none exists |

**Pros:** No extra table, no state, nothing to expire or sweep, and unmodifiable clients need
no changes.

**Cons:** There is no natural key for an acquisition. `aliquot.run` has no unique constraint
beyond its primary key, and the only candidate — `(tenant_id, instrument_id, acquired_at)` —
rests on a column `0004_runs.sql` documents as untrustworthy: client-declared, nullable,
frequently wrong by years, never used for ordering. Even given a key, upsert conflates a
retry with a correction: resubmitting a manifest with a fixed digest must produce a
superseding run, and an upsert overwrites the original instead. It also covers creation only.

### Option B: Idempotency key alone, no fingerprint

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Duplicate suppression | Correct for well-behaved clients |
| Failure mode on misuse | Silent, and looks like success |

**Pros:** The cheapest thing that satisfies the literal requirement, and what most
implementations of this pattern do.

**Cons:** Key generation is delegated to clients we do not control, and clients derive keys
from counters, plate barcodes, and filenames. On reuse with different content the caller gets
the response to a request it never made: a `201` naming somebody else's run. The second
acquisition is never registered, nothing reports an error, and nobody looks until the data is
missing weeks later.

### Option C: Idempotency key plus request fingerprint

| Dimension | Assessment |
|---|---|
| Complexity | Moderate — a table, a state, an expiry policy, a sweep |
| Duplicate suppression | Sequential and concurrent |
| Misuse detection | Explicit `409` with a stable problem type |

**Pros:** Separates replay (same key, same request) from misuse (same key, different request
→ `409` `https://aliquot.dev/problems/idempotency-key-reused`). `digestCanonical()` means a
client that re-serialises the same object with different key ordering is still recognised as
retrying.

**Cons:** A real lifecycle: an `IN_FLIGHT` state, a response body retained for 24 hours, a
sweep, and races that must be got right rather than argued away.

## Trade-off analysis

Option B was hardest to argue against: it suppresses every duplicate a correctly implemented
client can produce, and its failure requires a client bug. It lost on observability, not
correctness — its failure is invisible where it happens, and Option C's is loud at the
boundary. A fourth shape, a client-chosen id with `PUT /v1/runs/{id}`, is Option B with the
key in the URL and overwrites just as silently.

The cost of Option C sits in four details.

**The `IN_FLIGHT` row commits in its own transaction, before the work runs.** An uncommitted
row is invisible to a concurrent transaction, so a key inserted inside the work transaction
lets two duplicates each see nothing, each proceed, and each create a run — the exact bug,
with an idempotency table beside it looking correct. `claim()` commits and returns before
`execute()` calls `work`. Its `ON CONFLICT DO NOTHING` on `idempotency_key_unique` blocks on
a concurrent uncommitted insert of the same key rather than failing past it: when it returns,
the other caller has either committed (we read their row) or rolled back (ours went in). No
check-then-act, so no window between check and act.

**The concurrent duplicate gets `409` with `Retry-After`, not a half-built resource.** The
second caller reads an `IN_FLIGHT` row and raises `IdempotentRequestInFlightError`, rendered
by `problem-details.filter.ts` as `409` with `retry-after: 2`. A `202` would name a run that
may never exist, since the first request can still roll back and delete its key; returning
the partial run is impossible, it being uncommitted and invisible; blocking server-side turns
a client retry budget into a held connection, the scarcest resource in the process. `409`
hands the wait back to a caller that already has a retry loop.

**Expiry is a real delete, and a replay after it is a first-time request.**
`IDEMPOTENCY_RETENTION_HOURS` defaults to 24: long enough for an overnight outage, short
enough that the table does not become a second copy of the API's response history with none
of the primary record's guarantees. `claim()` tests expiry *before* the fingerprint, so a key
reused a day later is not rejected as a mismatch against a response that no longer exists,
and `takeOverIfExpired()` reclaims the row under an `expires_at <= clock_timestamp()`
predicate evaluated under a row lock, so two callers cannot both conclude it was theirs to
take. Honest consequence: a client whose first retry falls outside 24 hours creates a genuine
duplicate.

**A failed request deletes its key rather than poisoning it.** `release()` deletes
`where state = 'IN_FLIGHT'`. A `FAILED` state was rejected: it would have to answer "may the
client retry this key?", the answer is always yes because no resource was created, and a
state whose only correct handling is "treat as absent" is more usefully absent. Retaining the
key blocks it for the full window and rejects the legitimate retry as a mismatch against a
response that never existed.

Where this is weakest: `release()` runs in a transaction separate from the rolled-back work,
so a crash between the two leaves an orphaned `IN_FLIGHT` row blocking that key until
`expires_at` — up to 24 hours of `409` for an honest client. A short in-flight lease is the
fix and is not built. Second, the fingerprint covers the *parsed* body, so requests differing
only in a field the Zod schema discards are the same request by definition.

## Consequences

**Easier:** Retry becomes the client's default rather than a hazard, and the concurrency
argument is one unique constraint readable in the migration. A new mutating endpoint is one
`idempotency.execute()` wrapper — `register`, `supersede`, and `seal` in `run.service.ts`
share it; `abandon` does not, being naturally idempotent.

**Harder:** Every keyed endpoint pays an extra committed transaction before its work. Scope
must be the concrete path (`POST /v1/runs/<id>/seal`, not the route template): a seal
fingerprints as `{}`, so under a templated scope one key used on two runs would fingerprint
identically and the second run would take the first's response and never be sealed — a
footgun guarded only by the doc comment on `execute()`. Stored bodies are asserted rather
than parsed on the way out of `jsonb`, sound over HTTP and not in-process, so nothing
downstream of `execute()` may read the body.

**To revisit:** if a second writer process can register runs on a client's behalf, since the
key would then be derived rather than supplied; if agents are seen retrying beyond 24 hours,
which makes retention a duplicate-generating parameter; or if `failed to release an in-flight
idempotency key` appears above noise, which promotes the in-flight lease to a fix.

## Action items

1. - [x] `aliquot.idempotency_key` in `migrations/0005_idempotency.sql`, with
   `idempotency_key_unique`, `idempotency_completed_has_response`, and RLS
2. - [x] `IdempotencyService.execute()` — claim, run, `complete()` inside the work
   transaction so run and key commit together
3. - [x] `claim()` commits the `IN_FLIGHT` row first, bounded by `CLAIM_ATTEMPTS`
4. - [x] `IdempotencyKeyReusedError` and `IdempotentRequestInFlightError` as RFC 9457 problem
   types; `retry-after` set in `problem-details.filter.ts`
5. - [x] `release()` deletes the key on failure, guarded by `state = 'IN_FLIGHT'`
6. - [x] `takeOverIfExpired()`; expiry checked before fingerprint
7. - [x] Key required on register, seal, and supersede; a repeated header treated as absent
8. - [x] `sweepExpired()` implemented
9. - [ ] Schedule `sweepExpired()`; nothing calls it today
10. - [ ] `test/integration/idempotency.spec.ts` — sequential replay, N concurrent identical
    requests producing one run and N identical responses, fingerprint mismatch, replay after
    expiry, failure not poisoning the key. Named in `README.md`; not in the repository
11. - [ ] In-flight lease shorter than the retention window
12. - [ ] Emit the idempotency hit rate as a metric; a rise is the earliest signal that
    agents are timing out and ingest is degrading
