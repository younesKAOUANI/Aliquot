# ADR-0013: Kysely as the data-access layer rather than an ORM

**Status:** Accepted
**Date:** 2026-06-02
**Deciders:** Younes Kaouani

## Context

By the time the first endpoints were written, `migrations/` had already decided what the
data-access layer had to be capable of. The queries that carry the guarantees are not CRUD:

- **Recursive traversal.** `aliquot.artifact_ancestors()` / `artifact_descendants()`
  (migration 0006) and `RunService.loadSupersedeChain()` are `WITH RECURSIVE` with a depth
  cap in the recursive term.
- **Queue claiming.** `aliquot.claim_jobs()` (migration 0007) is `UPDATE … WHERE id IN
  (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`; `RunService.lockRun()` takes row locks
  with `.forUpdate()` to serialise concurrent seals.
- **Conflict targets naming real objects.** `IdempotencyService` uses `ON CONFLICT ON
  CONSTRAINT idempotency_key_unique DO NOTHING`; `PostgresJobQueue.enqueue()` must restate
  the *predicate* of the partial index `job_dedupe_idx`, because rows with a null
  `dedupe_key` are outside it and must not conflict at all.
- **Set-returning function calls.** `AuditService.append()` calls
  `aliquot.append_audit_event()`; it cannot be an insert, because ADR-0015 removed the
  application's ability to choose four of the five hash inputs.

Underneath sits the constraint from ADR-0002 and ADR-0016. RLS policies resolve against
`aliquot.current_tenant_id()`, which reads `app.tenant_id`, set with `set_config(…, true)`
— `SET LOCAL` semantics — in the same transaction as the work, alongside `SET LOCAL ROLE`.
Both are properties of a *connection*, reverted at commit or rollback. A layer that does
not let the application own the connection and transaction lifecycle cannot guarantee that
the session variables and the statements meet on one connection.

Getting this wrong fails closed but quietly: `current_tenant_id()` returns NULL when the
setting is absent, and RLS treats `tenant_id = NULL` as false. An escaped read returns
zero rows and surfaces as a 404; an escaped write fails with 42501. Nothing leaks, and
nothing looks broken either.

## Decision

Data access is Kysely over `pg`, with a hand-written `Database` interface in
`src/database/schema.ts` and Kysely's `sql` tagged template as the escape hatch. No ORM,
no entity mapping, no generated client, and no migration tooling attached to the query
layer.

## Options considered

### Option A: Prisma

| Dimension | Assessment |
|---|---|
| Complexity | Query engine, generated client, second schema language |
| Connection/transaction control | Owned by the client |
| Recursive CTE / `SKIP LOCKED` | `$queryRaw` only |
| Type fidelity | Generated; cannot drift from its own source |

**Pros:** The best generated types of any option, and the only type layer that cannot
drift.

**Cons:** `schema.prisma` cannot express `CREATE POLICY`, `FORCE ROW LEVEL SECURITY`,
`SECURITY DEFINER` functions, `security_invoker` views, the `aliquot.sha256_hex` domain,
or partial indexes with predicates — it would describe a subset of the database and stay
silent about the half that enforces the guarantees. Every load-bearing query becomes
`$queryRaw`, so the typed client is unavailable where it would pay. And any call leaving
an interactive-transaction callback takes a different pooled connection with
`app.tenant_id` unset, making the RLS mechanism a convention rather than a structure.

### Option B: TypeORM

| Dimension | Assessment |
|---|---|
| Complexity | Decorator entities, repositories, relations, cascades |
| Connection/transaction control | `QueryRunner` gives a real connection |
| Recursive CTE / `SKIP LOCKED` | Partial; degrades to raw strings |
| Type fidelity | Decorators are a second hand-written declaration |

**Pros:** Gives back the connection, so `SET LOCAL ROLE` and `set_config` are
straightforward. Mature and native to NestJS.

**Cons:** Decorators are a hand-written schema declaration with more surface than
`schema.ts` and worse failure modes — `synchronize: true` here would drop policy-bearing
objects. Lazy relation loading makes it easy to issue a query outside the tenant-scoped
transaction without writing anything that looks wrong, which is the failure the explicit
`RequestContext` threading in `src/database/request-context.ts` exists to prevent.

### Option C: raw `pg` with a small query helper

| Dimension | Assessment |
|---|---|
| Complexity | Lowest; the dependency is already required |
| Connection/transaction control | Total |
| Recursive CTE / `SKIP LOCKED` | Native; nothing to work around |
| Composing optional predicates | Manual, and the injection surface |

**Pros:** No abstraction to learn or fight; every hard query is written as it would be
anyway. `scripts/migrate.ts` already uses `pg` directly.

**Cons:** `AuditService.list()` and the run search compose optional predicates
conditionally; by hand that is concatenation with positional-parameter bookkeeping, where
a mistake is a runtime error at `$14` rather than a compile error. Inserts against wide
tables — `aliquot.run` has eighteen columns — become positional lists nothing checks.

### Option D: Kysely (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Type-level builder; no runtime beyond `pg` |
| Connection/transaction control | Total — `db.transaction().execute()` is one connection |
| Recursive CTE / `SKIP LOCKED` | `sql` template, same binding as `pg` |
| Type fidelity | Hand-written `Database`; drift is possible |

