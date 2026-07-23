# ADR-0012: Integration-first testing with Testcontainers

**Status:** Accepted
**Date:** 2026-07-23
**Deciders:** Younes Kaouani

## Context

Every guarantee this service makes has been pushed below the application on
purpose: tenant isolation into policies from `aliquot.apply_tenant_rls()`
(ADR-0002), immutability into `aliquot.enforce_run_immutability()` and a `revoke
delete` (ADR-0007), tamper evidence into a hash computed inside
`aliquot.append_audit_event()` (ADR-0015), exactly-once ingestion into a unique
constraint (ADR-0001), byte integrity into a presigned multipart upload re-read
and re-hashed on completion (ADR-0006).

None of that exists in process. A mocked repository returns what the test told it
to return, so it cannot fail to filter by tenant. A fake object store cannot
reject a 3 MiB non-final part. A stubbed query builder cannot raise
`integrity_constraint_violation` from a trigger. Mocking here yields a green suite
asserting the application asked for the right things, while the layer that
enforces the guarantees never runs.

What breaks if this is got wrong is quiet. A migration that forgets `force row
level security` leaves a tenant-scoped table readable across tenants. A view
declared without `security_invoker` evaluates policies as its owner and undoes
the isolation beneath it. Those are the two likeliest mistakes in this schema and
neither has a symptom other than a leak.

Constraints: one engineer, a NestJS stack where mock-heavy unit testing is the
default habit, and a repository meant to be runnable by a reviewer who clones it
once.

## Decision

Tests run against a real PostgreSQL and a real MinIO started by Testcontainers,
organised around the five guarantees rather than around endpoints. Unit tests are
reserved for pure logic with no database in it: the run transition table, RFC
8785 canonicalisation, digest helpers, part planning, cursor encoding.

## Options considered

### Option A: Mocked repositories and an in-process Postgres substitute (pg-mem)

| Dimension | Assessment |
|---|---|
| Complexity | Low to write, high to keep honest |
| Exercises RLS, triggers, grants | No |
| Wall-clock | Milliseconds; no Docker |
| Fidelity | Tests the application's intent, not the system's behaviour |

**Pros:** Fast enough to run on save, runnable by anyone, and trivial to construct
a specific state — a sealed run, a corrupt chain — without going through the API.

**Cons:** Every assertion worth making is unreachable. pg-mem has no row-level
security, no `set local role`, no plpgsql triggers and no `for update skip
locked`, so `aliquot.claim_jobs()`, `aliquot.append_audit_event()` and
`aliquot.enforce_run_immutability()` cannot run at all. The suite would assert
that `RunService` sets `app.tenant_id`. That is not the claim; the claim is that
isolation holds when the application forgets to.

### Option B: A shared, externally managed database and object store

| Dimension | Assessment |
|---|---|
| Complexity | Low in test code, moved into the environment |
| Exercises RLS, triggers, grants | Yes, fully |
| Wall-clock | Fastest real-dependency option — no container start |
| Setup to run | `docker compose up -d postgres minio`, or CI `services:` |
| Fidelity | High until the environment drifts |

**Pros:** Everything Option A cannot reach is reachable, at no per-run startup
cost. It is what a developer already has running.

**Cons:** The long-lived database breaks two things. Migrations become a no-op
after the first run, so `scripts/migrate.ts` — which `docker compose up` depends
on, and therefore the first thing a reviewer executes — is never exercised; a
broken runner shows green. And dependency versions live on somebody's machine
rather than in the repository, so a policy behaving differently across major
versions is found by one person and not the other.

### Option C: Real dependencies started per run by Testcontainers

| Dimension | Assessment |
|---|---|
| Complexity | Moderate: one `globalSetup`, two support modules |
| Exercises RLS, triggers, grants | Yes, fully |
| Wall-clock | Startup amortised once, then real I/O per assertion |
| Setup to run | Docker |
| Fidelity | High, and pinned in version control |

**Pros:** Image tags live in `test/integration/global-setup.ts`
(`postgres:17-alpine`, `minio/minio:RELEASE.2025-04-22T22-12-26Z`), so the
environment is reviewable. The database starts empty, so `global-setup.ts` must
shell out to `scripts/migrate.ts` — putting the runner under test as much as the
schema.

**Cons:** Docker becomes a hard requirement, and the suite stays slower than any
mock-based alternative. Sharing one database lets non-tenant-scoped global state
— sequences, the globally unique `instrument.api_key_prefix` — couple suites
together.

## Trade-off analysis

Option A was never close. It fails the rule that a test which would still pass
with the feature deleted is not a test: delete every policy `apply_tenant_rls()`
creates and a mock-based suite is unchanged.

