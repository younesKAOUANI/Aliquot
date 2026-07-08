# ADR-0008: Lineage modelled on W3C PROV

**Status:** Accepted
**Date:** 2026-07-08
**Deciders:** Younes Kaouani

## Context

R6 in the PRD requires that every derived artifact record its inputs, its processor and that
processor's version, and that ancestry and descendancy be queryable back to originating
runs. Almost any schema satisfies that. The clause forcing a decision is the last: the model
must map onto a standard interchange format.

The reason is the use case rather than the schema. Provenance is recorded because somebody
asks later — a journal asking how a figure was produced, a regulator reconstructing an
analysis, two labs merging archives — and "later" is normally a context this service is not
part of. A lineage graph only this codebase can interpret dies with this codebase. That is
the failure mode: not a wrong answer, but a correct answer nobody can read in five years.

There is a second reason, worth stating plainly. Provenance is a field with an existing
vocabulary, and inventing private words for Entity, Activity and Agent tells a reader who
knows the field that the literature was not consulted.

Constraints in play when the decision was taken:

- Storage already existed: content-addressed artifact rows (`aliquot.artifact`, migration
  0004), every tenant-scoped table under `FORCE ROW LEVEL SECURITY` (ADR-0002).
- Derivation identity has to be a database constraint, because the worker's retry semantics
  depend on it (ADR-0004). An identity living in application code is not one that two
  concurrent transactions agree on.
- Traversal is a recursive CTE over relational tables; a model that makes that query awkward
  makes the primary read path awkward.
- One engineer. A second datastore is a permanent obligation.

## Decision

Lineage is stored in domain-shaped relational tables and *projected* into W3C PROV:
`aliquot.artifact` → `prov:Entity`, `aliquot.run` and `aliquot.derivation` →
`prov:Activity`, `aliquot.app_user` → `prov:Person`, `aliquot.instrument` →
`prov:SoftwareAgent`. PROV is an export vocabulary, served through the `aliquot.prov_entity`
/ `prov_activity` / `prov_agent` views and `toProvJson()` in
`src/provenance/prov-export.ts`; it is never the storage model.

## Options considered

### Option A: Bespoke lineage schema and a bespoke graph document

| Dimension | Assessment |
|---|---|
| Complexity | Lowest; the `{ nodes, edges }` document already exists |
| Interoperability | None — every consumer writes an adapter first |
| Constraint expressiveness | Full: ordinary columns and unique constraints |
| Longevity | Only as durable as this repository's documentation |

**Pros:** Nothing to map, no vocabulary to be wrong about. Attribute names are what the
domain calls things rather than `prov:` terms that nearly fit. Ships fastest.

**Cons:** The one thing provenance exists to do — outlive the system that recorded it — is
the thing it does not do. Every future consumer pays an integration cost the standard
vocabulary would have made zero, after the schema's designer has stopped answering
questions.

### Option B: PROV as the storage model

Generic `entity` / `activity` / `agent` / `relation` tables, or a triple store holding
PROV-O alongside PostgreSQL.

| Dimension | Assessment |
|---|---|
| Complexity | High: a generic quad table, or a second datastore to operate |
| Interoperability | Highest — storage *is* the interchange format |
| Constraint expressiveness | Poor; `derivation_identity_unique` is inexpressible over triples |
| Longevity | Excellent, at the price of everything else |

**Pros:** One representation, so export cannot drift from storage. SPARQL over PROV-O
answers questions this service would otherwise implement itself.

**Cons:** It gives up the guarantees. `derivation_identity_unique` on
`(tenant_id, inputs_digest, processor_name, processor_version, parameters_digest)` is the
whole of the worker's idempotency story — it lets `DerivationService.record()` insert with
`ON CONFLICT DO NOTHING` and report a collision as `created: false` rather than a failed
job. That has no equivalent over a triple table. RLS degenerates too: a generic relation
table needs one blanket policy covering every relationship kind. A second datastore also
reintroduces the dual write ADR-0004 exists to avoid.

### Option C: Domain-shaped storage with a PROV projection

| Dimension | Assessment |
|---|---|
| Complexity | Moderate: one extra mapping, no extra storage |
| Interoperability | Good at the boundary, absent internally |
| Constraint expressiveness | Full |
| Longevity | The exported document is standard; the tables are ours |

**Pros:** Keeps `derivation_identity_unique`, per-table RLS policies, and
`aliquot.artifact_ancestors` / `artifact_descendants` as plain SQL. The projection is views,
not a materialisation, so there is no second copy of the truth to go stale.

**Cons:** The mapping exists twice — in the views in migration 0006 and in TypeScript in
`prov-export.ts` — and nothing forces them to agree. Some PROV constructs have no home:
`derivation_input.role` is `prov:qualifiedUsage` in spirit but ships as a plain `prov:role`
attribute.

## Trade-off analysis

