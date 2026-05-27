# ADR-0016: Unprivileged NOINHERIT login role with SET LOCAL ROLE per transaction

**Status:** Accepted
**Date:** 2026-05-27
**Deciders:** Younes Kaouani

## Context

ADR-0002 put tenant isolation in row-level security. RLS only binds a role that is neither
superuser nor `BYPASSRLS`, and every policy compares `tenant_id` against
`aliquot.current_tenant_id()`, which reads `app.tenant_id` off the session. Both are properties of
the connection at the instant a statement runs, not of the code that wrote it. That left a second
question open: what the service authenticates as, and how per-request state reaches a shared
connection.

`0001_foundation.sql` creates `aliquot_app` and `aliquot_worker` as `NOLOGIN` group roles holding
the table grants; nothing can connect as them. Migrations run as the owner via
`DATABASE_ADMIN_URL`. What `DATABASE_URL` points at was undefined.

Two failure modes shaped the answer. Connections are pooled (`pg.Pool`, no `DISCARD ALL` on
release), so state set with a plain `SET` outlives the request and the next request on that
connection inherits the previous request's tenant — the exact bug this layer exists to prevent,
reintroduced by the code enforcing it. And a privileged connection has no symptom: point
`DATABASE_URL` at `postgres` and every request succeeds, every test passes, and RLS is not
running. The worker complicates both, because claiming a job is *how* it learns whose work is
next, so at claim time there is no tenant to scope to.

## Decision

The service connects as a dedicated login role — `aliquot_login` in `docker-compose.yml` and
`.env.example` — created by `bootstrapLoginRole()` in `scripts/migrate.ts` with
`login noinherit nobypassrls nosuperuser nocreatedb nocreaterole`. It is granted membership in
`aliquot_app` and `aliquot_worker`, `CONNECT`, and `USAGE` on schema `aliquot`. It holds no
privilege on any table.

Every transaction opens with `SET LOCAL ROLE` followed by one `SELECT` of three
`set_config(..., true)` calls, both in `applySessionContext()`
(`src/database/database.service.ts`). `assertLeastPrivilege()` runs from `onModuleInit` and
refuses to boot if the login role is a superuser, holds `BYPASSRLS`, is not a member of the
expected group role, or if that group role itself holds `BYPASSRLS`.

## Options considered

### Option A: Unprivileged NOINHERIT login role, `SET LOCAL ROLE` per transaction

| Dimension | Assessment |
|---|---|
| Role not assumed | `42501` on the first statement — immediate and total |
| Leak across a pooled connection | None; role and settings revert at `COMMIT`/`ROLLBACK` |
| Blast radius of a forgotten scope | Zero rows or a permission error, never foreign rows |
| Cost | Two extra statements; session or transaction pooling only |

**Pros:** Fail-closed. The connection's ambient authority is nothing, so a path that skips the
preamble cannot run rather than running with more access than intended. `SET LOCAL` ties the
tenant to transaction lifetime, the only lifetime that matches a request on a pooled connection.

**Cons:** Two round trips per transaction, and a hard dependency on the pooler preserving
transaction-local state.

### Option B: Connect as the owner and rely on application discipline

| Dimension | Assessment |
|---|---|
| Scoping forgotten | Silent — the query returns every tenant's rows |
| Blast radius | Whole database, including `aliquot.audit_event` |
| Cost | None |

**Pros:** One connection string, nothing to remember, no per-transaction cost.

**Cons:** The owner is exempt from RLS without `FORCE`, and exempt from the grant model entirely —
`0003_audit_chain.sql` withholds `UPDATE` and `DELETE` from `aliquot_app`, and an owner connection
has both. It makes the guarantee a property of reviewer attention on every future query, which
ADR-0002 spent a whole decision refusing.

### Option C: Grant the application `BYPASSRLS` and filter in application code

| Dimension | Assessment |
|---|---|
| Scoping forgotten | Silent, and indistinguishable from a correct query |
| Blast radius | Whole database |
| Cost | None; marginally better plans, no policy quals appended |

**Pros:** No preamble and no session variables, and cross-tenant administrative work needs no
special case. The predicate is visible in query text a reviewer already reads.

**Cons:** It deletes the layer. `test/integration/isolation.spec.ts` becomes a test of the
application's own `WHERE` clauses, written by the same person in the same file tree — and the
interesting queries here are recursive lineage CTEs and the `SKIP LOCKED` claim in
`aliquot.claim_jobs()`, where a missing predicate is least visible.

### Option D: One login role per tenant

| Dimension | Assessment |
|---|---|
| Scoping forgotten | Structural — cannot happen; identity is the scope |
| Blast radius | One tenant |
| Cost | One pool per tenant; onboarding becomes DDL |

**Pros:** The strongest binding available. No preamble to forget, no session variable to lose
across an `await`.

**Cons:** Pools do not amortise across roles, so connection count scales with tenant count and the
process exhausts backends before it exhausts work. Onboarding becomes `CREATE ROLE` plus N grants
issued at runtime by a service that deliberately holds no `CREATEROLE`. It also makes the worker
impossible: it would need every tenant's credential to poll one queue.

## Trade-off analysis

