# Aliquot — Architecture

**Instrument Run Ingestion & Provenance Service**

Companion to [PRD.md](PRD.md). This document covers the technical design:
components, data model, flows, failure modes, and the reasoning behind the
choices. Decisions with real alternatives are recorded separately in
[adr/](adr/).

---

## 1. Constraints and context

| Constraint | Implication |
|---|---|
| Single developer | Every moving part must justify itself. Prefer one database doing three jobs over three specialized systems. |
| Existing stack: NestJS / TypeScript / PostgreSQL | Not the moment to learn a new language. Depth in a known stack reads better than breadth in an unknown one. |
| Must be runnable by a reviewer in one command | `docker compose up` and nothing else. A demo that requires setup is a demo nobody sees. |
| Objects are large (GB–TB), metadata is small | Bytes never transit the API process. The service is a control plane over object storage. |

**Load assumptions.** Modest by design and stated explicitly: tens of runs per
day, thousands of artifacts per run, individual artifacts up to hundreds of GB.
Metadata operations are low-volume; the byte path is high-volume and must not go
through Node.

Every "this is fine at our scale" claim in this document is anchored to those
numbers. Section 12 says where each one stops being true.

---

## 2. Design principles

Four ideas drive most of the design. Each maps to established practice in
research data management, which is the point — this is a domain with existing
vocabulary, and using it correctly is a signal.

**Immutability with a clear boundary.** Records are mutable until sealed and
immutable afterwards. Correction happens by superseding, never by overwriting.
This is the core of a defensible record.

**Integrity is demonstrable, not asserted.** Every claim about data being
unaltered must be mechanically checkable. Hence content-addressed storage and a
hash-chained audit log.

**Provenance is structural, not documentary.** Lineage lives in the schema as
first-class relationships, not in a free-text notes field. Modelled onto **W3C
PROV** — `Artifact` → `prov:Entity`, `Run` and `Derivation` → `prov:Activity`,
`Operator` and `Instrument` → `prov:Agent` — so it can be exported to a standard
interchange format rather than trapped in a bespoke shape.

**ALCOA+ as a design checklist.** Attributable, Legible, Contemporaneous,
Original, Accurate, plus Complete, Consistent, Enduring, Available. Concretely:
every event carries an actor *and a label captured at the time*, so the trail
stays legible after that user is renamed (attributable, legible); timestamps are
server-side at the moment of the event (contemporaneous); the first-captured
artifact is retained alongside derivatives (original); nothing is deleted
(enduring).

**FAIR** — Findable, Accessible, Interoperable, Reusable — is the framing for
the query surface: stable identifiers, searchable metadata, standard schemas,
provenance travelling with the data.

---

## 3. Component view

```
                       ┌──────────────────────────────┐
   Instrument agent ──▶│                              │
   (machine client)    │      Aliquot API (NestJS)    │
                       │                              │
   Scientist / UI ────▶│  ┌────────────────────────┐  │
                       │  │ Ingestion   Provenance │  │
   Data steward ──────▶│  │ Identity    Audit      │  │
                       │  └────────────────────────┘  │
                       └───────┬──────────────┬───────┘
                               │              │
              control plane    │              │  presigned URLs only
              (metadata, small)│              │  (bytes never transit here)
                               ▼              ▼
                    ┌──────────────────┐  ┌──────────────────────┐
                    │   PostgreSQL     │  │  Object store (S3 /  │
                    │                  │  │  MinIO)              │
                    │ • domain tables  │  │                      │
                    │ • RLS policies   │  │ • content-addressed  │
                    │ • audit chain    │  │   by SHA-256         │
                    │ • job queue      │  │ • immutable objects  │
                    └────────┬─────────┘  └──────────┬───────────┘
                             │                       │
                             │ transactional         │ reads
                             │ enqueue               │
                             ▼                       │
                    ┌──────────────────┐             │
                    │  Worker tier     │─────────────┘
                    │                  │
                    │ • idempotent     │
                    │ • records        │
                    │   derivations    │
                    └──────────────────┘
```