**Pros:** Owns nothing. `DatabaseService.withTenant()` opens a transaction, runs
`applySessionContext()`, and hands the same `Transaction<Database>` to the callback, so
the callback cannot get a different connection. `sql<T>` fragments compose into builder
queries — this is what lets `RunService.visibleStudies()` return a membership subquery as
a `WHERE` clause. `.onConflict()` reaches named constraints and index predicates directly.

**Cons:** `schema.ts` is 18 table interfaces written by hand and can drift from
`migrations/`. `sql<T>` is an assertion, not a check.

## Trade-off analysis

Prisma and TypeORM lost for one reason reached by two routes: both want to own the schema,
and this schema's important content — policies, forced RLS, `SECURITY DEFINER` functions,
`security_invoker` views, append-only grants — is content neither can express. Either
means keeping `migrations/*.sql` anyway plus a second declaration that is authoritative
for the query layer and wrong about the database. Prisma additionally owns the connection,
which was disqualifying on its own.

Raw `pg` was the hard one, and this decision sits close to it. It has no type layer to
drift, no dependency to maintain, and would produce byte-identical SQL for `claim_jobs()`,
the lineage walks, `loadSupersedeChain()` and `append_audit_event()` — every query named
in the Context. Kysely's advantage is confined to the unglamorous middle: wide inserts,
and predicates accumulated across branches (`statement = statement.where(…)` in
`AuditService.list()`). That is where hand-rolled SQL turns into concatenation, and
concatenation is where injection lives. The marginal cost over `pg` is one dependency and
`schema.ts`; the marginal benefit is that the middle is parameterised by construction
rather than by discipline. The margin is narrow.

The chosen option's weakness is not fully mitigated. The comment atop `schema.ts` claims
drift becomes a compile error; that holds in one direction only. Drop a column in a
migration without editing `schema.ts` and nothing fails until the query runs and Postgres
answers 42703 — which `fromPostgres()` in `src/http/problem-details.filter.ts` does not
map, so it surfaces as a 500. The mitigation is that `test/integration/global-setup.ts`
runs the real `scripts/migrate.ts` against a Testcontainers Postgres, so every query the
suite exercises is checked against the real schema. That is coverage-shaped protection,
not a proof.

## Consequences

**Easier:** `withTenant()` and `withoutTenantScope()` are the only ways to obtain a
transaction, so every statement provably runs after `SET LOCAL ROLE` and
`set_config('app.tenant_id', …, true)`. Postgres-native features are used without asking
whether the layer supports them: `SKIP LOCKED`, partial-index conflict targets,
`clock_timestamp()` in a `SET` clause, `bigint` carried as text via
`types.setTypeParser(types.builtins.INT8, …)`. Errors keep their SQLSTATE, so `23505`,
`23514`, `23000` and `42501` map to problem details rather than to a driver-specific
exception hierarchy.

**Harder:** `schema.ts` is a permanent manual obligation — every migration that changes a
column obliges an edit, and forgetting it is a runtime failure, not a build failure.
Roughly a third of the interesting queries go through `sql<T>`, where the type parameter
is a claim nothing verifies; `WalkRow`, `ChainRow` and `JobRow` are all asserted. `jsonb`
arrives as `Record<string, unknown>` and needs parsing at every read. There is no
scaffolding: a new endpoint is a new hand-written query.

**To revisit:** if drift causes a production incident, or if the CI check below cannot be
kept green, adopt generated types — diffed in CI against a migrated container, not
committed as the source of truth. If lineage graphs outgrow recursive CTEs (migration 0006
puts that at a few thousand nodes) the question becomes a graph store, which supersedes
ADR-0008 rather than this record.

## Action items

1. [x] `Database` interface covering all 18 tables, keyed by schema-qualified name so no
   query resolves through `search_path`.
2. [x] `withTenant()` / `withoutTenantScope()` as the only entry points to a transaction,
   the latter named to be conspicuous in review.
3. [x] `applySessionContext()` binds the tenant id as a parameter to `set_config` and
   validates the role name in `quoteIdentifier()` before interpolating it.
4. [x] `types.setTypeParser` for `INT8` and `NUMERIC` so `audit_event.seq` never rounds.
5. [x] SQLSTATE mapping matched structurally, not with `instanceof DatabaseError`, so a
   duplicated `pg` in the module graph cannot turn constraint violations into 500s.
6. [x] Integration suite runs `scripts/migrate.ts` itself, exercising the schema types
   against the real migrations rather than a fixture.
7. [x] `RequestContext` threaded as a parameter; no async-local storage for tenant identity.
8. [ ] CI drift check: generate types against a migrated Testcontainers Postgres and diff
   against `schema.ts`, failing on any column present in one and not the other.
9. [ ] Map SQLSTATE `42703` to a distinct internal error so drift is identifiable in logs
   instead of anonymous inside the 500s.
10. [ ] Parse `run.protocol`, `derivation.parameters` and `job.payload` through Zod at the
    read boundary instead of typing them `Record<string, unknown>`.
