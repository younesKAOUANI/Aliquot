# ADR-0004: Job queue in PostgreSQL rather than a dedicated broker

**Status:** Accepted
**Date:** 2026-07-04
**Deciders:** Younes Kaouani

## Context

Sealing a run is where the system takes on an obligation: a seal asserts every
declared artifact is uploaded and verified, and implies that processing will
happen. The seal is a database transaction; the processing is asynchronous work
somewhere else. Two writes, and the question is what happens when only one lands.

If the state change commits and the work is never scheduled, the run sits
`SEALED` with no job, forever, and nothing reports an error: no exception, no
failed request, no retry. It is discovered when a scientist asks where their
results are. If the work is scheduled and the seal rolls back, a worker claims a
job for a run still `OPEN` and fails on a state no retry can fix.

Constraints. PostgreSQL is already a hard dependency doing two other jobs:
domain state and the hash-chained audit log, with tenant isolation enforced
below the application by RLS (ADR-0002). The load is tens of runs per day per
tenant, and the team is one person, who also operates whatever infrastructure
exists. What breaks if this is got wrong is the quietest of the five guarantees:
work promised and silently never done, behind an audit trail saying the run
sealed successfully.

## Decision

The job queue is a PostgreSQL table, `aliquot.job` (`migrations/0007_jobs.sql`),
claimed with `FOR UPDATE SKIP LOCKED` inside `aliquot.claim_jobs()`. The
producer API is `JobQueue.enqueue(trx, ctx, request)` — it takes the caller's
transaction, so a job and the state change that justifies it commit together or
neither commits.

## Options considered

### Option A: Queue table in PostgreSQL (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | One table, two SQL functions, one poll loop. No new infrastructure. |
| Enqueue semantics | Transactional. The dual-write failure mode does not exist to be mitigated. |
| Throughput | One table's write rate. Orders of magnitude above need. |
| Tenant isolation | RLS policies, like every other table. |

**Pros:** `enqueue` runs inside `RunService.sealWithin()`'s transaction, so the
window between seal and schedule is not narrowed, it is absent. Dedup is the
partial unique index `job_dedupe_idx`, so a replayed seal enqueues once.

**Cons:** Polling, so latency has a floor of `WORKER_POLL_INTERVAL_MS`. Claim
and completion are both UPDATEs, so queue volume produces WAL and dead tuples in
the instance that serves run listings. No management UI, no fairness.

### Option B: Redis + BullMQ

| Dimension | Assessment |
|---|---|
| Complexity | Least code to write; a second datastore to run, back up, and secure. |
| Enqueue semantics | Non-transactional. `add()` cannot join a Postgres transaction. |
| Throughput | Far above anything this system produces. Push-based, no poll floor. |
| Tenant isolation | None below the application; `tenantId` becomes a trusted payload field. |

**Pros:** The reflexive Node choice, for real reasons. Mature retry policies,
delayed jobs, concurrency control, rate limiting, a dashboard — all things
Option A had to be written for. Keeps queue traffic off the database.

**Cons:** It reintroduces the exact bug being avoided. `add()` before the commit
lets a worker claim a job for a seal that has not committed, or never will;
`add()` after it means a process death in between leaves a `SEALED` run nothing
will ever process, silently. The standard repair is a reconciliation sweep —
find `SEALED` runs with no job older than N minutes — which is a second
scheduler, a second correctness argument, and a Postgres query anyway. Redis
durability is also weaker than the store holding the state it refers to: AOF at
`everysec` can lose a second of acknowledged writes on a hard kill. And BullMQ
has no notion of RLS, so tenant scoping moves from a policy into an `if`.

### Option C: Transactional outbox + broker relay

| Dimension | Assessment |
|---|---|
| Complexity | Highest: outbox table, relay process, broker, and the lag between them. |
| Enqueue semantics | Transactional at the producer; at-least-once with lag downstream. |
| Throughput | Broker-bound. Supports fan-out to consumers that do not exist yet. |
| Tenant isolation | Policy-enforced on the outbox; application-enforced past the relay. |

**Pros:** Keeps transactional enqueue *and* gets broker throughput and fan-out.
The correct design at 100x this volume, and where this decision goes when it is
reopened.

**Cons:** Three moving parts serving a load one table handles, and a relay that
can stall while everything reports healthy. Note the shape: the outbox table
*is* Option A's `job` table with a relay in front. C is a superset, not a
different direction.

## Trade-off analysis

The hardest option to argue against was C, not B.

B is the one people expect, so it got the closer look, but it loses on the one
property this decision is about. It cannot share a transaction, and the claim
that a reconciliation sweep closes the gap is a claim that a slower, less
reliable reimplementation of a transaction is good enough. Its throughput case
was checked rather than assumed: `SKIP LOCKED` against `job_claimable_idx`,
partial over `PENDING` only, is far past tens of runs per day. Its ergonomics
case is narrower than it looks — backoff, dead-lettering, lease recovery and
dedup came to roughly two hundred lines, under the threshold in CLAUDE.md for
writing it and owning it. (Adopting `pg-boss` instead is ADR-0014.)

