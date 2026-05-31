# ADR-0011: UUIDv7 for primary keys

**Status:** Accepted
**Date:** 2026-05-31
**Deciders:** Younes Kaouani

## Context

Every entity table across migrations 0002–0007 — `study`, `instrument`, `app_user`,
`artifact`, `run`, `run_artifact`, `upload_session`, `idempotency_key`,
`derivation`, `job` — declares `id uuid primary key` with no default. The absent
default is deliberate: the value is chosen by the application before the `INSERT`
runs. Three constraints forced the shape of that value.

**Identifiers escape.** A run id appears in a URL, a W3C PROV export (ADR-0008), a
support ticket, and an external citation expected to resolve years later. Aliquot is
shared-schema multi-tenant (ADR-0002), so an identifier two customers can compare is
a channel between them that RLS does not close.

**Ids are needed before the row exists.** `RunService.register` mints `runId` at
`src/ingestion/run.service.ts:683`, then writes the run, its `run_artifact` rows, the
enqueued job and the audit event in one transaction — the id is an input to all four,
not an output of one. The idempotency record stores it as
`idempotency_key.resource_id`, which is what a replayed request is answered from.

**Ordering is load-bearing.** Listings page on the id: `id desc` with
`where id < :cursor` for studies and memberships
(`src/identity/identity.service.ts:372`, `:409`, `:448`) and derivations
(`src/provenance/derivation.service.ts:213`), and `(acquired_at desc, id desc)` in
`searchCursorPredicate` for run search. `acquired_at` is read back through a `Date`
at millisecond precision, so the id is the tie-breaker that makes the keyset unique.
If two ids minted in the same millisecond order arbitrarily against each other, a
page boundary landing between them drops or repeats a row and the client cannot
detect it.

## Decision

Every application-minted primary key is a UUIDv7 produced by `uuidv7()` in
`src/common/uuid.ts`, with the 12-bit `rand_a` field used as a monotonic
sub-millisecond counter (RFC 9562 §6.2, replace method) so ids are strictly
increasing within a process. `uuidv4()` is reserved for identifiers that must not
disclose when they were created.

## Options considered

### Option A: `bigserial` / identity column

| Dimension | Assessment |
|---|---|
| Complexity | Lowest. Nothing to write or test. |
| Index locality | Perfect. 8 bytes, appends to the rightmost leaf. |
| Information disclosure | Bad. `run/8412` discloses volume, and sampled twice, rate. |
| Merge and restore | Bad. Two deployments collide on every table. |
| Id known before insert | No. Needs `RETURNING` or `nextval()` first. |

**Pros:** the cheapest key Postgres offers, half the width of a UUID in every index
and foreign key.

**Cons:** the id is a counter, and a counter is a disclosure — volume is competitive
information in a sequencing core. It also makes any future merge (per-site
deployments consolidating, a study restored into staging) a renumbering exercise,
and renumbering breaks the external references ADR-0010 exists to preserve.

### Option B: UUIDv4

| Dimension | Assessment |
|---|---|
| Complexity | Lowest. `randomUUID()` from `node:crypto`. |
| Index locality | Bad. Every insert lands on a random leaf page. |
| Information disclosure | Best. Discloses nothing. |
| Merge and restore | Fine. |
| Id known before insert | Yes. |

**Pros:** discloses strictly nothing — not volume, not rate, not creation time. No
custom generator to own and no failure mode involving the system clock.

**Cons:** a random 128-bit key writes to a random B-tree position on every insert, so
the dirty page working set becomes the whole index rather than its right-hand edge —
and the tail of `artifact` and `run_artifact` is where this service does its bulk
writing. It also gives up ordering, forcing a `created_at` into every sort key and
cursor.

### Option C: UUIDv7

| Dimension | Assessment |
|---|---|
| Complexity | A ~60-line generator and its unit tests, owned permanently. |
| Index locality | Close to a sequence. Inserts cluster at the right-hand edge. |
| Information disclosure | Leaks a millisecond-resolution creation time, nothing else. |
| Merge and restore | Fine. |
| Id known before insert | Yes. |

**Pros:** insert locality of a sequence with the collision properties of a random
UUID, no coordination with the database, and a sort order matching creation order —
which is what lets a cursor be one column wide.

**Cons:** we own a generator. RFC 9562 leaves sub-millisecond ordering optional, so a
naive implementation is ordered only to the millisecond and quietly violates the
property the cursors depend on. And a v7 id tells its holder when the row was
created.

## Trade-off analysis

