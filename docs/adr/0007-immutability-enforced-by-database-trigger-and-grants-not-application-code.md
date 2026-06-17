# ADR-0007: Immutability enforced by database trigger and grants, not application code

**Status:** Accepted
**Date:** 2026-06-17
**Deciders:** Younes Kaouani

## Context

Sealing a run is the moment the service starts making a claim to the outside world: these
bytes, under these digests, from this instrument, by this operator. A paper cites the run id.
Correction is by superseding record rather than mutation (ADR-0010), which means nothing
unless the superseded record genuinely cannot move.

The question is not whether sealed runs are immutable — the PRD settled that — but *where*
that is enforced. The obvious place is `RunService`: read the state, refuse. It is where a
reviewer expects to find it and where the error messages are best. It is also where the rule
fails quietly:

- A second write path. `UploadService` writes `run_artifact`, `RunProcessorJob` writes
  processing columns, `RunService.quarantine` writes both. Each is a place to add an `UPDATE`
  that does not pass the guard.
- A backfill. `migrations/` and `scripts/` run as the database owner, a superuser. "Fix a typo
  in `protocol` across nine hundred runs" sounds reasonable and would silently invalidate
  every citation downstream of it.
- A refactor. A guard clause is deleted by whoever decides the method does too much, and no
  test that goes through the API notices.

Get this wrong and the audit chain (ADR-0005) records requests rather than state.

## Decision

Immutability of sealed runs, frozen manifest bindings, content-addressed artifacts and the
audit tables is enforced by `BEFORE` row triggers and by privileges the application role does
not hold, not by checks in service code. Application-level checks remain, but only to produce
a better error before the database produces a correct one.

## Options considered

### Option A: Application-layer enforcement in the service

| Dimension | Assessment |
|---|---|
| Complexity | Lowest: a guard clause and a transition table |
| Bypass surface | Every other write path, script, and future endpoint |
| On schema change | Fails open: a new column is unguarded until someone remembers |
| Testability | Tests pass identically with the guard deleted |

**Pros:** Errors are excellent — `IllegalTransitionError` names the run, origin and target.
One readable file, exhaustively unit-testable, no procedural SQL.

**Cons:** Enforcement by convention, holding only as long as every writer remembers, and the
set of writers grows. It offers nothing against the owner-privileged paths, which is where a
well-meaning corruption comes from.

### Option B: Database trigger plus revoked grants

| Dimension | Assessment |
|---|---|
| Complexity | Moderate: plpgsql that cannot be stepped through |
| Bypass surface | `DROP TRIGGER`, `DISABLE TRIGGER`, `TRUNCATE`. Nothing else |
| On schema change | Fails closed, if the diff is written as an allow-list |
| Cost per write | `to_jsonb` of the whole row, twice, per updated row |
| Testability | Testable from outside the application, as the owner |

**Pros:** The guarantee is a property of the data, not of the code in front of it. `revoke
delete, truncate on aliquot.run` means no code path can delete a run, because the privilege
does not exist; `reject_audit_mutation()` means a role that *was* granted `UPDATE` on
`audit_event` still cannot use it. Grants stop the application, the trigger stops the rest.

**Cons:** Logic in two languages — `src/ingestion/run-state-machine.ts` and
`enforce_run_immutability()` — which can drift. Errors arrive as SQLSTATE 23000 with a message
written in plpgsql, and the trigger is invisible to anyone reading only the TypeScript.

### Option C: Structural immutability — split the mutable columns out

Revoke `UPDATE` on `aliquot.run` and move `state` plus the four `processing_*` columns to a
mutable `run_processing` table.

| Dimension | Assessment |
|---|---|
| Complexity | Low in the schema, high in every read |
| Bypass surface | None: immutability follows from an absent privilege |
| On schema change | Fails closed absolutely; a new column is immutable by construction |
| Cost per write | Zero. Nothing runs |

**Pros:** The strongest available form of the guarantee and the cheapest at runtime. No
procedural code to get wrong, no allow-list, no way to be partially right. "This table is
never updated" is verifiable with one `has_table_privilege` query.

**Cons:** Every run read becomes a join, and `run_search_idx` on
`(tenant_id, study_id, state, acquired_at desc, id desc)` cannot exist — study plus state plus
acquisition window, on an `(acquired_at, id)` cursor, is the query the scientist persona
issues. It also fails to remove the procedural code it was meant to: whether a manifest
binding is frozen is a statement about the parent run's state, so
`enforce_run_artifact_immutability()` survives regardless.

## Trade-off analysis

Option C was hardest to argue against and came closest to winning. It is a strictly stronger
guarantee than the one chosen, not a differently-shaped one. It lost on two counts: it buys
absolutism for the `run` row and pays with a join the search index cannot serve, and it does
not eliminate triggers anyway. Given that plpgsql was going to exist regardless, "no triggers
on `run`" did not justify reshaping the read model around it.

