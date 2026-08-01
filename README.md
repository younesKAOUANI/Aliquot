# Aliquot

**Instrument run ingestion & provenance service.**

Research instruments produce data faster than the processes managing them. A
single lightsheet microscope session is terabytes across thousands of files, and
the prevailing practice is a network share, a folder naming convention, and
institutional memory. Aliquot is the layer underneath that: it gets data off
instruments and into a research data platform without losing track of where any
of it came from.

It is deliberately **infrastructure, not science**. It does not analyse images,
call bases, or interpret results.

```
docker compose up
```

That is the whole setup. The stack comes up migrated, seeded, and demo-ready at
<http://localhost:3000> — API docs at `/docs`, read-only viewer at `/`.

If something already holds 3000, 5433, 9000 or 9001, override the published
ports rather than fighting for them:

```
ALIQUOT_API_PORT=3100 ALIQUOT_MINIO_PORT=9200 \
ALIQUOT_MINIO_CONSOLE_PORT=9201 ALIQUOT_POSTGRES_PORT=55434 \
docker compose up
```

---

## Contents

- [What problem this solves](#what-problem-this-solves)
- [The five guarantees](#the-five-guarantees)
- [How it works](#how-it-works)
- [Running it](#running-it)
- [API](#api)
- [Design decisions](#design-decisions)
- [Testing](#testing)
- [What I would do differently at scale](#what-i-would-do-differently-at-scale)
- [Project layout](#project-layout)

---

## What problem this solves

Three specific failures, each of which compounds quietly:

**Ingestion is unreliable.** Instrument software retries on network failure.
Operators re-run uploads they think failed. The result is duplicated runs,
partial runs indistinguishable from complete ones, and corruption that surfaces
months later during analysis.

**Provenance is lost.** Given a figure in a paper, there is often no mechanical
way to answer *which raw acquisition produced this, on which instrument, by
whom, processed with which version of which code*. Reproducibility becomes
archaeology.

**The record is not defensible.** In an audited environment, "we're fairly sure
this file wasn't modified" is not an answer. Integrity has to be demonstrable,
not asserted.

---

## The five guarantees

Everything in this repository exists to hold one of these up. Each is verified
by a named test rather than asserted here.

| | Guarantee | Mechanism | Proof |
|---|---|---|---|
| **G1** | Ingestion is exactly-once from the caller's perspective | Idempotency key + request fingerprint, with the unique constraint doing the concurrency work | `test/integration/idempotency.spec.ts` — N concurrent identical requests produce one row and N identical responses |
| **G2** | Every stored byte is integrity-verified | Declared-then-uploaded manifest; stored object is re-read and re-hashed on completion | `test/integration/immutability.spec.ts` for content addressing and deduplication; `scripts/demo.ts` drives a real corrupted upload end to end and asserts the run quarantines |
| **G3** | Any output traces to its inputs mechanically | Derivation records with processor name and version; W3C PROV projection | `test/integration/derived-artifact-access.spec.ts`; `scripts/demo.ts` walks a derived artifact back to its instrument and operator |
| **G4** | Tampering is detectable, not merely discouraged | Per-tenant hash chain, computed in the database, verified by independent code | `test/integration/audit-chain.spec.ts` — a row mutated via a privileged connection is named by sequence number |
| **G5** | Tenants are isolated by construction | Row-level security below the application, on a role without `BYPASSRLS` | `test/integration/isolation.spec.ts` — a deliberately unscoped query under a tenant role returns zero rows |

The last one is worth dwelling on. Application-layer authorization is checked
*and* every tenant-scoped table has a forced row-level security policy. The
redundancy is the point: the second layer holds when the first has a bug, which
is the realistic failure mode. A forgotten `WHERE tenant_id = ?` returns zero
rows instead of leaking a competitor's unpublished results.

---

## How it works

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

**One database does three jobs** — domain state, audit chain, and job queue.
That is a deliberate simplification with a concrete payoff: enqueueing
processing work happens *in the same transaction* as the seal that triggers it,
which removes the dual-write problem rather than mitigating it. There is no
outbox relay, no CDC pipeline, and no window where the state committed but the
event was lost. The cost is that queue throughput is bounded by the database,
and at tens of runs per day that ceiling is nowhere near.
([ADR-0004](docs/adr/0004-job-queue-in-postgresql-rather-than-a-dedicated-broker.md))

**Bytes never pass through Node.** The API is a control plane. Uploads go
directly to object storage over presigned multipart URLs; the service issues
capabilities and verifies results. A 500 GB transfer proxied through an
application process would tie up that process for hours and buy nothing.
([ADR-0006](docs/adr/0006-presigned-direct-to-storage-upload-bytes-never-transit-the-api.md))

### The run lifecycle

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

Sealing is the immutability boundary. After it, run metadata and artifact
bindings are frozen — and frozen *by the database*, not by an `if` statement.
A `BEFORE UPDATE` trigger compares `to_jsonb(OLD)` minus an allow-list against
the same projection of `NEW` and raises on any difference. That technique fails
closed: a column added by a future migration is immutable by default, and making
it mutable requires saying so explicitly.
([ADR-0007](docs/adr/0007-immutability-enforced-by-database-trigger-and-grants-not-application-code.md))

Correction after sealing is by **superseding record**. A correction mints a new
run whose `supersedes_run_id` points backwards; the original is never touched.
An external citation therefore keeps pointing at exactly the bytes it cited.
([ADR-0010](docs/adr/0010-correction-by-superseding-record-never-by-mutation.md))

### Declared, then uploaded

A run declares its manifest at registration — logical name, expected size,
expected SHA-256 — before any bytes move. This is what makes completeness
*checkable* rather than assumed: without a declaration, "the upload finished"
and "everything that was going to be uploaded was uploaded" are the same
statement, and a truncated transfer is indistinguishable from a small run.

If the declared digest already exists for the tenant, the transfer is skipped
entirely — content addressing paying for itself, which happens constantly with
instrument calibration files. Otherwise the service issues presigned multipart
URLs, and on completion **re-reads the stored object and hashes it**. That costs
one extra read of every byte and it is the honest way to verify what was
actually stored; trusting the client's digest would make the integrity claim
unfalsifiable. It proves stored bytes match the *declared* digest, which catches
transport corruption but not a producer that lied — a limitation stated plainly
in [ADR-0003](docs/adr/0003-content-addressed-object-storage-keyed-by-sha-256.md)
rather than papered over.

### The audit chain

Every state change appends an event carrying actor, action, target, a digest of
the payload, and the hash of its predecessor:

```
hash = SHA256(tenant_id ‖ seq ‖ prev_hash ‖ payload_digest ‖ occurred_at)
```

Four of those five inputs are chosen by the **database**, not the application.
`append_audit_event()` takes a row lock on the tenant's chain head, assigns the
next sequence number, stamps `clock_timestamp()`, and computes the hash — so the
audited party cannot pick its own tamper-evidence. Only `payload_digest` comes
from the application, because RFC 8785 canonicalisation in plpgsql is not a
maintainable artifact, and that digest is itself covered by the chain.
([ADR-0015](docs/adr/0015-audit-hash-computed-in-the-database-canonicalisation-in-the-application.md))

The application role is granted `INSERT` and `SELECT` on `audit_event` and
nothing else. There is no code path that can update or delete an audit event
because the privilege does not exist. A trigger rejects mutation independently,
so the guarantee survives a future role being granted too much.

**What this does not protect against, stated plainly:** an actor with full
database privileges can rewrite an event *and* recompute every subsequent hash.
Chaining raises the cost of tampering from one `UPDATE` to a full rewrite; it
does not make it impossible. Closing that gap requires anchoring chain heads
outside the database — which is what `audit_checkpoint.external_ref` exists for.
Overclaiming here is the most common way this pattern is oversold.
([ADR-0005](docs/adr/0005-hash-chained-audit-log-in-postgresql-not-an-external-ledger.md))

### Provenance

Lineage is structural, not documentary. It lives in the schema as first-class
relationships, mapped onto **W3C PROV** so it can be exported rather than
trapped in a bespoke shape:

| Aliquot | PROV |
|---|---|
| `artifact` | `prov:Entity` |
| `run` (acquisition), `derivation` (computation) | `prov:Activity` |
| `app_user`, `instrument` | `prov:Agent` |

`GET /v1/artifacts/{id}/lineage.prov.json` emits PROV-JSON.
([ADR-0008](docs/adr/0008-lineage-modelled-on-w3c-prov.md))

A derivation's identity is
`(inputs_digest, processor_name, processor_version, parameters_digest)`, and
that unique constraint *is* the worker's idempotency guarantee: re-running
identical work cannot create a second record. A worker that crashes between
"wrote the output" and "recorded the derivation" converges on retry, because
writing identical bytes to a digest-derived storage key is itself idempotent.

---

## Running it

### Everything at once

```bash
docker compose up
```

Brings up PostgreSQL, MinIO, the migration runner, the API, the worker, and a
seed job — in that dependency order, with health gates between them. When it
settles:

| | |
|---|---|
| API | <http://localhost:3000> |
| OpenAPI / docs | <http://localhost:3000/docs> |
| Viewer | <http://localhost:3000/> |
| MinIO console | <http://localhost:9001> (`aliquot` / `aliquot-dev-secret`) |
| PostgreSQL | `localhost:5433` (`postgres` / `postgres`) |

### The demo

```bash
docker compose run --rm demo
```

Drives a full lifecycle against a running stack and prints what happened at each
step: register a run, replay the registration to show the idempotent response,
upload artifacts, seal, watch the worker produce derived artifacts, walk the
lineage, then deliberately corrupt an audit row and show verification naming the
exact broken sequence number. It exits non-zero if any step does not behave as
narrated, so it doubles as a smoke test.

To follow the same arc by hand with `curl`, see [`docs/DEMO.md`](docs/DEMO.md).

It runs *inside* the compose network rather than from your shell, and that is
worth understanding because it will bite you otherwise: a presigned URL is
signed for a specific host, so the URLs this API issues name `minio:9000`.
That is reachable from the worker and from a container on the same network, and
not from your laptop. Signing them for `localhost` would fix the laptop and
break the worker. A real deployment has one externally-resolvable storage
endpoint and the question does not arise.

### Locally, without containers

```bash
cp .env.example .env
docker compose up -d postgres minio
npm ci
npm run migrate

npm run build:watch     # terminal 1 — recompiles on change
npm run dev             # terminal 2 — api
npm run dev:worker      # terminal 3 — worker

npm run seed            # once the api is up; the seed drives it over HTTP
```

The API runs from compiled output rather than through `tsx`. That is not a
preference: esbuild — which `tsx` uses — does not emit `design:paramtypes`, and
without that metadata NestJS constructor injection resolves every dependency to
`undefined`. Vitest's transform does emit it, which is why the test suite runs
straight from TypeScript while the service does not.

### Verifying a change

```bash
npm run verify   # format, lint, typecheck, migration lint, unit, integration
```

---

## API

RFC 9457 problem details for errors. Cursor pagination throughout — offset
pagination over an append-only log skips and repeats rows under concurrent
inserts, which for an audit stream is a correctness failure rather than a
cosmetic one. Every mutation returns the sequence number of the audit event it
produced, so a caller can immediately verify its own write landed in the chain.

```
POST   /v1/studies/{studyId}/runs               Register a run      [Idempotency-Key]
GET    /v1/runs                                 Search: study, instrument, operator, state, dates
GET    /v1/runs/{runId}                         Run with manifest, state, supersede chain
POST   /v1/runs/{runId}/seal                    Seal                [Idempotency-Key]
POST   /v1/runs/{runId}/abandon
POST   /v1/runs/{runId}/supersede               Correct a sealed run [Idempotency-Key]

POST   /v1/runs/{runId}/artifacts/{name}/upload           Begin or resume → presigned parts
POST   /v1/runs/{runId}/artifacts/{name}/upload/parts     Record a completed part
POST   /v1/runs/{runId}/artifacts/{name}/upload/complete  Verify and bind

GET    /v1/artifacts/{artifactId}
GET    /v1/artifacts/{artifactId}/download                302 → presigned GET
GET    /v1/artifacts/{artifactId}/lineage                 ?direction=ancestors|descendants|both
GET    /v1/artifacts/{artifactId}/lineage.prov.json       W3C PROV-JSON

GET    /v1/audit                                Paged event stream for the tenant
POST   /v1/audit/verify                         Walk and verify the chain
GET    /v1/audit/checkpoints
POST   /v1/audit/checkpoints

POST   /v1/instruments                          Register a machine client
GET    /v1/studies/{studyId}/members
```

Instruments authenticate as first-class machine clients with their own
credentials, distinct from human users, and may only deposit into studies they
have been explicitly granted. That matters because an instrument credential is a
long-lived secret sitting on an acquisition workstation in a shared lab.

---

## Design decisions

Nineteen decisions are recorded in [`docs/adr/`](docs/adr/), each with the
options that were rejected and why. The rejected options are the valuable part —
they are the evidence a decision was made rather than defaulted into.

If you have time for four:

- **[0002 — Shared schema with row-level security](docs/adr/0002-shared-schema-with-row-level-security-for-tenant-isolation.md)**
  The deciding argument was not isolation strength, since schema-per-tenant is
  comparable. It was failure mode: a too-permissive policy is caught by a test
  asserting an unscoped query returns zero rows. A partially-applied per-schema
  migration leaving tenants on divergent versions is not caught by anything.
  *A failure mode you can write a test for beats one you cannot.*

- **[0005 — Hash-chained audit log, not an external ledger](docs/adr/0005-hash-chained-audit-log-in-postgresql-not-an-external-ledger.md)**
  Including an honest statement of the residual risk that chaining does not
  address.

- **[0004 — Job queue in PostgreSQL](docs/adr/0004-job-queue-in-postgresql-rather-than-a-dedicated-broker.md)**
  Redis + BullMQ is the reflexive choice in a Node codebase, and it buys
  throughput this system does not need at the cost of the exact correctness
  property it does. Choosing the more capable tool that reintroduces the bug you
  were avoiding is a bad trade.

- **[0010 — Correction by superseding record](docs/adr/0010-correction-by-superseding-record-never-by-mutation.md)**
  The decision that most shapes the API, and the one that stayed open longest.

Full index and reading map: [`docs/adr/README.md`](docs/adr/README.md).
Technical design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
Requirements and phasing: [`docs/PRD.md`](docs/PRD.md).

### The vocabulary is not decoration

This is a domain with existing language, and using it correctly is part of being
useful in it.

**ALCOA+** — Attributable, Legible, Contemporaneous, Original, Accurate, plus
Complete, Consistent, Enduring, Available — is used as a design checklist.
Concretely: every event carries an actor and a denormalised label captured at
the time (attributable, and still legible after that user is renamed);
timestamps are server-side at the moment of the event (contemporaneous); the
first-captured artifact is retained alongside every derivative (original);
nothing is deleted (enduring).

**FAIR** — Findable, Accessible, Interoperable, Reusable — frames the query
surface: stable identifiers, searchable metadata, standard schemas, and
provenance that travels with the data.

This service is **designed against** GxP / 21 CFR Part 11 principles and could
be validated. It is not validated, and it does not claim to be — validation is
an organizational process involving qualification protocols and signed evidence,
not a property of code.

---

## Testing

Integration-first, against real PostgreSQL and real MinIO via Testcontainers.
Mocked infrastructure would exercise none of the properties that matter here:
row-level security policies, triggers, grants, and presigned multipart uploads
do not exist in a mock, and those are precisely where the guarantees live.
([ADR-0012](docs/adr/0012-integration-first-testing-with-testcontainers.md))

The suite is organised around **guarantees**, not endpoints:

| Suite | Covers |
|---|---|
| `isolation` | unscoped queries under a tenant-scoped role, on every table found in the catalogue; deny-by-default; the worker's bounded cross-tenant privilege; that the login role is powerless before `SET LOCAL ROLE` |
| `immutability` | mutation of a sealed run at every column via a **privileged** connection; the trigger's transition table; frozen manifest bindings; artifact immutability; per-tenant deduplication; supersede leaving the predecessor byte-identical |
| `audit-chain` | clean chain, mutated payload, deleted middle event, rewritten hash, reordered pair, concurrent appends, checkpoint-anchored verification — and a test asserting what chaining alone does **not** catch |
| `idempotency` | sequential replay, concurrent replay (8 at once → one row), fingerprint mismatch, key-order-only differences treated as replay, expiry, failure not poisoning the key |
| `derived-artifact-access` | processor outputs reachable through their derivation's source run, and still unreachable cross-tenant |

Unit tests cover the pure, load-bearing logic exhaustively: RFC 8785
canonicalisation against the specification's own vectors, digest helpers,
UUIDv7 monotonicity across 20,000 ids minted in one millisecond, and cursor
encoding.

**Not yet covered by an automated suite**, and worth saying rather than
implying otherwise: dedicated byte-flip and resume-after-interruption tests
against MinIO, and worker crash/redelivery and dead-lettering tests. Those paths
are exercised end to end by `scripts/seed.ts` and `scripts/demo.ts` — which do
corrupt an upload and do wait on real processing — but a script that exits
non-zero is weaker evidence than a suite, and this is the next thing to write.

### Browser tests

The viewer gets its own suite, and it earned it. Four defects shipped that no
other layer could see, because the integration tests call the API directly and
never load a page:

- the viewer posted `{ email }` to an endpoint requiring `tenantSlug`, so
  sign-in failed outright
- the token response nests the principal under `user`, so the greeting silently
  fell back to the email
- chain verification posted an empty body to an endpoint that demanded a
  `studyId` — for a chain that is per *tenant*, which was a modelling error in
  the API rather than in the viewer
- the run list rendered `run.study.slug` while the API returned a flat
  `studyId`, so the Study and Instrument columns were blank

Every one is wiring rather than logic, and wiring is exactly what a browser
test is for.

```bash
docker compose up --wait api worker && docker compose up seed
npm run test:e2e           # 12 tests, chromium, ~6s
```

It runs against a stack that is already up rather than starting its own, so it
exercises the same system a reviewer sees. Point it elsewhere with
`ALIQUOT_E2E_BASE_URL`.

```bash
npm run test:unit          # milliseconds, no Docker
npm run test:integration   # real dependencies
npm run test:e2e           # browser, needs a running stack
```

---

## What I would do differently at scale

Stated explicitly, because knowing where a design breaks is more convincing than
pretending it does not.

- **The queue in Postgres** is right at tens of runs per day and wrong at
  thousands per minute. The migration path is a real broker behind the same
  `JobQueue` interface, keeping transactional handoff via an outbox relay. The
  interface exists precisely so that is one module rather than a restructure.
- **Full chain verification is O(n)** and gets slow as history grows. The
  checkpoint table already exists; segmenting verification into epochs that
  start from the last externally-corroborated checkpoint is the fix, and it
  needs no schema change.
- **Lineage traversal is a recursive CTE** — fine to a few thousand nodes, then
  it needs a materialized closure. I would materialize before reaching for a
  second database.
- **Audit table growth** — partition by tenant and month. The composite primary
  key `(tenant_id, seq)` is already ordered to make that a non-event.
- **Re-hashing every uploaded byte** is the dominant cost of ingest at hundreds
  of GB per artifact. The alternative is trusting the declared digest, which is
  cheaper and makes the integrity guarantee unfalsifiable. If this became the
  bottleneck I would move the hash into the storage tier rather than drop it.
- **Digest computation on the client** remains a trust assumption about the
  producer, not about the transport. Closing it fully means the service
  generating the digest at acquisition time, which means an agent on the
  instrument — PRD R16.

---

## Project layout

```
docs/
  PRD.md              requirements, acceptance criteria, phasing
  ARCHITECTURE.md     components, data model, flows, failure modes
  adr/                nineteen decisions, with rejected alternatives
migrations/           forward-only SQL. Reading these is the fastest way in.
src/
  common/             canonical JSON, digests, UUIDv7, problem details, cursors
  database/           pool, tenant-scoped transactions, schema types
  identity/           principals, credentials, authorization
  ingestion/          runs, manifests, idempotency, state machine
  storage/            content addressing, presigning, object store adapter
  uploads/            resumable upload and verification
  audit/              append, hash chain, verification, checkpoints
  provenance/         derivations, lineage, W3C PROV export
  processing/         queue seam, worker runtime, processors
  viewer/             read-only static UI
test/
  unit/               pure logic, exhaustively
  integration/        guarantees, against real dependencies
```

The migrations carry a lot of the reasoning. If you read one thing before the
code, read [`migrations/0003_audit_chain.sql`](migrations/0003_audit_chain.sql)
and [`migrations/0004_runs.sql`](migrations/0004_runs.sql).

---

## Licence

MIT. See [LICENSE](LICENSE).