`bigserial` was hardest to argue against: smaller, faster, free. The disclosure
argument alone is answerable — hash the id in the URL, or add a public id column —
but each answer reintroduces a second identifier and the question of which is
canonical. What settled it was the generation site: a database-assigned key does not
exist until a statement has run, and this write path assembles a graph of rows plus
an audit event around an id it already holds.

UUIDv4's advantage is real and permanent: a v7 run id discloses its registration time
to anyone holding it. Accepted, because the run resource already returns
`registered_at`, so the id leaks nothing the API does not. Not accepted for
credentials — hence `uuidv4()` for session `jti` (`src/identity/tokens.ts:91`),
worker identity (`src/processing/worker.runtime.ts:51`) and correlation ids
(`src/http/correlation.ts`), and 192 bits of `randomBytes` rather than any UUID for
instrument API keys in `generateApiKey()` (`src/identity/credentials.ts`).

Where the chosen option is weaker than it looks: **the counter is per-process.**
`lastTimestamp` and `counter` are module-level state in `src/common/uuid.ts`, so two
API processes minting in the same millisecond order arbitrarily against each other.
Pagination stays exact — the predicate is a strict `<` on a unique column, so no row
is dropped or duplicated — but listing order is only approximately creation order
across processes. The unit tests prove what the cursors need, not global chronology.
The generator also lies about time under clock regression: when `Date.now()` goes
backwards it holds `lastTimestamp` and absorbs the drift in the counter, so
`timestampOf()` is diagnostics only and authoritative time stays
`clock_timestamp()`.

One table sits outside this decision. `aliquot.audit_event` is keyed on
`(tenant_id, seq)`, and its `id` is filled by `gen_random_uuid()` inside
`aliquot.append_audit_event()` (`0003_audit_chain.sql:204`). Audit ordering must be
chosen by the database, not the caller (ADR-0015), so an application-ordered id is
the wrong primitive there; `AuditService.list` pages on `seq` accordingly.

## Consequences

**Easier:** a one-column cursor over any entity table, the id doing the work a
`created_at` would otherwise do. Building a whole object graph in one transaction
with no dependency on statement order. Index writes stay near the right-hand edge.

**Harder:** 16-byte keys in every index and foreign key; rows in `run_artifact`,
`derivation_input` and `derivation_output` carry several. A generator to maintain
whose correctness condition is not obvious from reading it. A permanent rule that no
migration may add `default gen_random_uuid()` to an entity table, since that would
substitute v4 for v7 with no test failing.

**To revisit:**

- If cross-process ordering within a millisecond becomes visible in listings, move
  the counter to a shared source or add a timestamp to the sort key.
- If one process ever needs more than 4096 ids in a millisecond,
  `waitForNextMillisecond()` becomes a spin loop that blocks the event loop.
- If PostgreSQL 18 becomes the deployment floor, its built-in `uuidv7()` answers the
  no-extensions objection in `0001_foundation.sql` — but only for rows that do not need the
  id before the insert, which today is none.
- If an id ever has to be unguessable (a capability URL, a share link), UUIDv7 is not
  that; a separate random token is required.

## Action items

- [x] `uuidv7()` with a monotonic `rand_a` counter and clock-regression handling — `src/common/uuid.ts`.
- [x] Every entity table declares `id uuid primary key` with no default — migrations 0002, 0004, 0005, 0006, 0007.
- [x] Unit tests in `test/unit/uuid.spec.ts` for what the cursors rely on: monotonic within one millisecond over 20,000 ids, monotonic across a millisecond boundary, lexicographic order equal to 16-byte order (Postgres compares `uuid` as bytes, not text), uniqueness over 50,000.
- [x] Cursor pagination on the id for studies, memberships, derivations; `(acquired_at, id)` for run search.
- [x] Cursor decoding rejects a non-UUID tie-breaker — `src/ingestion/run.service.ts:1044`, `src/provenance/derivation.service.ts:400`.
- [x] `uuidv4()` for values that must not carry a creation time: session `jti`, worker id, correlation id.
- [ ] Reconcile the `uuidv4()` doc comment, which names instrument API keys as its motivating case, with `generateApiKey()`, which draws 192 bits from `randomBytes` instead.
- [ ] Extend `scripts/lint-migrations.ts` to reject `default gen_random_uuid()` on an entity table; it checks RLS coverage today and nothing about key generation.
- [ ] Record the per-process limit of the ordering guarantee beside the `id` row of the run table in `docs/ARCHITECTURE.md`. No test asserts it.