**Why one database does three jobs.** Domain state, audit chain, and job queue
all live in PostgreSQL. This is a deliberate simplification with a real payoff:
enqueueing work happens *in the same transaction* as the state change that
triggered it, which removes the dual-write problem entirely — no outbox relay,
no CDC pipeline, no window where the state committed but the event was lost. The
cost is that queue throughput is bounded by the database. At this load profile
that ceiling is nowhere near. ([ADR-0004](adr/0004-job-queue-in-postgresql-rather-than-a-dedicated-broker.md))

**Process topology.** Two processes from one image: `SERVICE_ROLE=api` serves
HTTP, `SERVICE_ROLE=worker` runs the poll loop. They share the schema and the
data-access layer but connect with different database roles, and the difference
between those roles is meaningful (§8).

---

## 4. Data model

### Core entities

```
tenant ──< study ──< run ──< run_artifact >── artifact
   │         │        │                          │
   │         │        └──< audit_event           │
   │         │                                   │
   │         └──< membership >── app_user        │
   │                                             │
   └──< instrument ──────────────────────────────┘
                                                 │
                     derivation ──< derivation_input
                          │                      │
                          └──< derivation_output ┘
```

### Key tables

**`run`** — one acquisition event.

| Column | Notes |
|---|---|
| `id` | UUIDv7 — time-ordered, index-friendly, no coordination needed |
| `tenant_id`, `study_id` | Isolation and grouping |
| `instrument_id` | The producing device |
| `operator_id` | Attributable — the human accountable |
| `state` | Enum, see §5 |
| `acquired_at` | Client-declared acquisition time — descriptive, never used for ordering |
| `registered_at` | Server time, authoritative |
| `sealed_at` | Null until sealed |
| `supersedes_run_id` | Non-null when this run corrects an earlier one |
| `manifest_digest` | Digest of the declared manifest, fixed at registration and re-checked at seal |
| `protocol` | JSONB. Producer metadata, deliberately unmodelled — see PRD §8 |

There is deliberately **no `superseded_by` column**. Writing one would mean
mutating a sealed run to record that it had been corrected, which is exactly
what sealing forbids. The reverse lookup is a partial index on
`supersedes_run_id`.

**`artifact`** — content-addressed, deduplicated, immutable.

| Column | Notes |
|---|---|
| `digest` | SHA-256 hex. **Unique per tenant** — the deduplication mechanism |
| `size_bytes` | Verified against the stored object on completion |
| `storage_key` | `sha256/ab/cd/abcd…` — derived from the digest, stored anyway because the derivation rule may change and existing objects keep their key |
| `first_seen_run_id` | Provenance for the content itself |

Deduplication is scoped to the tenant rather than global. Global dedup is
strictly better for storage and strictly worse for confidentiality: a shared
digest namespace makes the existence of a digest an oracle telling tenant A that
tenant B holds a particular file, which in this setting may be an unpublished
result. ([ADR-0017](adr/0017-tenant-scoped-rather-than-global-content-deduplication.md))

`run_artifact` is the join, carrying the logical name within the run
(`ch0/stack.tif`), the declared digest and size, and the verification state. The
same bytes appearing in two runs is one `artifact` row and two `run_artifact`
rows — a real and constant case with instrument calibration files.

**`audit_event`** — append-only, hash-chained.

| Column | Notes |
|---|---|
| `tenant_id`, `seq` | Composite primary key; `seq` is a per-tenant monotonic counter |
| `actor_type`, `actor_id`, `actor_label` | User, instrument, or system. The label is denormalised at write time so the trail stays readable years later |
| `action`, `target_type`, `target_id` | What happened, to what |
| `payload` | JSONB — before/after state |
| `payload_digest` | SHA-256 of the JCS-canonicalised payload |
| `prev_hash` | Hash of event `seq - 1`; genesis is 64 zeroes |
| `hash` | `SHA256(tenant_id ‖ seq ‖ prev_hash ‖ payload_digest ‖ occurred_at)` |
| `occurred_at` | Server-authoritative, `clock_timestamp()` |

