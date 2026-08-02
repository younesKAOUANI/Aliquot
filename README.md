# Aliquot

**Instrument run ingestion & provenance service.**

[![ci](https://github.com/younesKAOUANI/Aliquot/actions/workflows/ci.yml/badge.svg)](https://github.com/younesKAOUANI/Aliquot/actions/workflows/ci.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-24-informational)](package.json)
[![postgres](https://img.shields.io/badge/postgres-17-informational)](migrations/)

Research instruments produce data faster than the processes managing them. A
single lightsheet microscope session is terabytes across thousands of files, and
the prevailing practice is a network share, a folder naming convention, and
institutional memory. Aliquot is the layer underneath that: it gets data off
instruments and into a research data platform without losing track of where any
of it came from.

It is deliberately **infrastructure, not science**. It does not analyse images,
call bases, or interpret results.

```bash
docker compose up
```

That is the whole setup. The stack comes up migrated, seeded, and demo-ready:
API at <http://localhost:3000>, docs at `/docs`, read-only viewer at `/`.

---

## Contents

- [Why this exists](#why-this-exists)
- [Case study: plate 04](#case-study-plate-04)
- [The five guarantees](#the-five-guarantees)
- [Running it locally](#running-it-locally)
- [How it works](#how-it-works)
- [API](#api)
- [Design decisions](#design-decisions)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Deployment](#deployment)
- [What I would do differently at scale](#what-i-would-do-differently-at-scale)
- [Project layout](#project-layout)

---

## Why this exists

Three failures, each of which compounds quietly.

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

## Case study: plate 04

Everything below is real output from the seeded dataset. Bring the stack up and
you can reproduce every line of it.

### What happened

An operator, Dana Reyes, acquires a plate on Light-sheet 01 and the agent
registers the run. The manifest declares its artifacts up front — logical name,
expected size, expected SHA-256 — *before any bytes move*. That declaration is
what makes completeness checkable later: without it, "the upload finished" and
"everything that was going to be uploaded was uploaded" are the same sentence.

```
run 019fbf01-bfc4-7000-b0bd-e292ade99243   OPEN   instrument ls-01
  ch0/plate-04-field-001.png     declared c183827ca950d6a9…
```

The agent uploads directly to object storage over presigned URLs; bytes never
touch the API process. On completion the service **reads the stored object back
and hashes it**, and the answer disagrees with the declaration:

```
ch0/plate-04-field-001.png   REJECTED
  stored   0904791d535543ac13d22ad9a26e40e67b4630efcbbd0868f4babf673a4e64e2
  declared c183827ca950d6a95513ab18264db0dec96b66d2afceabf8a4507cb3cf1526cc
```

The run moves to `QUARANTINED`. It is never sealed, so nothing downstream can
consume it by accident, and the audit trail names the artifact rather than
merely recording that something went wrong:

```json
{
  "runId": "019fbf01-bfc4-7000-b0bd-e292ade99243",
  "logicalName": "ch0/plate-04-field-001.png",
  "reason": "stored bytes hash to 0904791d…, declared c183827c…"
}
```

Dana re-transfers from the acquisition PC. The correction is **a new run**, not
an edit:

```
run 019fbf01-c032-7000-b344-5c3c1f0adc54   PROCESSED
  supersedes  019fbf01-bfc4-7000-b0bd-e292ade99243
  reason      "ch0 field 001 failed read-back verification;
               re-transferred from the acquisition PC"
```

The quarantined run is still there, byte-identical, still retrievable. Anything
that ever cited it still points at exactly what it cited. That is the whole
argument for correcting by superseding rather than by mutation
([ADR-0010](docs/adr/0010-correction-by-superseding-record-never-by-mutation.md)).

### What the record says afterwards

Three audit events, in a per-tenant hash chain, each carrying the hash of its
predecessor:

```
seq  action           actor
 33  run.registered   Dana Reyes
 35  run.quarantined  Dana Reyes
 38  run.superseded   Dana Reyes
```

Nobody typed any of that. It is what the ingestion path wrote as a side effect
of doing its job — and it cannot be edited afterwards, because the application
role is granted `INSERT` and `SELECT` on `audit_event` and nothing else.

Ask the service whether the record has been altered:

```json
{ "ok": true, "eventsVerified": 148, "headHash": "cd0c18e348358089f3d2…" }
```

Now corrupt one event as the **database owner**, with the append-only trigger
switched off — the strongest insider this design admits to:

```json
{
  "ok": false,
  "brokenAtSeq": "65",
  "reason": "payload_digest",
  "expected": "a1bbbfd73894cd37ac1fc76c82635465e4b1862df0bd0a2750ad05bb3953abf5",
  "actual":   "5b4ae3e7bbe7d1c3ecba818ad10cc6f7adcb76316a4e2b52396c0f5534a99d68"
}
```

It names the sequence number, which component diverged, and both digests.
`docker compose run --rm demo` performs exactly this, then restores the payload.

**And what it does not do.** An owner who rewrote the event *and* recomputed
every hash after it would produce a chain that verifies. Chaining raises the
cost of tampering from one `UPDATE` to a full rewrite; it does not make it
impossible. Closing that gap needs chain heads mirrored somewhere the database
role cannot reach, which is what `audit_checkpoint.external_ref` exists for.
There is a test asserting the undetected case, because overclaiming here is the
most common way this pattern is oversold
([ADR-0005](docs/adr/0005-hash-chained-audit-log-in-postgresql-not-an-external-ledger.md)).

### What the repeated bytes cost

Nothing, for the parts that repeat. One calibration file appears in four
manifest entries across different runs and is stored **once**:

```
digest 37f91d8674561a9129bfce686f354720499df7b308536ad65a4ed85c6514dec1
  → 1 artifact row, 4 run_artifact rows
```

Storage is content-addressed, so the second upload of identical bytes is skipped
entirely — the service answers *already present* and no transfer happens. With
instrument calibration files this is the normal case, not an optimisation.

Deduplication is scoped per tenant rather than globally, and that is a
deliberate trade of storage for confidentiality: a shared digest namespace makes
the existence of a digest an oracle telling one tenant that another holds a
particular file
([ADR-0017](docs/adr/0017-tenant-scoped-rather-than-global-content-deduplication.md)).

### And what produced what

Sealing enqueues processing in the same transaction as the state change, so
there is no window where a run is sealed and nothing was enqueued. Two
processors run — `checksum-manifest 1.0.0` and `metadata-extract 1.0.0` — and
each records a derivation naming its inputs, its name, and its version.

Asking one of the corrected run's derived artifacts where it came from walks
back to the instrument and the human — `GET /v1/artifacts/{id}/lineage`:

```
artifact 019fbf01-c182…  checksum-manifest/manifest.json    6 nodes, 6 edges

  artifact  ch0/plate-04-field-001.png        sha256:c183827ca950
  artifact  checksum-manifest/manifest.json   sha256:0c497732063e
  activity  checksum-manifest                 1.0.0
  activity  run 019fbf01-c032…                PROCESSED
  agent     Light-sheet 01                    ls-01
  agent     Dana Reyes                        operator
```

The declared digest of the raw acquisition, `c183827ca950…`, is the same value
that failed verification on the first attempt — so the graph reaches all the way
back through the correction to the bytes that were finally accepted.

The same graph is available as W3C PROV-JSON at
`/v1/artifacts/{id}/lineage.prov.json`, because provenance only this service can
read is provenance nobody else can use
([ADR-0008](docs/adr/0008-lineage-modelled-on-w3c-prov.md)).

---

## The five guarantees

Everything in this repository exists to hold one of these up. Each is verified
by a named test rather than asserted here.

| | Guarantee | Mechanism | Proof |
|---|---|---|---|
| **G1** | Ingestion is exactly-once from the caller's perspective | Idempotency key + request fingerprint; the unique constraint does the concurrency work | `test/integration/idempotency.spec.ts` — 8 concurrent identical requests produce one row |
| **G2** | Every stored byte is integrity-verified | Declared-then-uploaded manifest; the stored object is re-read and re-hashed on completion | `test/integration/immutability.spec.ts` for content addressing and dedup; `scripts/demo.ts` corrupts a real upload and asserts quarantine |
| **G3** | Any output traces to its inputs mechanically | Derivation records carrying processor name and version; W3C PROV projection | `test/integration/derived-artifact-access.spec.ts`; `scripts/demo.ts` walks to instrument and operator |
| **G4** | Tampering is detectable, not merely discouraged | Per-tenant hash chain computed in the database, verified by independent code | `test/integration/audit-chain.spec.ts` — a row mutated via a superuser connection is named by sequence number |
| **G5** | Tenants are isolated by construction | Row-level security below the application, on a role without `BYPASSRLS` | `test/integration/isolation.spec.ts` — deliberately unscoped queries return zero rows |

The last one is worth dwelling on. Application-layer authorization is checked
*and* every tenant-scoped table has a forced row-level security policy. The
redundancy is the point: the second layer holds when the first has a bug, which
is the realistic failure mode. A forgotten `WHERE tenant_id = ?` returns zero
rows instead of leaking a competitor's unpublished results.

---

## Running it locally

### Everything at once

```bash
git clone https://github.com/younesKAOUANI/Aliquot && cd Aliquot
docker compose up
```

Brings up PostgreSQL, MinIO, the migration runner, the API, the worker, and a
seed job — in dependency order, with health gates between them.

| | |
|---|---|
| API | <http://localhost:3000> |
| OpenAPI / Swagger UI | <http://localhost:3000/docs> |
| Viewer | <http://localhost:3000/> |
| MinIO console | <http://localhost:9001> (`aliquot` / `aliquot-dev-secret`) |
| PostgreSQL | `localhost:5433` (`postgres` / `postgres`) |

Sign in to the viewer with tenant `acme` and email `mara.okafor@acme.test`. The
seed prints instrument API keys and user tokens on the way out.

**If a port is already taken** — 3000, 5433, 9000 and 9001 are popular — override
the published ports rather than fighting for them. Container-side ports never
change, so nothing inside the stack is affected:

```bash
ALIQUOT_API_PORT=3100 ALIQUOT_MINIO_PORT=9200 \
ALIQUOT_MINIO_CONSOLE_PORT=9201 ALIQUOT_POSTGRES_PORT=55434 \
docker compose up
```

### The narrated walkthrough

```bash
docker compose run --rm demo
```

Nine steps with the evidence printed at each: register, replay to show the
idempotent response, replay with a changed body to show the 409, upload
(including one artifact skipped by digest), seal, wait for the worker, walk the
lineage, verify the chain, then tamper and show verification naming the exact
broken sequence number — and restore it. It exits non-zero if any step does not
behave as narrated, so it doubles as a smoke test.

It runs *inside* the compose network, and that is worth understanding because it
will otherwise confuse you: a presigned URL is signed for a specific host, so
the URLs this API issues name `minio:9000`. That is reachable from the worker
and from a container on the same network, and not from your shell. Signing them
for `localhost` would fix your shell and break the worker. A real deployment has
one externally-resolvable storage endpoint and the question does not arise.

To follow the same arc by hand with `curl`, see [`docs/DEMO.md`](docs/DEMO.md).

### Without containers

```bash
cp .env.example .env
docker compose up -d postgres minio      # dependencies only
npm ci
npm run migrate

npm run build:watch     # terminal 1 — recompiles on change
npm run dev             # terminal 2 — api
npm run dev:worker      # terminal 3 — worker
npm run seed            # once the api is up; the seed drives it over HTTP
```

The service runs from compiled output rather than through `tsx`, and that is not
a preference: esbuild — which `tsx` uses — does not emit `design:paramtypes`, so
without it NestJS constructor injection resolves every dependency to
`undefined`. Vitest's transform does emit it, which is why the test suite runs
straight from TypeScript while the service does not.

### Scripts

| | |
|---|---|
| `npm run verify` | format, lint, typecheck, migration lint, unit, integration |
| `npm run test:unit` | pure logic, milliseconds, no Docker |
| `npm run test:integration` | real PostgreSQL + MinIO via Testcontainers |
| `npm run test:e2e` | browser tests, needs a running stack |
| `npm run migrate` | apply migrations, bootstrap the login role |
| `npm run seed` | idempotent demo dataset |
| `npm run demo` | narrated walkthrough (prefer the compose form above) |
| `npm run lint:migrations` | fail if a tenant-scoped table has no policy |

### Configuration

Everything is parsed once at startup by a Zod schema; nothing reads
`process.env` afterwards. A missing or malformed variable is a startup failure
naming the variable. Full list with commentary in
[`.env.example`](.env.example). The two that matter most:

- **`DATABASE_URL`** points at an unprivileged, `NOINHERIT` login role that holds
  no table privileges of its own. The service asserts at startup that it is not
  a superuser and does not have `BYPASSRLS`, and **refuses to boot** otherwise —
  because a privileged role silently disables tenant isolation while every test
  still passes.
- **`AUTH_DEV_TOKEN_ENDPOINT`** enables `POST /v1/auth/token`, which mints a
  session from an email address. The service refuses to start with it enabled
  when `NODE_ENV=production`, because it is a complete authentication bypass.

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
Enqueueing processing work happens *in the same transaction* as the seal that
triggers it, which removes the dual-write problem rather than mitigating it. No
outbox relay, no CDC pipeline, no window where the state committed but the event
was lost. The cost is that queue throughput is bounded by the database, and at
tens of runs per day that ceiling is nowhere near
([ADR-0004](docs/adr/0004-job-queue-in-postgresql-rather-than-a-dedicated-broker.md)).

**Bytes never pass through Node.** The API is a control plane; it issues
capabilities and verifies results. A 500 GB transfer proxied through an
application process would tie it up for hours and buy nothing
([ADR-0006](docs/adr/0006-presigned-direct-to-storage-upload-bytes-never-transit-the-api.md)).

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

Sealing is the immutability boundary, and it is enforced *by the database*, not
by an `if` statement. A `BEFORE UPDATE` trigger compares `to_jsonb(OLD)` minus
an allow-list against the same projection of `NEW` and raises on any difference.
That fails closed: a column added by a future migration is immutable by default,
and making it mutable requires saying so explicitly
([ADR-0007](docs/adr/0007-immutability-enforced-by-database-trigger-and-grants-not-application-code.md)).

The transition table lives in exactly two places on purpose —
`src/ingestion/run-state-machine.ts` and the trigger in
`migrations/0004_runs.sql`. If they ever disagree the database wins and the
TypeScript is the bug.

### The audit chain

```
hash = SHA256(tenant_id ‖ seq ‖ prev_hash ‖ payload_digest ‖ occurred_at)
```

Four of those five inputs are chosen by the **database**. `append_audit_event()`
takes a row lock on the tenant's chain head, assigns the next sequence number,
stamps `clock_timestamp()`, and computes the hash — so the audited party cannot
pick its own tamper-evidence. Only `payload_digest` comes from the application,
because RFC 8785 canonicalisation in plpgsql is not a maintainable artifact, and
that digest is itself covered by the chain
([ADR-0015](docs/adr/0015-audit-hash-computed-in-the-database-canonicalisation-in-the-application.md)).

The verifier deliberately shares nothing with the appender: the append path
computes the hash in SQL, the verifier recomputes it in TypeScript. A verifier
reusing the appender's implementation can only prove the implementation agrees
with itself.

### Multi-tenancy

Two layers, deliberately redundant. Every request runs inside a transaction that
issues `SET LOCAL ROLE` and `set_config('app.tenant_id', …, true)`. Three
details carry more weight than they look like they do:

- **`SET LOCAL`, not `SET`.** A plain `SET` survives on a pooled connection and
  the next request inherits the previous request's tenant — the precise bug this
  layer exists to prevent, introduced by the code enforcing it.
- **Policies deny by default.** `current_tenant_id()` returns `NULL` when the
  setting is absent, and `tenant_id = NULL` is `NULL`, which RLS treats as false.
- **`FORCE ROW LEVEL SECURITY`, not just `ENABLE`.** Without `FORCE` the table
  owner bypasses its own policies — and migrations run as the owner.

The login role is `NOINHERIT` and holds no privileges of its own, so forgetting
`SET LOCAL ROLE` is an immediate permission error rather than a silent
escalation
([ADR-0016](docs/adr/0016-unprivileged-noinherit-login-role-with-set-local-role-per-transaction.md)).

Full design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

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

GET    /healthz                                 Liveness — never touches dependencies
GET    /readyz                                  Readiness — includes object storage
```

Browsable at `/docs`; the raw document is at `/openapi.json` and `/openapi.yaml`.

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
  migration leaving tenants on divergent versions is caught by nothing.
  *A failure mode you can write a test for beats one you cannot.*

- **[0005 — Hash-chained audit log, not an external ledger](docs/adr/0005-hash-chained-audit-log-in-postgresql-not-an-external-ledger.md)**
  Including an honest statement of the residual risk chaining does not address.

- **[0004 — Job queue in PostgreSQL](docs/adr/0004-job-queue-in-postgresql-rather-than-a-dedicated-broker.md)**
  Redis + BullMQ is the reflexive choice in a Node codebase, and it buys
  throughput this system does not need at the cost of the exact correctness
  property it does. Choosing the more capable tool that reintroduces the bug you
  were avoiding is a bad trade.

- **[0010 — Correction by superseding record](docs/adr/0010-correction-by-superseding-record-never-by-mutation.md)**
  The decision that most shapes the API, and the one that stayed open longest.

Full index and reading map: [`docs/adr/README.md`](docs/adr/README.md).
Requirements and phasing: [`docs/PRD.md`](docs/PRD.md).

### The vocabulary is not decoration

**ALCOA+** — Attributable, Legible, Contemporaneous, Original, Accurate, plus
Complete, Consistent, Enduring, Available — is used as a design checklist. Every
event carries an actor *and a label captured at the time*, so the trail stays
legible after that user is renamed; timestamps are server-side at the moment of
the event; the first-captured artifact is retained alongside every derivative;
nothing is deleted.

**FAIR** — Findable, Accessible, Interoperable, Reusable — frames the query
surface: stable identifiers, searchable metadata, standard schemas, provenance
travelling with the data.

This service is **designed against** GxP / 21 CFR Part 11 principles and could
be validated. It is not validated and does not claim to be — validation is an
organizational process involving qualification protocols and signed evidence,
not a property of code.

---

## Testing

Three tiers, each earning its place.

### Unit — pure, load-bearing logic

RFC 8785 canonicalisation against the specification's own vectors, digest
helpers, UUIDv7 monotonicity across 20,000 ids minted in a single millisecond,
and cursor encoding. Milliseconds, no Docker.

### Integration — against real dependencies

Real PostgreSQL and real MinIO via Testcontainers. Mocked infrastructure would
exercise none of the properties that matter here: row-level security policies,
triggers, grants and presigned multipart uploads do not exist in a mock, and
those are precisely where the guarantees live
([ADR-0012](docs/adr/0012-integration-first-testing-with-testcontainers.md)).

Organised around **guarantees**, not endpoints:

| Suite | Covers |
|---|---|
| `isolation` | unscoped queries under a tenant-scoped role, across every table found in the catalogue; deny-by-default; the worker's bounded cross-tenant privilege; that the login role is powerless before `SET LOCAL ROLE` |
| `immutability` | mutation of a sealed run at every column via a **superuser** connection; the trigger's transition table; frozen manifest bindings; per-tenant dedup; supersede leaving the predecessor byte-identical |
| `audit-chain` | clean chain, mutated payload, deleted middle event, rewritten hash, reordered pair, concurrent appends, checkpoint-anchored verification — and a test asserting what chaining alone does **not** catch |
| `idempotency` | sequential replay, 8 concurrent replays → one row, fingerprint mismatch, key-order-only differences treated as replay, expiry, failure not poisoning the key |
| `derived-artifact-access` | processor outputs reachable through their derivation's source run, and still unreachable cross-tenant |

The immutability and audit suites deliberately attack through the **database
owner**, bypassing RLS and every grant. Through the API they would pass just as
happily with the triggers deleted.

### Browser — the wiring nothing else can see

The viewer has its own Playwright suite, and it earned it. Four defects shipped
that no other layer could catch, because the integration tests call the API
directly and never load a page:

- the viewer posted `{ email }` to an endpoint requiring `tenantSlug`, so
  sign-in failed outright
- the token response nests the principal under `user`, so the greeting silently
  fell back to the email
- chain verification posted an empty body to an endpoint demanding a `studyId` —
  for a chain that is per *tenant*, which was a modelling error in the API
- the run list read `run.study.slug` while the API returned a flat `studyId`, so
  two columns were blank

Every one is wiring rather than logic, and wiring is what a browser test is for.

```bash
npm run test:unit          # 96 tests
npm run test:integration   # 70 tests, needs Docker
npm run test:e2e           # 12 tests, needs a running stack
npm run verify             # format, lint, typecheck, migration lint, unit, integration
```

CI runs the static checks and the integration suite on every push, then brings
the whole stack up from cold, seeds it, runs the browser suite and the narrated
demo against it, and asserts the demo dataset is actually present. The claim
that `docker compose up` works is worth exactly as much as the last time
somebody checked it.

---

## Troubleshooting

**`Bind for 0.0.0.0:3000 failed: port is already allocated`**
Something else holds the port. Override it — see
[Running it locally](#running-it-locally). Container-side ports are unaffected.

**`npm ci` fails in Docker with `Missing: @emnapi/… from lock file`**
npm occasionally writes an incomplete lockfile when a package is added
incrementally. Regenerate it:
`rm -rf node_modules package-lock.json && npm install`.

**The E2E suite fails with a connection error**
It needs a running, seeded stack. `globalSetup` prints which commands to run. If
your stack is on non-default ports, point the suite at it with
`ALIQUOT_E2E_BASE_URL=http://localhost:3100 npm run test:e2e`.

**`npm run dev` starts but every injected dependency is `undefined`**
You are running through `tsx`. Use `npm run build:watch` alongside `npm run dev`
— see [Without containers](#without-containers).

**Uploads fail from your shell but work from the demo**
Presigned URLs are signed for `minio:9000`, which only resolves inside the
compose network. Run the client there: `docker compose run --rm demo`.

**`refusing to start: row-level security would not be enforced`**
`DATABASE_URL` points at a superuser or a `BYPASSRLS` role. Use the unprivileged
login role that `scripts/migrate.ts` creates. This check is deliberate: a
privileged role disables isolation while every test still passes.

---

## Deployment

Live at <https://aliquot.youneskaouani.dev>. One VPS, Docker Compose, Caddy
terminating TLS with certificates it renews itself, images from GHCR, deploys
from GitHub Actions behind an approval gate.

```
deploy/
  bootstrap.sh              one-time host prep: docker, firewall, ssh, backups
  docker-compose.prod.yml   the production stack
  Caddyfile                 TLS, security headers, edge blocks
  deploy.sh                 migrate-then-switch, with a rollback path
  backup.sh                 nightly dumps, verified readable
  restore.sh                destructive, and says so twice
  aliquot.env.example       every secret, documented
```

Three properties worth stating:

- **Migrations run to completion before any new container serves traffic**, and
  the deploy aborts if they fail. A bad migration never leaves half the stack on
  a schema the rest does not have.
- **Only Caddy publishes a host port.** Postgres and MinIO are reachable only on
  the internal network, so the externally reachable surface is one TLS listener.
- **The dev token endpoint is unreachable three times over** — the service
  refuses to boot with it enabled in production, the compose file hard-codes it
  off, and Caddy 404s the route. The deploy workflow asserts that 404 from the
  public internet after every release, because three layers you never check is
  one layer you are guessing about.

Public access is a read-only demo session: no request body, one pre-seeded
account, and every mutating verb refused by a guard rather than by a role check
([ADR-0020](docs/adr/0020-read-only-demo-access-for-a-public-deployment.md)).

Full runbook, including rollback, restore, storage options and an honest list of
what this deployment is *not*: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## What I would do differently at scale

Stated explicitly, because knowing where a design breaks is more convincing than
pretending it does not.

- **The queue in Postgres** is right at tens of runs per day and wrong at
  thousands per minute. The migration path is a real broker behind the same
  `JobQueue` interface, keeping transactional handoff via an outbox relay. The
  interface exists so that is one module rather than a restructure.
- **Full chain verification is O(n)** and gets slow as history grows. Segment it
  into epochs starting from the last externally-corroborated checkpoint. The
  checkpoint table already exists; no schema change needed.
- **Lineage traversal is a recursive CTE** — fine to a few thousand nodes, then
  it needs a materialized closure. I would materialize before reaching for a
  second database.
- **Audit table growth** — partition by tenant and month. The composite primary
  key `(tenant_id, seq)` is already ordered to make that a non-event.
- **Re-hashing every uploaded byte** is the dominant cost of ingest at hundreds
  of GB per artifact. The alternative is trusting the declared digest, which is
  cheaper and makes the integrity guarantee unfalsifiable. If it became the
  bottleneck I would move the hash into the storage tier rather than drop it.
- **Digest computation on the client** remains a trust assumption about the
  producer, not the transport. Closing it means generating the digest at
  acquisition time, which means an agent on the instrument.

### Known gaps

Byte-flip injection and resume-after-interruption against MinIO, and worker
crash, redelivery and dead-lettering, are exercised end to end by
`scripts/seed.ts` and `scripts/demo.ts` but do not yet have dedicated suites. A
script that exits non-zero is real evidence and weaker evidence than a test.
These are the next tests to write.

---

## Project layout

```
docs/
  PRD.md              requirements, acceptance criteria, phasing
  ARCHITECTURE.md     components, data model, flows, failure modes
  DEMO.md             the walkthrough by hand, with curl
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
  viewer/             read-only static UI, no build step
test/
  unit/               pure logic, exhaustively
  integration/        guarantees, against real dependencies
  e2e/                the viewer, in a browser
scripts/              migrate, seed, demo, migration lint
```

The migrations carry a lot of the reasoning. If you read one thing before the
code, read [`migrations/0003_audit_chain.sql`](migrations/0003_audit_chain.sql)
and [`migrations/0004_runs.sql`](migrations/0004_runs.sql).

---

## Licence

MIT. See [LICENSE](LICENSE).
