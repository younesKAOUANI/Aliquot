# ADR-0010: Correction by superseding record, never by mutation

**Status:** Accepted
**Date:** 2026-06-18
**Deciders:** Younes Kaouani

## Context

Sealing is the immutability boundary, and ADR-0007 put it in the database:
`aliquot.enforce_run_immutability()` in `migrations/0004_runs.sql` diffs `to_jsonb(old)` against
`to_jsonb(new)` minus a five-column allow-list and raises `integrity_constraint_violation` on any
other difference. That settles whether a sealed run can change. It does not settle what happens
when the sealed record is wrong — a channel re-acquired after a focus drift, a run attributed to
the wrong person, a manifest naming a file the instrument never wrote. Corrections are not an
edge case in a laboratory; a design with no answer for them ends with someone answering at the
psql prompt.

What decides the answer is external. A run identifier does not stay inside Aliquot; it ends up
in a figure caption, in a `run_id` column in a warehouse, in a lab notebook.
Whatever it resolved to on the day it was cited must resolve to the same thing years later, and
the citer will not re-check. A correction that changes what an already-cited identifier means is
a silent provenance failure — the exact category this service exists to prevent. PRD §8 flagged
the question as blocking; it stayed open longer than anything else here.

Secondary constraints: the superseded run stays retrievable (PRD R4); the rule is enforceable
below the application; and a correction states why, or it is a second version of the truth.

## Decision

A correction mints a **new run with a new identifier**, carrying `supersedes_run_id` and
`supersede_reason` pointing backwards at the run it replaces. The superseded run is never written
to again — in particular there is no `superseded_by` column, because writing one would mutate a
sealed row.

## Options considered

### Option A: New identifier with a backward pointer (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Low in the schema; moved onto reads |
| A bare identifier resolves to | Fixed at registration, permanently |
| Database enforceability | Complete — a correction is an `INSERT`; the predecessor is untouched |
| Cost of "the current run" | Recursive CTE over `run_supersedes_idx` |
| Failure mode if corrections are ignored | Stale, never silently altered |

**Pros:** A citation keeps its meaning by construction, not by policy. A correction is an
ordinary `INSERT`, so `enforce_run_immutability()` needs no exception and its fail-closed diff
stays intact. `run_supersede_reason_present` and `run_no_self_supersede` make "a correction
states its cause" and "a run cannot correct itself" structural. Storage cost is near zero:
re-declared artifacts resolve to existing `aliquot.artifact` rows.

**Cons:** "The current run" stops being a primary-key read: `RunService.get()` issues a second
query, `loadSupersedeChain()`, two recursive CTEs bounded at `MAX_SUPERSEDE_DEPTH = 64`. Search
returns superseded and superseding runs side by side, and corrections can branch, so
`RunDetail.supersededBy` is an array.

### Option B: Version under a stable identifier

`run` keyed by `(run_id, version)`. `GET /v1/runs/{id}` returns the current version; older ones
are addressable explicitly.

| Dimension | Assessment |
|---|---|
| Complexity | Moderate — the header/revision split touches every read and every FK |
| A bare identifier resolves to | Whatever the newest version is, at read time |
| Database enforceability | Partial — the current-version pointer must be mutable |
| Cost of "the current run" | One read |
| Failure mode if corrections are ignored | Silent change of meaning |

**Pros:** The ergonomics most callers expect. One identifier per acquisition, so a listing has
no duplicates and no deduping. Version pinning is there for anyone who asks.

**Cons:** It makes the guarantee opt-in: the correct citation becomes the pinned form, and a
consumer citing the bare identifier fails invisibly. Enforcement degrades too — the column
marking the current version must be mutable, so it joins `v_mutable` in the trigger, and every
entry there is a hole in the mechanism that makes immutability non-negotiable.

### Option C: In-place amendment with an audit-trailed correction record

Mutate the sealed run, require a reason, let the hash-chained audit log hold the before-image:
the amendment model a LIMS typically implements.

| Dimension | Assessment |
|---|---|
| Complexity | Lowest in the schema, highest in the guarantee |
| A bare identifier resolves to | Current values; history only via the audit chain |
| Database enforceability | None — the trigger must be relaxed to permit the amendment |
| Cost of "the current run" | One read |
| Failure mode if corrections are ignored | Silent, undetectable from the row |