**`derivation`** — a processing activity linking inputs to outputs. Carries
`processor_name`, `processor_version`, `parameters_digest` and `inputs_digest`,
with a unique constraint on
`(tenant_id, inputs_digest, processor_name, processor_version, parameters_digest)`.
That constraint *is* the worker's idempotency guarantee.

`inputs_digest` is a digest over the **sorted, deduplicated set** of input
artifact digests — a set rather than a list, because the same inputs in a
different order are the same inputs, and over digests rather than ids, because
the same content through different artifact rows is the same work.

**`idempotency_key`** — `(tenant_id, key, endpoint)` unique, storing the request
fingerprint, a state of `IN_FLIGHT | COMPLETED`, the stored response, and an
expiry.

**`job`** — the queue. `(tenant_id, queue, dedupe_key)` unique where
`dedupe_key` is not null, so a replayed seal cannot enqueue twice.

### Canonicalization

Hashing anything requires a deterministic byte representation. JSON key order
and number formatting are not deterministic by default. The service uses **JCS
(RFC 8785)** for canonical JSON before any digest.

This is a small detail that matters enormously, and its failure mode is what
makes it worth a decision record: a chain built on non-canonical serialization
verifies perfectly until the day an unrelated library upgrade or a different
code path changes an insertion order — at which point history that was never
touched starts failing verification, and the real cause is months behind you.
Implemented in `src/common/canonical-json.ts` and pinned to the RFC's own test
vectors. ([ADR-0009](adr/0009-jcs-rfc-8785-canonical-json-for-all-digests.md))

---

## 5. Run lifecycle

```
                    ┌─────────────────┐
   register ───────▶│      OPEN       │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     all artifacts    digest mismatch    abandon()
     verified,             │                │
     seal()                ▼                ▼
              │     ┌─────────────┐  ┌─────────────┐
              │     │ QUARANTINED │  │  ABANDONED  │
              │     └─────────────┘  └─────────────┘
              ▼            (both terminal)
       ┌─────────────┐
       │   SEALED    │◀── immutability boundary
       └──────┬──────┘
              │ enqueued in the sealing transaction
              ▼
       ┌─────────────┐        ┌────────────────────┐
       │ PROCESSING  │───────▶│ PROCESSING_FAILED  │
       └──────┬──────┘        └────────────────────┘
              │                    (retryable)
              ▼
       ┌─────────────┐
       │  PROCESSED  │
       └─────────────┘
```

The transition table lives in exactly two places, deliberately:

1. `src/ingestion/run-state-machine.ts` — pure, no I/O, exhaustively unit
   tested. This is the readable definition.
2. `aliquot.enforce_run_immutability()` in `migrations/0004_runs.sql` — the
   trigger that holds when something reaches the table by another route.

They duplicate each other on purpose. If they ever disagree, the database wins
and the TypeScript is the bug.

`SEALED` onwards, run metadata and artifact bindings are frozen. Processing
state changes are recorded on the run but do not touch sealed content: the
trigger compares `to_jsonb(OLD)` minus an allow-list of five processing columns
against the same projection of `NEW`, and raises on any difference. That fails
closed — a column added by a later migration is immutable by default.

---

## 6. Key flows

### 6.1 Idempotent registration

```
Agent                          API                        Postgres
  │                             │                            │
  ├─ POST /v1/studies/{id}/runs▶│                            │
  │  Idempotency-Key: K         │                            │
  │  body B                     ├─ INSERT idempotency_key ──▶│
  │                             │  (tenant, K, endpoint)     │
  │                             │  fingerprint = H(JCS(B))   │
  │                             │  COMMITTED before work     │
  │                             │◀── unique violation? ──────┤
  │                             │                            │
  │              ┌──────────────┴───────────────┐            │
  │              │ no violation → first request │            │
  │              │   create run + audit event   │            │
  │              │   store response, mark done  │            │
  │              ├──────────────────────────────┤            │
  │              │ violation → replay           │            │
  │              │   fingerprint matches?       │            │
  │              │     COMPLETED → stored resp  │            │
  │              │     IN_FLIGHT → 409 + Retry  │            │
  │              │   mismatch    → 409 conflict │            │
  │              └──────────────┬───────────────┘            │
  │◀── response ────────────────┤                            │
```