`NOINHERIT` is the whole decision; the rest follows. Membership without inheritance means
`aliquot_app`'s privileges exist but are unreachable until `SET ROLE` is issued. Drop the preamble
and the first statement fails with `42501`, on the first request, in development. Under the
default `INHERIT` the same omission runs with the union of everything the login role is a member
of — `aliquot_app` *and* `aliquot_worker` — so a forgotten `SET LOCAL ROLE` in an API path would
silently acquire the worker's cross-tenant view of `aliquot.job`. Fail open versus fail closed,
for one keyword.

`SET LOCAL` rather than `SET` is that argument applied to the tenant. A plain `SET` binds to the
session, the pool hands that session to the next request, `current_tenant_id()` returns the
previous caller's tenant, and every policy cheerfully agrees. `SET LOCAL` reverts at `COMMIT` or
`ROLLBACK`, and a path that forgets it gets `NULL`, which RLS reads as false.

`set_config()` rather than interpolation is smaller with a sharper edge. `SET` is utility SQL and
takes no bind parameters, so `SET LOCAL app.tenant_id = $1` is a syntax error and the obvious
workaround is building the statement by string concatenation.
`set_config('app.tenant_id', $1, true)` is a function call inside a `SELECT`, so the value is an
ordinary bind parameter and the third argument supplies `SET LOCAL` semantics. The role name
genuinely cannot be parameterised, so `quoteIdentifier()` validates it against
`^[a-z_][a-z0-9_]*$`; its input is one of two literals in `DatabaseRole`, and the check exists to
keep that true.

`assertLeastPrivilege()` aborts startup rather than logging because there is no later moment at
which the mistake becomes visible: a superuser connection changes no response, no status code and
no test outcome, it only removes the layer. It also asserts the *assumed* role lacks `BYPASSRLS`,
which would be as effective a bypass and less conspicuous.

The worker's cross-tenant need is met without weakening any of this.
`withoutTenantScope('aliquot_worker')` sets the role and deliberately sets no tenant, so
`current_tenant_id()` is `NULL` and every `tenant_isolation` policy denies. The one exception is
`worker_claims_across_tenants` on `aliquot.job` in `0007_jobs.sql`, scoped `TO aliquot_worker`.
Having claimed a row, `PostgresJobQueue` takes `tenant_id` from it and everything after runs under
`withTenant()`. `BYPASSRLS` would have bought the same capability at the price of every other
table.

## Consequences

**Easier:** Two connection strings, the privileged one used only by `scripts/migrate.ts`. A
misconfigured deployment fails at boot naming the attribute at fault. A new data-access path
cannot run unscoped; the worst it can do is fail. `test/integration/isolation.spec.ts` asserts
`rolsuper`, `rolbypassrls` and `rolinherit` for `current_user`, and asserts that a bare
`select 1 from aliquot.run limit 1` without `SET LOCAL ROLE` is denied.

**Harder:** Two extra statements per transaction; the three `set_config()` calls are folded into
one `SELECT` for that reason. A raw `this.db` query works for unprotected objects and fails
everywhere else, which is a confusing first encounter. Re-scoping mid-transaction means calling
`applySessionContext()` again, as `IdentityService` does when it switches from the system context
that looked a user up to the user context the audit event is attributed to. Role bootstrap cannot
live in a migration — the password comes from the environment and migrations are checksummed — so
`bootstrapLoginRole()` inlines it as a literal and rejects backslashes rather than escaping them.

The honest weakness is the pooler. Both preamble statements are transaction-scoped, so they need a
pooler that pins a transaction to one server connection. PgBouncer in **session** or
**transaction** mode is fine; PgBouncer in **statement** mode breaks this outright — the preamble
and the query it protects can land on different backends, and the query then runs as the bare
login role with no privileges. It fails loudly rather than leaking, which is the right direction,
but it fails on every request, and the constraint is asserted nowhere by code.

**To revisit:** Introducing a pooler, per the above. The preamble measuring as a real cost, where
a pipelined batch or a `SECURITY DEFINER` entry function is the next step, not dropping the check.
A third caller for `withoutTenantScope()` without an argument for it. Or administrative endpoints
legitimately spanning tenants, served today only by the two `aliquot_app` callers in
`TenantRegistry` reading the deliberately unscoped `aliquot.tenant`.

## Action items

1. - [x] `aliquot_app` and `aliquot_worker` created `NOLOGIN`, `NOBYPASSRLS`, `NOSUPERUSER` (`0001_foundation.sql`).
2. - [x] `bootstrapLoginRole()` creates the login role `NOINHERIT` with no table grants (`scripts/migrate.ts`).
3. - [x] `applySessionContext()` issues `SET LOCAL ROLE` before any other statement in the transaction.
4. - [x] Tenant, actor and actor type set by `set_config(..., true)` with bind parameters, in one round trip.
5. - [x] `quoteIdentifier()` validates the role name, the one value `SET ROLE` cannot parameterise.
6. - [x] `assertLeastPrivilege()` blocks startup on superuser, `BYPASSRLS`, or missing membership.
7. - [x] Worker cross-tenant reads bounded to `aliquot.job` by `worker_claims_across_tenants` (`0007_jobs.sql`).
8. - [x] `isolation.spec.ts` asserts `rolinherit = false`, no superuser, no `BYPASSRLS`, and denial without `SET LOCAL ROLE`.
9. - [ ] Assert the pooler's `pool_mode` at startup when one is present.
10. - [ ] Separate login roles for API and worker, so the API cannot assume `aliquot_worker` at all.
11. - [ ] A password rotation procedure that does not require a migration run.
