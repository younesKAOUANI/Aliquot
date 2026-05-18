# CLAUDE.md

Operating instructions for AI assistants working in this repository. These are not
suggestions — treat them as the house style. When a rule here conflicts with a general
habit, this file wins.

---

## 1. What this project is

Aliquot is an **instrument run ingestion and provenance service**. It is infrastructure,
not science: it gets data off laboratory instruments and into a research data platform
without losing track of where any of it came from. It does not analyse images, call bases,
or interpret results.

Read these before changing anything non-trivial:

- [`docs/PRD.md`](docs/PRD.md) — what we are building and why, with acceptance criteria
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, data model, flows, failure modes
- [`docs/adr/`](docs/adr/) — every decision with real alternatives, and why the alternatives lost

The five guarantees the system exists to provide are: exactly-once ingestion, verified
integrity, mechanical provenance, detectable tampering, and tenant isolation enforced below
the application. Every change is evaluated against whether it strengthens or weakens those.

---

## 2. Authorship and commit hygiene

**This repository is authored by a human. The commit log must read that way.**

- **Never** add `Co-Authored-By: Claude`, `Generated with Claude Code`, or any other
  attribution trailer, badge, or footer to a commit, PR body, issue, or code comment.
- **Never** reference an AI assistant in code comments, documentation, or commit messages.
- Do not add trailers of any kind unless explicitly asked (`Signed-off-by`, `Refs`, etc.).

### Commit message format

Conventional-commit prefix, imperative mood, lower-case subject, no trailing period,
subject under 72 characters:

```
feat(audit): compute chain hash in the database, not the application

The hash covers (tenant_id, seq, prev_hash, payload_digest, occurred_at). Four of
those five are values the application should not be able to choose, so computing the
hash in Node meant trusting the caller with its own tamper-evidence. Moving it into
append_audit_event() means the digest is taken over what was actually stored, and
occurred_at comes from clock_timestamp() inside the same statement.

Payload canonicalisation stays in the application — JCS in plpgsql is not a
reasonable thing to maintain — so the application still supplies payload_digest.
That is the one input it controls, and it is covered by the chain.
```

Rules for the body:

- Explain **why**, not what. The diff already says what.
- Name the alternative you did not take when there was one.
- Reference the ADR when the commit implements a recorded decision (`Implements ADR-005.`).
- Omit the body only for genuinely trivial commits (typo fixes, formatting).
- Wrap at 72 characters.

Allowed prefixes: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `build`, `ci`.
Scope is the module or concern (`audit`, `ingestion`, `rls`, `storage`, `ci`).

### Commit granularity

One logical change per commit. A commit should compile, pass its own tests, and be
independently revertable. Do not batch a migration, a feature, and a docs update into one
commit. Do not split a single coherent change across five commits to inflate the log.

---

## 3. Engineering standards

### Correctness first

This service's entire value proposition is that its guarantees hold. Performance work that
weakens a guarantee is not a trade-off, it is a regression.

- Invariants belong in the database when the database can express them. A `CHECK`
  constraint, a partial unique index, or a trigger cannot be bypassed by the next
  refactor; an `if` statement in a service method can.
- Concurrency correctness comes from the database — unique constraints, `SELECT … FOR
  UPDATE`, `SKIP LOCKED`, serializable transactions. Do not reach for an application-level
  mutex or a distributed lock to solve something a constraint already solves.
- Never write a code path that can produce a dual write. If two things must both happen or
  neither, they go in one transaction.

### Explicitness

- No implicit tenant scoping. Every query either runs under RLS with `app.tenant_id` set,
  or is explicitly and visibly a cross-tenant administrative query.
- No silent catch. If an error is swallowed, the comment must say why that is safe.
- No `any`. No non-null assertions to shut the compiler up. If the type is wrong, fix the
  type.
- Prefer parsing to validating: untrusted input crosses a Zod schema at the boundary and is
  typed from there inwards.

### Data access