The unique constraint does the concurrency work. No application-level locking,
no check-then-act, and therefore no race window.

Two details carry the guarantee and are easy to get wrong:

- **The `IN_FLIGHT` row must commit before the work runs.** If it were part of
  the same transaction as the run creation, a concurrent duplicate could not see
  it and both callers would proceed. The second caller is told to retry rather
  than being handed a half-built resource.
- **A failed request deletes its key.** Otherwise a transient failure poisons
  that key for the full retention window and a legitimate retry is rejected as a
  fingerprint match against a response that never existed.

Records expire after 24 hours. A replay after expiry is treated as a first-time
request — documented rather than incidental.
([ADR-0001](adr/0001-idempotency-key-with-request-fingerprint-not-natural-key-upsert.md))

### 6.2 Upload and seal

1. The agent declares the manifest at registration: logical names, sizes,
   expected digests. `manifest_digest` is fixed at that moment.
2. For each artifact the agent requests an upload session. **If the digest
   already exists for this tenant, the service binds the existing artifact and
   returns *already present*** — the byte transfer is skipped entirely. Content
   addressing pays for itself here, constantly.
3. Otherwise the service issues presigned multipart URLs. **The agent uploads
   directly to object storage.** Bytes never pass through Node.
4. Resume is re-calling step 3: the service returns fresh presigned URLs for
   only the parts not already recorded in `upload_part`. Fresh rather than
   reused, because URLs expire and surviving a transfer longer than the TTL is
   the entire point of resumability.
5. On completion the service verifies size, then **reads the stored object back
   and computes SHA-256 over the actual bytes**. An S3 multipart ETag is not the
   object's hash, so it cannot verify content. This costs one extra read of
   every byte and is the dominant cost of ingest at scale; the alternative —
   trusting the declared digest — would make the integrity guarantee
   unfalsifiable.
6. Mismatch → artifact `REJECTED`, run → `QUARANTINED`, audit event naming the
   artifact. Order matters: the `run_artifact` row is marked first, because the
   trigger only permits touching manifest bindings while the run is `OPEN`.
7. When every declared artifact is `VERIFIED`, `seal()` succeeds. In one
   transaction: manifest digest re-checked, state → `SEALED`, audit event
   appended, processing job enqueued.

### 6.3 Processing

The worker claims a job with `FOR UPDATE SKIP LOCKED`, sets `app.tenant_id` from
the claimed row, resolves input artifacts, runs each processor, writes outputs to
content-addressed storage, and records a `derivation`.

The unique constraint on derivation identity makes the whole operation safely
re-runnable. A crash between "wrote output" and "recorded derivation" resolves
correctly on retry, because writing identical bytes to a digest-derived location
is itself idempotent — the second write produces the same object at the same
key. A conflict on the derivation insert is treated as success and the job is
acknowledged.

Expired leases are reclaimed by the same statement that claims new work, with
`attempts` already incremented, so a job that reliably kills its worker walks its
retry budget down to `DEAD` rather than looping forever.

### 6.4 Audit verification

Walk events for a tenant in `seq` order. For each: recompute `payload_digest`
from the stored payload, recompute `hash` from
`(tenant_id, seq, prev_hash, payload_digest, occurred_at)`, compare against the
stored hash, and confirm `prev_hash` matches the predecessor's `hash` with no
gap in `seq`. Return clean, or the sequence number of the first divergence and
which component failed.

The verifier is **deliberately independent code** from the appender: the append
path computes the hash in SQL, the verifier recomputes it in TypeScript. A
verifier sharing an implementation with the appender cannot detect a bug in that
implementation.

One trap worth naming, because it produces a false positive that looks exactly
like tampering: `occurred_at` is rendered with **microsecond** precision, and a
JavaScript `Date` carries only milliseconds. The verifier therefore selects
`aliquot.audit_timestamp_text(occurred_at)` as text rather than formatting a
parsed date.