Option A was the hardest to argue against, and for a while it was winning. The service
already returns a lineage document that is complete, typed and consumed by the viewer; PROV
adds a prefix block, blank-node identifiers for relations, and the discipline of expressing
anything domain-specific as a namespaced attribute rather than a field. Measured against
today's only consumer — a static page in `src/viewer/` — that is pure cost.

It lost because today's only consumer is the wrong horizon for this feature. Every other
guarantee here is verifiable now: the audit chain verifies or it does not, the RLS policies
hold or a test catches them. Provenance is the one guarantee realised entirely in the
future, by someone who is not here. The standard vocabulary is paid for once, by me; a
private one is paid for repeatedly, by everyone else.

Option B lost on a narrower point. It is the only option where storage and interchange
cannot disagree, which is the advantage Option C gives up. But provenance that is standard
and wrong is worse than provenance that is proprietary and right, and the correctness here
comes from constraints a triple model cannot express: trading `derivation_identity_unique`
for SPARQL trades a guarantee for a query language.

The honest weakness of the chosen option is that duplicated mapping. `toProvJson()` builds
from the in-memory `LineageGraph`, not from `aliquot.prov_entity`; the two agree only
because `provId()` in `src/provenance/lineage-graph.ts` mints the same
`aliquot:artifact/<uuid>` strings the views do, and that agreement is convention rather than
compilation. Second: interoperability is partly nominal. The graph structure is standard,
but digests, processor versions and parameters live in the `aliquot:` namespace, so a
generic consumer gets the shape of the answer and not its substance. That is inherent to
PROV — a framework for domain vocabularies, not a replacement for one — but it should not
be overstated as "any tool can read our provenance".

## Consequences

**Easier:** Export is a pure function over an already-assembled graph, so
`GET /v1/artifacts/{id}/lineage.prov.json` is a second serialisation of one traversal, not a
second code path. Naming discipline is inherited: an instrument as `prov:SoftwareAgent` and
an operator as `prov:Person` keeps "which machine" and "which person" apart by construction.

**Harder:** Two definitions of one mapping. Relations get per-document blank-node
identifiers (`_:used1`), so two exports of overlapping graphs cannot be merged without
deduplicating relations by their endpoints. `wasDerivedFrom` is emitted for every
(output, input) pair, quadratic in fan-in times fan-out — redundant with `used` plus
`wasGeneratedBy`, and emitted anyway because it is the relation a consumer actually reads.

**To revisit:** When a real external consumer appears, the duplicated mapping stops being
theoretical and becomes a defect worth paying to remove. If a consumer needs RDF, add a
Turtle serialisation rather than changing storage. If graphs exceed a few thousand nodes the
recursive CTE becomes a materialised closure (ARCHITECTURE.md, scaling notes) — that changes
traversal, not this decision. Only a requirement to *ingest* third-party PROV documents
reopens Option B.

## Action items

1. [x] Derivations as PROV activities: `aliquot.derivation`, `derivation_input` (with
   `role`), `derivation_output` (with `logical_name`), migration 0006.
2. [x] Identity in a constraint, not code: `derivation_identity_unique`, relied on by
   `DerivationService.record()`.
3. [x] Traversal as SQL: `aliquot.artifact_ancestors` / `artifact_descendants`, depth-capped
   at 32 as a cycle guard.
4. [x] Publish the projection as views: `prov_entity`, `prov_activity`, `prov_agent`, all
   `WITH (security_invoker = true)`.
5. [x] Prove the views cannot leak across tenants: `scripts/lint-migrations.ts` rejects a
   view without `security_invoker`, and `test/integration/isolation.spec.ts` asserts
   "declares every view with security_invoker" over `pg_class.reloptions`.
6. [x] Serve PROV-JSON: `toProvJson()`, `GET /v1/artifacts/{artifactId}/lineage.prov.json`.
7. [x] One identifier convention shared by views and export: `provId()`.
8. [x] Report truncation explicitly, so a capped traversal is distinguishable from a lineage
   that genuinely ends: `LineageGraph.truncated`, `LineageService.hasMoreBeyond`.
9. [ ] Add `test/integration/lineage.spec.ts`: ancestry to originating run, descendancy,
   root attribution via `first_seen_run_id`, `truncated` at the cap, and that every
   identifier a relation names is declared in the same document.
10. [ ] Validate exports with an external PROV implementation in CI, so "interoperable" is a
   test result rather than a claim.
11. [ ] Remove the duplicated mapping: either `toProvJson()` reads the `prov_*` views, or the
   views are dropped in favour of the export function.
12. [ ] Emit `prov:qualifiedUsage` for `derivation_input.role` and `prov:qualifiedAssociation`
   with the processor version as a `prov:Plan`.
13. [ ] Stable relation identifiers so overlapping exports can be merged. Deferred until a
   consumer needs it.