- SQL is written as SQL (Kysely). We do not use an ORM that hides the query, because the
  queries here — recursive lineage CTEs, `SKIP LOCKED` claims, RLS-scoped reads — are the
  interesting part.
- Migrations are plain `.sql`, forward-only, never edited once merged. A mistake is
  corrected by a new migration, exactly like a sealed run is corrected by a superseding run.
- Every new tenant-scoped table gets `ENABLE`/`FORCE ROW LEVEL SECURITY` and a policy in the
  same migration that creates it. CI fails if you forget; do not wait for CI to remind you.

### Testing

Integration-first, against real Postgres and real MinIO via Testcontainers. Mocks cannot
exercise RLS policies, triggers, or presigned multipart uploads, which is precisely where
the guarantees live — a mock of those tests nothing.

- Tests are organised around **guarantees**, not endpoints. See `test/integration/`.
- Every bug fix starts with a failing test that reproduces it.
- Unit tests are reserved for pure, load-bearing logic: the state machine transition table,
  JCS canonicalisation, digest computation, cursor encoding.
- A test that would still pass with the feature deleted is not a test.

---

## 4. Documentation standards

Documentation is a deliverable here, not an afterthought. The repository is meant to be
legible to a reviewer who reads it for ten minutes and never runs it.

### ADRs

Any decision with a real alternative gets an ADR in `docs/adr/`, numbered sequentially,
using the template in [`docs/adr/TEMPLATE.md`](docs/adr/TEMPLATE.md).

- Write the ADR **when you decide**, in the same commit as the code where practical. A
  retrofitted ADR reads like a justification; a contemporaneous one reads like engineering.
- The rejected options are the valuable part. An ADR listing one option is a diary entry.
- State the residual risk and the weakness of the chosen option honestly. Overclaiming is
  the fastest way to lose a technical reader.
- Never silently edit an accepted ADR to match reality. Supersede it with a new one and set
  the old status to `Superseded by ADR-NNN`.

### Prose

- Plain declarative English. No marketing register, no "seamlessly", no "robust", no
  "leverage", no emoji.
- Prefer a table to a paragraph when comparing options. Prefer a diagram to a table when
  describing a flow.
- Say what the system does **not** do as clearly as what it does. The non-goals section of
  the PRD is load-bearing.
- Code comments explain *why*, never *what*. If a comment restates the line below it, delete
  the comment.

---

## 5. Working agreements

- **Do not invent scope.** The PRD has P0/P1/P2 tiers and a parking lot. If something is not
  in the PRD, either it is out of scope or the PRD needs updating first — say which.
- **Do not weaken a test to make it pass.** If a test fails, the code is wrong until proven
  otherwise.
- **Do not add a dependency without justifying it.** Every dependency is a permanent
  maintenance obligation. If it is under ~200 lines and load-bearing, write it, own it, and
  test it exhaustively.
- **Do not leave TODOs in committed code.** Either do it, or open an issue and reference it.
- Run `npm run verify` (lint, typecheck, unit, integration) before considering work done.
  Report failures verbatim; never describe a red suite as green.

---

## 6. Repository layout

```
docs/            PRD, architecture, ADRs, demo script, diagrams
migrations/      Forward-only .sql migrations, numbered
src/
  common/        Canonical JSON, digests, UUIDv7, problem details, cursors
  database/      Pool, transaction runner, tenant context, generated types
  identity/      Tenants, studies, users, instruments, memberships, auth
  ingestion/     Runs, manifests, idempotency, state machine, uploads
  storage/       Content addressing, presigning, object store adapter
  audit/         Event append, hash chain, verification, checkpoints
  provenance/    Derivations, lineage traversal, W3C PROV export
  processing/    Queue seam, worker runtime, processors
  viewer/        Read-only static UI
test/
  integration/   Guarantee-oriented suites against real dependencies
  unit/          Pure logic
scripts/         Seed data, demo driver, migration lint
```