**What this does and does not protect against — stated honestly, because
overclaiming here is the most common way this pattern is oversold.**

*Detected:* modification of a payload, deletion of an event from the middle of
the chain, reordering, and modification of a domain row whose state disagrees
with the audited history.

*Not detected by the chain alone:* an actor with full database privileges who
rewrites an event **and** recomputes every subsequent hash. Chaining raises the
cost of tampering from one `UPDATE` to a full rewrite; it does not make it
impossible. Closing that gap requires anchoring chain heads outside the
database — periodic checkpoint digests written to append-only external storage,
or signed by a key the database role cannot reach. `audit_checkpoint` carries an
`external_ref` column for exactly that, and it is null in a single-node
deployment, which is the honest default.
([ADR-0005](adr/0005-hash-chained-audit-log-in-postgresql-not-an-external-ledger.md))

---

## 7. API surface

```
POST   /v1/studies/{studyId}/runs               Register a run      [Idempotency-Key]
GET    /v1/runs                                 Search
GET    /v1/runs/{runId}                         Run with manifest and state
POST   /v1/runs/{runId}/seal                    Seal                [Idempotency-Key]
POST   /v1/runs/{runId}/abandon
POST   /v1/runs/{runId}/supersede               Correct a sealed run [Idempotency-Key]

POST   /v1/runs/{runId}/artifacts/{name}/upload           Begin/resume → presigned parts
POST   /v1/runs/{runId}/artifacts/{name}/upload/parts     Record a completed part
POST   /v1/runs/{runId}/artifacts/{name}/upload/complete  Verify and bind

GET    /v1/artifacts/{artifactId}
GET    /v1/artifacts/{artifactId}/download                302 → presigned GET
GET    /v1/artifacts/{artifactId}/lineage                 ?direction=ancestors|descendants|both
GET    /v1/artifacts/{artifactId}/lineage.prov.json       W3C PROV-JSON

GET    /v1/audit                                Paged event stream
POST   /v1/audit/verify                         Walk and verify the chain
GET    /v1/audit/checkpoints
POST   /v1/audit/checkpoints

POST   /v1/instruments                          Register a machine client
GET    /v1/studies/{studyId}/members
```

**Conventions.**

- **Cursor pagination throughout.** Offset pagination over an append-only log is
  wrong: `OFFSET 200` is evaluated against the log as it looks when the query
  runs, so events appended between pages displace every row behind them. A
  descending reader sees duplicates; an ascending reader silently never sees
  some rows at all. For a log whose purpose is completeness that is a
  correctness failure.
- **RFC 9457 problem details** for every error, including a correlation
  identifier so a caller can quote it.
- **`Idempotency-Key`** follows the IETF draft semantics rather than a bespoke
  scheme.
- **Every mutation returns `auditSeq`**, the sequence number of the audit event
  it produced, so a caller can immediately verify its own write landed in the
  chain.
- **Logical names contain slashes** (`ch0/stack.tif`), because instruments
  organise output as a directory tree and flattening it loses information. The
  routes use a wildcard parameter accordingly.

---

## 8. Multi-tenancy and authorization

Two layers, deliberately redundant.

**Application layer** — a guard resolves the principal (user session or
instrument credential), determines tenant and study role, and checks the
required permission.

**Database layer** — every request runs inside a transaction that sets
`app.tenant_id`. Row-level security policies on every tenant-scoped table filter
on `tenant_id = aliquot.current_tenant_id()`. The application connects as a role
that does *not* have `BYPASSRLS`, and the service asserts this at startup and
refuses to boot otherwise.

The redundancy is the point: the second layer holds when the first has a bug,
which is the realistic failure mode. A forgotten `WHERE tenant_id = ?` returns
zero rows instead of leaking a competitor's data.

Three implementation details carry more weight than they look like they do:

- **`SET LOCAL`, not `SET`.** A plain `SET` survives on a pooled connection and
  the next request inherits the previous request's tenant. That is precisely the
  bug this layer exists to prevent, introduced by the code enforcing it. The
  value is applied with `set_config(..., true)` and a bind parameter, because
  `SET LOCAL x = $1` is not valid syntax and the naive workaround is string
  interpolation.