C keeps the deciding property and beats A on everything except effort. It lost
on the ratio of moving parts to demonstrated need, and on a structural point:
because A's table is C's outbox, choosing A now is not a wrong turn to be undone
— the relay is added, not substituted. That is why `src/processing/job-queue.ts`
abstracts only the producer side. `enqueue(trx, ...)` is the seam because that is
where the guarantee lives; `claim`, `complete` and `fail` are concrete on
`PostgresJobQueue`, since a broker replaces the delivery loop wholesale.

Where the chosen option is weaker:

- **The queue competes with the domain for one instance.** Claim and completion
  each write the row, so a vacuum problem on `aliquot.job` becomes a latency
  problem for run listing. Only volume protects this today.
- **`attempts` is a budget for deliveries, not failures.** `claim_jobs()`
  increments on claim, which is what stops a job that kills its worker from
  looping forever — but an OOM kill or a rolling deploy spends attempts against
  work that never ran.
- **The worker's cross-tenant read is a real widening.**
  `worker_claims_across_tenants` is a policy whose `USING` clause is `true`. It
  reaches one table rather than being `BYPASSRLS` on the role, and everything
  after the claim is scoped by `app.tenant_id` from the claimed row — but that
  scoping is established in `RunProcessorJob.handle()` via
  `systemContext(job.tenantId, ...)`: application code enforcing what this
  system otherwise pushes into the database.
- **No fairness.** One tenant sealing ten thousand runs starves `run.process`.

## Consequences

**Easier:** Seal-to-schedule is one commit, which is why ARCHITECTURE.md records
"API crashes between seal and enqueue" as *impossible* rather than mitigated.
Replayed seals converge: `dedupeKey: run:${runId}` hits the partial unique index
and `enqueue` returns `null` for "already scheduled", which is success. Queue
state is visible to `psql` during an incident and lands in the same backup as
the data it refers to. Tests need no broker container beyond the Postgres one
ADR-0012 already requires.

**Harder:** Latency has a floor of one poll interval; `LISTEN/NOTIFY` would
remove it but does not survive a dropped connection, so it would be an
optimisation carrying its own correctness caveat. Queue writes land on the
primary. Retry semantics are ours to maintain — a mistake in
`aliquot.release_job()` is a mistake in a stored function nobody watches.

**To revisit:** Reopen when sustained enqueue exceeds roughly 50 jobs/second, or
`aliquot.job` holds more than a few million live rows, or p99 claim latency
approaches the poll interval, or `job` starts dominating autovacuum. Also reopen
on a requirement change: fan-out to more than one consumer per event, sub-second
latency, or a second service consuming Aliquot events. The move is to Option C —
keep `enqueue(trx, ...)`, add a relay — not to B.

## Action items

1. [x] `aliquot.job` in `migrations/0007_jobs.sql`, with `job_dedupe_idx`,
   `job_claimable_idx` and `job_lease_idx` each partial over the state it is
   scanned in.
2. [x] `aliquot.claim_jobs()` using `FOR UPDATE SKIP LOCKED`, reclaiming expired
   leases in the same statement as new work.
3. [x] `aliquot.release_job()` applying exponential backoff to a ceiling, moving
   to `DEAD` with `last_error` retained.
4. [x] `JobQueue.enqueue(trx, ctx, request)` takes the caller's transaction;
   only the producer side is abstract.
5. [x] `RunService.sealWithin()` enqueues in the sealing transaction with
   `dedupeKey: run:${runId}`, recording the job id on the `run.sealed` event.
6. [x] Two policies on `aliquot.job`: `tenant_isolation` for `aliquot_app`,
   `worker_claims_across_tenants` for `aliquot_worker` — this table only.
7. [x] Lease renewal in `WorkerRuntime.startLeaseRenewal()`, completion fenced
   on `claimed_by`, and the correlation id carried across the boundary under
   `CORRELATION_PAYLOAD_KEY`.
8. [x] The queue name declared once, in `run-processor.job.ts`, and imported by
   the producer. Producer and consumer disagreeing about it would not fail — the
   run would sit `SEALED` and the job `PENDING`.
9. [ ] Integration suite for the queue guarantee; `test/integration/` has none
   today. Four cases: enqueue rolls back with a failed seal; N concurrent
   workers claim disjoint sets; an expired lease is reclaimed with `attempts`
   incremented; budget exhaustion lands in `DEAD` with `last_error` intact.
10. [ ] Expose queue depth and age of the oldest `PENDING` job on the health
    surface. A stopped worker is invisible until someone asks about a run.
11. [ ] A dead-letter inspection path that is not raw SQL.
12. [ ] Benchmark the claim path so the threshold above is a measurement.