**Pros:** Simplest data model, familiar in regulated laboratories, and the history does exist,
in a chain that is already tamper-evident.

**Cons:** It deletes the boundary. Reconstructing what a run looked like when it was cited means
replaying audit payloads, so the record becomes derived rather than stored. It also inverts
ADR-0007 — sealing would mean "changes are logged", not "changes are refused" — and
`test/integration/immutability.spec.ts` would have nothing left to assert.

## Trade-off analysis

Option B was the hard one: the conventional answer, better on every dimension but one — fewer
rows, no branching, no chain walk, no duplicate listings.

It lost on the dimension that is the product. Under B the bare identifier is a *mutable
reference*: a figure published in March cites run `018f…` at version 1, a correction lands in
June, the citation resolves to version 2, and nobody who relied on it is told. The mitigation —
always cite the pinned form — is policy applied by people outside this system, and a guarantee
that depends on everyone choosing the careful form is not one. Under A a stale consumer stays
stale, seeing exactly what it cited: wrong-but-honest is detectable, changed-and-silent is
not.

The secondary argument is enforcement. Under A the rule needs no enforcement code, because
correcting a run is an insert. Under B correction requires the sealed row to move, and every
mutable column is one more thing the trigger cannot freeze. The evidence is in
`test/integration/immutability.spec.ts`: the case that writes `supersedes_run_id` and
`supersede_reason` onto an already-sealed run is *expected to fail* — precisely what a
`superseded_by` column would attempt on every correction.

Where A is weaker, plainly: reverse lookup is an index scan, not a column read; branching is
unmodelled; and acyclicity holds only because `RunService` is the sole writer —
`MAX_SUPERSEDE_DEPTH` bounds a cycle's damage, it does not prevent one. The fact of correction
lives in two places, the successor's row and the `run.superseded` audit event
`RunService.supersede()` appends against the *predecessor*, so a reader consulting only the run
row misses it.

## Consequences

**Easier:** Citation stability needs no discipline from anyone. The seal trigger keeps its
five-entry allow-list with no correction-shaped exception, and a correction is idempotency-keyed,
so a retrying agent cannot fork the chain.

**Harder:** Every caller wanting "the current run" writes a traversal, and listings show
corrected runs beside their corrections — `searchSchema` in `run.controller.ts` has no filter to
exclude them, so clients dedupe by hand. `RunService.get()` pays for a second recursive query per
detail read. Branching corrections are permitted by the schema and unresolved by the API, and the
"was this corrected?" signal is a reverse lookup, easy to forget.

**To revisit:** if supersede chains stop being short — if `loadSupersedeChain()` regularly
returns more than a handful of links, or `MAX_SUPERSEDE_DEPTH` is reached — a materialised head
pointer in a *separate* table (never a column on `run`) earns its write path. Also if branching
corrections occur: two runs superseding one predecessor is legal today and meaningless to a
caller, and the fix is a constraint, not documentation.

## Action items

1. - [x] `supersedes_run_id`, `supersede_reason`, `run_supersede_reason_present`, `run_no_self_supersede` (`migrations/0004_runs.sql`)
2. - [x] No `superseded_by` column; reverse lookup served by the partial index `run_supersedes_idx`
3. - [x] `POST /v1/runs/{runId}/supersede`, idempotency-keyed, rejecting `OPEN` and `ABANDONED` predecessors
4. - [x] `run.superseded` audit event against the predecessor, carrying successor id and reason
5. - [x] Depth-bounded bidirectional chain on `RunDetail` via `loadSupersedeChain()`
6. - [x] `SEALED: ['PROCESSING']` in `RUN_TRANSITIONS` — correction is a registration, not a transition
7. - [x] Test asserting the predecessor row is byte-identical after a correction (`test/integration/immutability.spec.ts`)
8. - [ ] Viewer reads `run.supersededByRunId`, which the API never returns; render `supersededBy` (`src/viewer/public/app.js`)
9. - [ ] Search parameter excluding superseded runs, so a listing can show uncorrected records only
10. - [ ] Lineage does not mark artifacts whose `derivation.source_run_id` names a superseded run