- **Policies deny by default.** `current_tenant_id()` returns `NULL` when the
  session variable is absent, and `tenant_id = NULL` is `NULL`, which RLS treats
  as false. A request that forgets to set the tenant sees zero rows rather than
  every row.
- **`FORCE ROW LEVEL SECURITY`, not just `ENABLE`.** Without `FORCE`, the table
  owner bypasses its own policies — and migrations run as the owner.

**Grants are narrowed deliberately.** The application role has `INSERT` and
`SELECT` on `audit_event` and nothing else; it has no privileges at all on
`audit_chain_head`, which is reachable only through the `SECURITY DEFINER`
function `append_audit_event()`. If the application could write the chain head
directly it could rewind the chain and re-append over the top of it.

**The login role holds no privileges of its own.** `aliquot_app` and
`aliquot_worker` are `NOLOGIN` group roles carrying the table grants; the role
in `DATABASE_URL` is `NOINHERIT` and a member of both, so every transaction must
`SET LOCAL ROLE` into one. Forgetting to is not a subtle escalation — it is an
immediate permission error.
([ADR-0016](adr/0016-unprivileged-noinherit-login-role-with-set-local-role-per-transaction.md))

**The worker is the one asymmetry.** Claiming work necessarily precedes knowing
whose work it is, so `aliquot_worker` has a policy granting cross-tenant
visibility on the `job` table — and only that table. Having claimed a job it
sets `app.tenant_id` from the job row and is scoped exactly like the API for
everything else. The privilege is bounded to the single place where cross-tenant
visibility is structurally unavoidable, rather than handed out as `BYPASSRLS`.

Shared-schema-with-RLS was chosen over schema-per-tenant and database-per-tenant.
([ADR-0002](adr/0002-shared-schema-with-row-level-security-for-tenant-isolation.md))

**A view is the easiest way to undo all of this.** A view over an RLS-protected
table executes with its owner's privileges unless declared
`WITH (security_invoker = true)`, which silently evaluates the policies against
the wrong role. `scripts/lint-migrations.ts` fails CI on a view declared without
it, and on any table carrying `tenant_id` without a forced policy.

---

## 9. Failure modes

| Failure | Behaviour | Recovery |
|---|---|---|
| Agent retries registration after a timeout | Idempotency key replays the stored response | None needed |
| Two agents submit the same run concurrently | Unique constraint; loser gets `409` with `Retry-After` | Client retries, receives stored response |
| Registration fails partway | In-flight key row is deleted | Retry with the same key is a first-time request |
| Network drops mid-upload | Multipart parts already stored persist | Resume returns presigned URLs for outstanding parts only |
| Presigned URL expires mid-transfer | That part fails | Re-call begin; fresh URLs are minted |
| Corrupted chunk | Digest mismatch on completion | Run quarantined naming the artifact; operator supersedes with a corrected run |
| API crashes between seal and enqueue | Impossible — same transaction | N/A |
| Worker crashes mid-job | Lease expires, job reclaimed with `attempts` incremented | Derivation uniqueness prevents duplicate output |
| Worker succeeds but crashes before ack | Job redelivered, derivation insert conflicts | Conflict treated as success; job acked |
| Job fails repeatedly | Exponential backoff to a ceiling, then `DEAD` with `last_error` retained | Manual inspection with a `SELECT` |
| Object storage unavailable | Upload sessions fail; readiness probe fails; metadata plane stays available | Retry; runs stay `OPEN` |
| Database failover | In-flight transactions roll back | Idempotency keys make every retry safe |
| Clock skew on an instrument | Declared `acquired_at` is skewed; audit time is not | Audit ordering is unaffected |
| Two audit appends race | Row lock on the chain head serialises them per tenant | Neither can take the same `prev_hash` |

---

## 10. Observability

Structured JSON logs (pino) with a correlation identifier minted at the edge,
**stored on the job row at enqueue, and restored by the worker when it claims
that job**. Without that hop the two halves of "why did this run never finish
processing" live in unrelated log streams, which is the question an operator is
actually asking.