Option A survives as a layer, not as the mechanism. `assertTransition()` runs on every service
path and `lockRun()` takes `FOR UPDATE`, so two concurrent seals serialise and the loser gets
`IllegalTransitionError` rather than a trigger message describing a symptom. When the two
disagree the database is right and the TypeScript is the bug, as stated at the top of
`run-state-machine.ts`.

What makes Option B tolerable is the diff:

```sql
if (to_jsonb(old) - v_mutable) <> (to_jsonb(new) - v_mutable) then
```

Written column by column — `if old.study_id is distinct from new.study_id or …` — a column
added by migration 0009 is not mentioned, so it is mutable with no symptom until someone
mutates it. Written as a projection minus an allow-list, that column appears on both sides of
the comparison, so any change to it is a difference and it is frozen from the moment it
exists. Making it mutable means editing `v_mutable` in a new migration and asserting in
writing that the column is not part of what the run *is*. The failure mode flips from silent
permissiveness to a loud rejection a test will catch.

The state machine duplicated inside the trigger is defence in depth of the same kind. The
trigger returns early for `OPEN` rows, so out of `OPEN` the TypeScript table is the only
definition; out of every other state it enumerates exactly four transitions, transcribed
verbatim into `DATABASE_ENFORCED_TRANSITIONS` from the SQL rather than derived from
`RUN_TRANSITIONS`, so containment is checkable rather than asserted in a comment.
`QUARANTINED` and `ABANDONED` are stronger again: every update is rejected, including a no-op,
which is why `RunProcessorJob.recordFailure()` guards on `PROCESSING` first.

Residual risk, plainly. The owner can `DROP TRIGGER`, `DISABLE TRIGGER`, or `TRUNCATE` — row
triggers do not fire on truncation, and only the revoked grant stands in the way for
`aliquot_app` and `aliquot_worker`. Nothing here defends against a principal with DDL rights;
ADR-0005's checkpoints make that detectable, not preventable. The diff compares rendered
values rather than values, and serialises the whole row including `protocol`, paid twice on
every processing-state update of a sealed run. And `enforce_run_artifact_immutability()` reads
the run's state without a lock, deliberately: it narrows the seal-versus-binding race to one
statement rather than closing it.

## Consequences

**Easier:** The guarantee can be tested for what it claims.
`test/integration/immutability.spec.ts` connects as the database owner — superuser, RLS
bypassed — and still cannot move a sealed run, column by column across every field outside the
processing set. Those tests fail if the trigger is removed, which an API-level test of the same
rule would not. New write paths no longer need auditing for immutability.

**Harder:** Two definitions of one state machine, permanently. A new column on `aliquot.run`
that should be mutable after sealing costs a migration to `v_mutable`, not a service edit.
Errors reach the client only because `fromPostgres()` in `src/http/problem-details.filter.ts`
maps SQLSTATE 23000 to a 409 and passes the message through, so a string written in a
migration is part of the API surface.

**To revisit:** If `to_jsonb` on the run row shows up in worker latency once `protocol`
carries full OME-XML, generate the column list from a migration instead of diffing by hand. If
a third table needs the same allow-list, factor the projection into a shared function. If the
deployment ever grants the application role DDL privileges, this ADR is void.

## Action items

1. - [x] `enforce_run_immutability()` / `run_immutability` in `0004_runs.sql`, on the `to_jsonb(OLD) - v_mutable` diff.
2. - [x] `enforce_run_artifact_immutability()` / `run_artifact_immutability` over INSERT, UPDATE, DELETE.
3. - [x] `reject_artifact_mutation()` / `artifact_no_update`.
4. - [x] `revoke delete, truncate` from both roles on `run`, `run_artifact`, `artifact`; no default privileges.
5. - [x] `reject_audit_mutation()` on `audit_event` and `audit_checkpoint`.
6. - [x] `DATABASE_ENFORCED_TRANSITIONS`, `FROZEN_RUN_STATES`, `POST_SEAL_MUTABLE_COLUMNS` in `run-state-machine.ts`; the last typed `keyof RunTable`, so a rename in `schema.ts` fails to compile.
7. - [x] SQLSTATE 23000 mapped to 409, trigger message preserved.
8. - [x] Immutability suite runs as the database owner, not through the API.
9. - [x] `assertLeastPrivilege()` at startup: neither superuser nor `BYPASSRLS`.
10. - [ ] Unit test that `DATABASE_ENFORCED_TRANSITIONS` is a subset of `RUN_TRANSITIONS`. The constant is exported and unreferenced, so containment is unproven.
11. - [ ] Integration test comparing `v_mutable` in `pg_proc.prosrc` against `POST_SEAL_MUTABLE_COLUMNS`.
12. - [ ] Extend `scripts/lint-migrations.ts` to flag a migration adding a column to `aliquot.run`.
13. - [ ] Record the `TRUNCATE` and DDL gap in `docs/ARCHITECTURE.md`.