Option B was the hard one, and it is not much worse: same Postgres, same MinIO,
same policies, triggers and grants, and faster, because container startup
disappears. What decided it was not fidelity but what the suite is allowed to
assume. Testcontainers hands the run an empty database, so migrations are applied
by the real runner and a regression in `scripts/migrate.ts` fails the integration
job. Under Option B the schema is already there, migration is skipped, and the
failure surfaces to a reviewer running `docker compose up` — the worst possible
place. Pinned image tags were the second argument and would not have sufficed
alone.

Option C is weaker in three places, and all three are permanent. It is slower,
and slower suites get run less; `fileParallelism: false` in `vitest.config.mts`
serialises the integration project, so wall-clock grows linearly with suite
files. Containers are shared rather than per-file, so suites isolate by creating
their own tenants through `createTenant()` and the database is never emptied —
defensible, since production is never empty either, but a suite can be
contaminated by another's rows and the symptom is a flake. And MinIO is
S3-compatible, not S3: a presigned multipart upload it accepts can still be
rejected by AWS over checksum negotiation or part-size validation timing.

One guardrail is worth naming. `support/database.ts` exposes `appDb()` — the
unprivileged `aliquot_login` role, subject to RLS — alongside `adminDb()`, the
superuser needed to simulate an insider rewriting audited history, which is the
one thing no mock has an equivalent of. `adminDb()` is also the fastest way to
stop testing anything, so `testDatabase()` in `support/services.ts` repeats the
least-privilege assertion the service makes at startup and fails loudly if the
harness is ever handed a privileged connection.

Unit tests keep a narrow role: properties total over a small domain, with no I/O.
Exhausting `RUN_TRANSITIONS` in `src/ingestion/run-state-machine.ts` costs
milliseconds where the same coverage through the database costs seconds per case.
Likewise `canonicalize()` against RFC 8785's own vectors — which is what makes it
agree with other implementations rather than merely with itself.

## Consequences

**Easier:** Claims about the schema become checkable.
`test/integration/isolation.spec.ts` drives its assertions from
`tenantScopedTables()`, which reads `pg_class` and `pg_attribute`, so a table
added by a future migration is covered the moment it exists; a hard-coded list
would pass forever while silently not testing the newest table. And the audit
suite can state the mechanism's limit honestly — `does NOT detect a rewrite that
also recomputes every following hash` — because it holds a connection privileged
enough to perform that rewrite.

**Harder:** Docker is required for `npm run test:integration` and `npm run verify`;
without it only `npm run test:unit` runs. CI is split into `static` and
`integration` jobs so a formatting mistake reports in under a minute rather than
after containers start — two jobs to maintain instead of one.
`TESTCONTAINERS_RYUK_DISABLED: 'true'` trades container reaping for startup time:
safe on ephemeral GitHub runners, a leak on a self-hosted one. A failure means
distinguishing the schema from the harness from the container from the code.

**To revisit:** If integration wall-clock passes roughly five minutes, drop
`fileParallelism: false` for per-worker databases created from a template rather
than abandoning real dependencies. If a presigned-upload defect reaches
production that MinIO accepted, add a nightly job against real S3 rather than
replacing MinIO in the fast path.

## Action items

1. - [x] Two independently runnable Vitest projects in `vitest.config.mts`; `npm test` defaults to unit.
2. - [x] `global-setup.ts` starts one pinned PostgreSQL and one pinned MinIO per run, with `fsync=off`.
3. - [x] Migrations applied in `globalSetup` by executing `scripts/migrate.ts`, so the runner is under test.
4. - [x] `support/database.ts` separates `appDb()` from `adminDb()`; `asTenant()` reproduces the service's `set local role` and `set_config('app.tenant_id', …)`.
5. - [x] `createTenant()` per suite; no teardown between suites.
6. - [x] `tenantScopedTables()` reads the catalogue, so new tables are covered automatically.
7. - [x] Suites for G4 (`audit-chain.spec.ts`), G5 (`isolation.spec.ts`), immutability.
8. - [x] Unit suites for canonicalisation, digests, UUIDv7, cursors.
9. - [x] CI split into `static` and `integration`, plus a `compose` job.
10. - [ ] `test/unit/run-state-machine.spec.ts`: exhaust `RUN_TRANSITIONS`, assert containment against `DATABASE_ENFORCED_TRANSITIONS`.
11. - [ ] `test/unit/part-plan.spec.ts` at the `MIN_PART_SIZE_BYTES` and `MAX_PARTS` boundaries.
12. - [ ] Remaining suites: `idempotency` (G1), `integrity` (G2), `lineage` (G3), `processing`.
13. - [ ] Record integration wall-clock in CI, so the revisit condition is observable.
14. - [ ] Document the MinIO-is-not-S3 divergence in `docs/ARCHITECTURE.md`.