Log fields are redacted by key against an allow-list that includes presigned
URLs — a presigned URL in a log sink is a live write capability against the
object store.

Metrics that would actually be alerted on: registration idempotency hit rate (a
sudden spike means an agent is misbehaving), upload verification failure rate,
time from seal to processed, dead-letter depth, oldest unclaimed job age, and
chain verification duration.

Health endpoints separate liveness from readiness. Readiness includes object
storage reachability, because a service that accepts registrations it cannot
fulfil is worse than one that refuses them.

---

## 11. Testing strategy

Integration-first, against real dependencies via Testcontainers — real
PostgreSQL so RLS policies and triggers are actually exercised, real MinIO so
multipart and presigning are actually exercised. Mocked infrastructure would
test none of the properties that matter here.
([ADR-0012](adr/0012-integration-first-testing-with-testcontainers.md))

The integration setup runs `scripts/migrate.ts` rather than applying SQL some
other way, so a broken migration runner fails the suite rather than only failing
a reviewer's first command.

The suite is organized around the guarantees rather than the endpoints:

- **Isolation** — deliberately unscoped queries under a tenant-scoped role,
  across every table carrying `tenant_id` discovered from the catalogue rather
  than from a literal list
- **Immutability** — mutation attempts against sealed runs at every column, via
  a direct privileged connection rather than through the API, because through
  the API the test would pass with the trigger deleted
- **Chain** — clean chain, mutated payload, deleted middle event, rewritten
  hash, reordered pair, concurrent appends, verification anchored to a
  checkpoint, and an explicit test of what chaining alone does not catch
- **Idempotency** — sequential replay, concurrent replay, fingerprint mismatch,
  key-order-only differences treated as replay, expiry, failure not poisoning
  the key
- **Derived artifact access** — processor outputs reachable through their
  derivation's source run rather than through a manifest binding

Two areas are exercised end to end by `scripts/seed.ts` and `scripts/demo.ts`
but do not yet have a dedicated suite, which is worth stating plainly rather
than leaving to be discovered: byte-flip injection and resume-after-interruption
against MinIO, and worker crash, redelivery and dead-lettering. A script that
exits non-zero is real evidence and weaker evidence than a test.

Unit tests cover the state machine transition table and canonicalization
exhaustively. Both are pure, both are load-bearing, both are cheap to test
properly — canonicalization is pinned to RFC 8785's own vectors so it agrees
with other implementations rather than merely with itself.

---

## 12. What I would revisit at scale

Stated explicitly because knowing where a design breaks is more convincing than
pretending it does not.

- **The queue in Postgres** is right at tens of runs per day and wrong at
  thousands per minute. The migration path is a real broker behind the same
  `JobQueue` interface, keeping transactional handoff via an outbox relay. The
  seam exists so that is one module rather than a restructure.
- **Full chain verification is O(n)** and gets slow as history grows. Segment
  the chain into checkpointed epochs so verification starts from the last
  externally-corroborated checkpoint. The checkpoint table already exists and no
  schema change is needed.
- **Lineage traversal is a recursive CTE** — fine to a few thousand nodes, then
  it needs either a materialized closure or a graph store. I would materialize
  before reaching for a second database.
- **Audit table growth** — partition by tenant and month. The composite key
  `(tenant_id, seq)` is already ordered to make that a non-event.
- **Re-hashing every uploaded byte** is the dominant cost of ingest at hundreds
  of GB per artifact. If it became the bottleneck I would push the hash into the
  storage tier rather than drop the verification.
- **Digest computation on the client** is a trust assumption: the service
  verifies that what was stored matches what was *declared*, which catches
  transport corruption but not a lying agent. Closing it means generating the
  digest at acquisition time, which means an agent on the instrument — PRD R16.
- **`fileParallelism: false`** in the integration suite trades wall-clock for
  determinism. At a few dozen suites that is the right trade; beyond that it
  needs per-suite schemas rather than per-suite tenants.
