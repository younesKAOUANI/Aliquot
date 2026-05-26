# ADR-0002: Shared schema with row-level security for tenant isolation

**Status:** Accepted
**Date:** 2026-05-26
**Deciders:** Younes Kaouani

## Context

Aliquot holds instrument runs for several organisations in one deployment. The data is
unpublished experimental output, and in some studies human subject data with a consent scope
narrower than the organisation that owns it. A cross-tenant read is a disclosure, discovered by
the party disclosed to rather than by us.

The realistic threat is not an attacker holding a credential. It is a forgotten
`WHERE tenant_id = ?` in a query written months from now, a join reaching a table nobody thought
to scope, or a sweep running with no request context. This is one maintainer writing hand-rolled
SQL through Kysely (ADR-0013), and the interesting queries — recursive lineage CTEs, the
`SKIP LOCKED` claim in `aliquot.claim_jobs()` — are where a missing predicate is least visible.

Connections are pooled, so session state outliving a transaction becomes the next request's
state. The worker also claims a job before it knows whose job it is, so the mechanism needs a
bounded cross-tenant read without a blanket exemption. The decision had to land before
`0002_tenancy.sql` created the first tenant-scoped table: it fixes every table, every index, and
the migration runner.

## Decision

All tenants share one schema (`aliquot`) in one database, and isolation is enforced by
PostgreSQL row-level security: every tenant-scoped table carries `ENABLE` and
`FORCE ROW LEVEL SECURITY` plus a `tenant_isolation` policy comparing `tenant_id` against
`aliquot.current_tenant_id()`, and the application connects as a role with neither `BYPASSRLS`
nor superuser. Filtering by tenant in application code is a convenience for the planner and the
reader; it is never the boundary.

## Options considered

### Option A: Shared schema with row-level security

| Dimension | Assessment |
|---|---|
| Complexity | Low structurally, high in discipline |
| Failure mode when wrong | Permissive policy; an unscoped query returns foreign rows |
| Migration risk | One schema, one atomic outcome per file |
| Per-tenant operations | Poor — no restore or resource limit per tenant |
| Testability | An unscoped `SELECT` tests the whole boundary |

**Pros:** One mechanism, declared once per table, enforced below every query regardless of who
wrote it. Adding a tenant is an insert.

**Cons:** All tenants share one heap and one index, so a dropped policy returns everything rather
than erroring. Every index must lead with `tenant_id`.

### Option B: Schema per tenant

| Dimension | Assessment |
|---|---|
| Complexity | Moderate up front, compounding with tenant count |
| Failure mode when wrong | Divergent schema versions; silent until a query lands wrong |
| Migration risk | High — no cross-schema atomicity at any real N |
| Per-tenant operations | Good — `pg_dump -n`, drop schema is a clean deletion |
| Testability | Provable that A cannot reach B; not that all N match |

**Pros:** Isolation is structural rather than predicated — no policy to forget, because the rows
are not in the same table. Per-tenant export and deletion are trivial.

**Cons:** Migrations become a program with failure states. One that succeeds for 40 tenants and
fails on the 41st leaves two schema versions live under an application expecting one, and the
repair path is itself untested code run under pressure. `search_path` also becomes security
state on a pooled connection, with a worse reset hazard than `SET LOCAL`: forgetting it lands on
whatever schema was last used, not on nothing.

### Option C: Database per tenant

| Dimension | Assessment |
|---|---|
| Complexity | Low per database, high in the routing tier |
| Failure mode when wrong | Connection routed to the wrong database — rare, and loud |
| Migration risk | Highest — no shared transaction at all |
| Per-tenant operations | Best — independent backup, encryption key, residency |
| Testability | Strong isolation; the routing layer becomes the thing under test |

**Pros:** The strongest isolation short of separate hardware, and the only option answering data
residency or per-tenant encryption keys, which a laboratory customer may eventually ask for.

**Cons:** Pools do not amortise across databases, so pool count scales with tenants and the
process exhausts file descriptors before it exhausts work. Cross-tenant operator questions become
application-level fan-out. Option B's migration problem, worse.

## Trade-off analysis

Schema per tenant was hardest to argue against. It gives structural isolation without Option C's
connection cost, and removes the exact bug this layer exists to catch: you cannot forget a policy
on a table only one tenant can reach.

It lost on failure mode — specifically, on which failure can be written down as a test.

A too-permissive policy is detectable by a query any test can make: run as the application role
with `app.tenant_id` set to tenant A, select from a table with no `WHERE` clause, assert nothing
of tenant B comes back. That is `test/integration/isolation.spec.ts`, and it enumerates tables
from `pg_class` rather than by hand, so a table added by a future migration is covered the moment
it exists. The same suite asserts the complement — no table both readable by `aliquot_app` and
missing a forced policy — and asserts non-vacuity, since `USING (false)` would pass every leak
check while breaking the product.

