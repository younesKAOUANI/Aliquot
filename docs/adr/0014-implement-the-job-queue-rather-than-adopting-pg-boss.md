# ADR-0014: Implement the job queue rather than adopting pg-boss

**Status:** Accepted
**Date:** 2026-07-04
**Deciders:** Younes Kaouani

## Context

ADR-004 decided the queue lives in PostgreSQL so that enqueueing and the state change
that justifies it commit together. `RunService.sealWithin()` is the only producer today:
it flips the run to `SEALED`, enqueues the processing job and appends the audit event in
one transaction. That decides *where* the queue lives. It does not decide *who writes it*.

pg-boss is the obvious candidate — a mature PostgreSQL-backed queue for Node with far
more production hours behind its claim loop than anything written here will have.
`CLAUDE.md` §5 also says not to add a dependency without justifying it, and that
something under ~200 lines and load-bearing should be written, owned and tested. Both
positions are defensible, so this had to be argued rather than defaulted into.

What makes it more than a generic build-versus-buy question:

- Every tenant-scoped table carries `ENABLE`/`FORCE ROW LEVEL SECURITY` and a policy in
  the migration that creates it (ADR-002); `scripts/lint-migrations.ts` fails CI on any
  table with a `tenant_id` column and no policy.
- The service connects as an unprivileged `NOINHERIT` login role and `SET LOCAL ROLE`s
  into `aliquot_app` or `aliquot_worker` per transaction (ADR-016);
  `assertLeastPrivilege()` refuses to start if either is a superuser or holds `BYPASSRLS`.
- Migrations are plain forward-only `.sql` that we own and never edit after merge.

Getting it wrong has two shapes. Write it badly and a claim or lease bug duplicates or
strands work — redelivery is not an edge case here, it is the retry mechanism. Adopt
badly and part of the schema sits outside the isolation model, governed by migrations
that arrive with a package upgrade.

## Decision

The queue is implemented here: `aliquot.job` with `aliquot.claim_jobs()` and
`aliquot.release_job()` in `migrations/0007_jobs.sql`, plus a thin client
(`PostgresJobQueue`) and poll loop (`WorkerRuntime`). pg-boss was rejected not because it
cannot do the job — it can, including transactional enqueue — but because its schema is
not ours to govern, and this system's isolation guarantee is a property of the schema.

## Options considered

### Option A: Adopt pg-boss

| Dimension | Assessment |
|---|---|
| Complexity | Low to write, moderate to operate |
| Transactional enqueue | Supported: `send(name, data, { db })` with a caller-supplied `executeSql`; adapters ship for Kysely |
| Tenant isolation | Its job table has no `tenant_id` and no policy |
| Schema ownership | Creates and migrates a `pgboss` schema at `start()` unless `migrate: false` |
| Upgrade exposure | The v10-to-v11 partitioning change is documented as not automatically migratable |
| Features acquired | Cron scheduling, archive and retention, dead-letter queues, throttling, expired-fetch maintenance |

**Pros:** every mechanism is somebody else's tested code — backoff, lease expiry,
dead-lettering, dedupe via `singletonKey` — plus scheduling and archiving we do not have
and would eventually want. Its claim loop has been wrong in production and fixed; ours has
not been wrong in production because it has not been in production.

**Cons:** the isolation model stops being uniform. `pgboss.job` would be the one table
holding tenant-identifying payloads with no policy over it, in a schema whose DDL is
emitted by a package and whose grants sit on objects its migrations recreate. The
asymmetry migration 0007 exists to express — API confined to its own tenant, worker able
to see the queue across tenants and nothing else — has no expression there.

### Option B: Implement the queue (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | 92 non-comment lines of SQL: one table, four indexes, two functions, two policies |
| Transactional enqueue | A plain Kysely insert on the caller's `Trx` |
| Tenant isolation | House rules, plus a second deliberate policy |
| Schema ownership | Ours, forward-only, reviewed like everything else |
| Features acquired | None beyond claim, lease, backoff, dedupe, dead-letter |

**Pros:** `enqueue()` takes the caller's transaction because it is an insert, with
`ON CONFLICT ... DO NOTHING` on the partial index `job_dedupe_idx`, so a replayed seal
resolves to "already scheduled" rather than an error. The two policies —
`tenant_isolation` for `aliquot_app`, `worker_claims_across_tenants` for `aliquot_worker`
— bound cross-tenant visibility to one table instead of granting `BYPASSRLS`, and
`test/integration/isolation.spec.ts` proves both halves: the worker sees jobs from two
tenants and still counts zero foreign rows on `aliquot.run`.

**Cons:** retry semantics, the backoff ceiling, lease reclamation and the fencing on
`claimed_by` are ours to get right and ours to fix. No cron, no archiving, no retention,
no dashboard; `aliquot.job` grows without bound today. The poll loop in
`worker.runtime.ts` is another 300 lines doing work a library does.