A partially-applied per-schema migration has no equivalent. The failure is not "the query
returned the wrong rows", it is "tenant 41 is on version 6 and everyone else on 7", surfacing
later in a request touching a column that does not exist there yet. A drift check runs after the
damage and the repair is bespoke each time. Between a bug assertable in CI and a bug detectable
only in production, the first is the better one to own.

The honest weakness: this converts a structural property into a standing obligation, and nothing
about adding a table forces you to protect it. That is discharged by mechanism rather than care.
`aliquot.apply_tenant_rls()` in `0001_foundation.sql` makes protection one line instead of three,
so `FORCE` cannot be omitted independently of `ENABLE`, and `scripts/lint-migrations.ts` fails
`npm run verify` on any `tenant_id` table without a forced policy. Two tables are exempt with
reasons recorded in that script's `EXEMPT` map: `job`, which carries a second policy
`worker_claims_across_tenants` because claiming precedes knowing whose work it is, and
`audit_chain_head`, on which the application role holds no privilege at all.

Three details carry more weight than their size:

- **Deny by default via NULL.** `aliquot.current_tenant_id()` returns `NULL` when `app.tenant_id`
  is unset rather than raising, so `tenant_id = NULL` is `NULL`, which RLS treats as false. A
  path that forgets the tenant sees zero rows, not every row.
- **`FORCE`, not just `ENABLE`.** `ENABLE` alone exempts the table owner, and migrations run as
  the owner. The omission has no other symptom.
- **`security_invoker` on views.** A view over an RLS-protected table runs with its owner's
  privileges unless declared `WITH (security_invoker = true)`, evaluating policies against the
  wrong role. `prov_entity`, `prov_activity` and `prov_agent` in `0006_provenance.sql` declare
  it, the lint rejects a view that does not, and the suite asserts every view's `reloptions`
  contains `security_invoker=true`. One word, and it undoes all of the above.

## Consequences

**Easier:** A tenant is one row in `aliquot.tenant`; a tenant-scoped table is one
`select aliquot.apply_tenant_rls('...')`. Migrations stay forward-only SQL with one outcome per
file. Deliberate cross-tenant work goes through the conspicuously named
`DatabaseService.withoutTenantScope()`, which has two callers. An insert carrying a foreign
`tenant_id` raises `42501`, mapped to a 403 with the database message withheld in
`src/http/problem-details.filter.ts`.

**Harder:** Every index must lead with `tenant_id`. Per-tenant restore does not exist —
recovering one tenant means a filtered export and replay, untested until needed. Noisy neighbours
are unmitigated. Every `SECURITY DEFINER` function is a deliberate hole argued individually. RLS
also stops at the database: object keys are `sha256/<aa>/<bb>/<digest>` with no tenant prefix, so
identical bytes in two tenants are one object, and what keeps a presigned URL tenant-safe is only
that it was issued after a tenant-scoped read. The rules live in migrations, not `src/`, so a
reviewer reading only TypeScript sees no sign of the boundary.

**To revisit:** A contract requiring data residency or a per-tenant encryption key — neither is
expressible here, and Option C wins regardless of cost. A single tenant's volume making shared
indexes on `aliquot.run` or `aliquot.audit_event` the bottleneck, where partitioning by
`tenant_id` precedes splitting. Per-tenant point-in-time restore becoming a requirement. Or an
unprotected table reaching production despite lint and suite, which is direct evidence the
obligation is not being discharged by the mechanisms chosen to discharge it.

## Action items

1. - [x] `current_tenant_id()` and siblings return `NULL` when unset (`0001_foundation.sql`).
2. - [x] `apply_tenant_rls()` applies `ENABLE`, `FORCE` and the policy in one call; 16 tables use it.
3. - [x] `aliquot.tenant` deliberately unscoped, protected by grants: `SELECT` only.
4. - [x] `SET LOCAL ROLE` plus `set_config(..., true)` in `applySessionContext()`.
5. - [x] `assertLeastPrivilege()` refuses to boot on superuser, `BYPASSRLS`, or an unassumable role.
6. - [x] Worker cross-tenant visibility as a second policy on `aliquot.job`, not `BYPASSRLS`.
7. - [x] All three PROV views declared `WITH (security_invoker = true)`.
8. - [x] `scripts/lint-migrations.ts` fails CI on an unprotected table or a view without `security_invoker`.
9. - [x] Catalogue-driven `test/integration/isolation.spec.ts` covering reads, deny-by-default, `WITH CHECK`, role attributes, view options.
10. - [ ] Per-tenant statement timeout or connection budget.
11. - [ ] A rehearsed single-tenant export and restore procedure.
12. - [ ] CI assertion that no `SECURITY DEFINER` function exists beyond the two reviewed.