### Option C: Outbox here, pg-boss as the delivery mechanism

| Dimension | Assessment |
|---|---|
| Complexity | Highest: two queues, a relay process, two failure models |
| Transactional enqueue | Preserved by the outbox |
| Delivery | At-least-once with visible relay lag instead of synchronous |
| Features acquired | pg-boss's scheduling and archiving, consumer side only |

**Pros:** keeps the ADR-004 guarantee while acquiring pg-boss's operational features, and
is the documented shape of the eventual broker migration in `src/processing/job-queue.ts`.

**Cons:** the outbox table and the loop draining it are Option B's cost paid in full, plus
a dependency and a relay, for throughput headroom we do not need.

## Trade-off analysis

Option A was hardest to argue against, and the usual objection to it is wrong. "You
cannot enqueue inside your own transaction" is the reflexive criticism of pg-boss and it
does not hold: the `db` option accepts a caller-supplied executor. Rejecting it on that
basis would have been rejecting it on a fact that stopped being true two major versions ago.

What lost it is schema ownership. Isolation here is not application code; it is
`FORCE ROW LEVEL SECURITY`, explicit grants, and a startup assertion that the credentials
cannot bypass either. Adopting pg-boss means one schema where that is not true: tenant
identifiers in an opaque payload column, our grants over DDL that is not ours, and a
major-version upgrade that rewrites the tables underneath them. The exposure is bounded —
the payload is a run id, and reading it requires already holding `aliquot_app` or
`aliquot_worker` — but "every tenant-scoped table has a policy, and CI proves it" would
stop being true, and that sentence is most of what this service sells.

Where the chosen option is weaker: pg-boss's maintenance would have solved retention and
we have not. The cleverest statement in the system is now ours — `claim_jobs()` reclaims
expired leases in the same statement that claims new work, with `attempts` already
incremented, so a job that reliably kills its worker walks its budget down to `DEAD`
instead of looping forever. Clever concurrency is where bugs live. The residual risk sits
there and in the `claimed_by` fencing in `complete()` and `fail()`, and neither has a
dedicated test yet, which is the largest honest gap here.

pg-boss would be the better call under conditions that are not hypothetical: if scheduled
work entered the roadmap, if a producer outside this codebase needed to enqueue, or if
this were a team rather than one maintainer. A project without the row-level security
constraint has essentially no argument for writing this by hand.

## Consequences

**Easier:** enqueue is a plain insert on the caller's transaction, so no producer can
create a dual write. The queue obeys the same isolation rules as everything else — same
tests, same lint, one story to explain — and reads end to end in one migration and two
source files.

**Harder:** retry semantics, backoff, leases and dead-lettering are a permanent
maintenance obligation, and scheduling or archiving is now a feature request against this
repository. Nothing prunes `COMPLETED` or `DEAD` rows; the ready-set indexes are partial
so history does not slow the hot path, which is a mitigation, not a fix.

**To revisit:** if scheduled or recurring work becomes a requirement; if a producer
outside this codebase needs to enqueue; if retention turns into an implementation project
rather than one scheduled `DELETE`; or if a bug in `claim_jobs()` or the lease fencing
reaches production, which is direct evidence this trade was mispriced.

## Action items

1. [x] `migrations/0007_jobs.sql`: `aliquot.job`, the claim and lease indexes,
   `claim_jobs()`, `release_job()`, both policies, explicit grants, `DELETE` revoked.
2. [x] `job` recorded in the `EXEMPT` map of `scripts/lint-migrations.ts` with its reason,
   so the exemption is a conscious act rather than an omission.
3. [x] `JobQueue.enqueue()` takes the caller's `Trx`; dedupe via `job_dedupe_idx`, where a
   conflict returns `null` rather than raising.
4. [x] `complete()` and `fail()` fenced on `claimed_by`; `renewLease()` extends a lease at
   a third of its duration from `WorkerRuntime`.
5. [x] Worker-role isolation covered in `test/integration/isolation.spec.ts`: cross-tenant
   on `aliquot.job`, tenant-scoped on `aliquot.run`, nothing visible without a tenant set.
6. [x] Correlation id carried across the queue boundary via `CORRELATION_PAYLOAD_KEY`.
7. [ ] Integration suite for the queue guarantees themselves: `SKIP LOCKED` never hands
   one job to two workers, an expired lease is reclaimed with `attempts` incremented, the
   budget terminates at `DEAD` with `last_error` retained, and a lost lease makes
   `complete()` return false.
8. [ ] Retention for `aliquot.job`: decide whether `COMPLETED` rows are deleted or moved,
   and write the migration. This is what pg-boss would have supplied.
9. [ ] Expose queue depth, oldest `PENDING` age and `DEAD` count for alerting. Without
   them a queue that stops draining is invisible until someone asks why a run is stuck.
