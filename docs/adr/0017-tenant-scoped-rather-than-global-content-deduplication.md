# ADR-0017: Tenant-scoped rather than global content deduplication

**Status:** Accepted
**Date:** 2026-07-11
**Deciders:** Younes Kaouani

## Context

PRD R3 requires identical content to occupy storage once, and ADR-0003 keys every object by
a pure function of its SHA-256. What neither settled is the namespace the "have I seen these
bytes before?" question ranges over — and that had to be fixed in `0004_runs.sql`, because
it is the shape of a unique constraint on `aliquot.artifact`.

The question stopped being about storage once the upload path was written. When a manifest
entry declares a digest the service already holds, `UploadService.bindExistingArtifact`
binds the existing row, writes an `artifact.deduplicated` audit event, and returns
`AlreadyPresentResult` — no session, no presigned URLs, no bytes. For a 40 GB reference
stack that is an hours-long transfer replaced by a database round trip. So
`POST /v1/runs/{runId}/artifacts/{name}/upload` is a direct existence test over whatever
namespace that lookup covers, and the timing carries it alone: an attacker needs a
stopwatch, not the response body.

Tenants here are separate research organisations. A digest is not secret, but it is
guessable exactly when the file is guessable — a published dataset at a known version, a
genome reference at a known patch, a figure circulated in draft. A shared namespace is
therefore a confirmation oracle, and confirmation is the half that matters: "does
organisation B hold this exact file" is a question about their pipeline, their
collaborations, and occasionally about a consent scope narrower than either party. What
breaks here is not availability or integrity, but one customer learning something true
about another's unpublished work from an API working as designed.

## Decision

Deduplication is scoped to the tenant. `aliquot.artifact` carries
`constraint artifact_digest_unique_per_tenant unique (tenant_id, digest)` rather than a
unique index on `digest` alone, and every existence check filters `tenant_id` before
`digest`. The service never answers a question about a digest the caller's tenant does not
already hold.

## Options considered

### Option A: Tenant-scoped deduplication (chosen)

| Dimension | Assessment |
|---|---|
| Existence oracle | None across tenants — the lookup cannot see the rows |
| Bytes stored per digest | One object; the key has no tenant prefix (ADR-0003) |
| Redundant transfer | Once per tenant per digest, for shared reference material |
| Authorization model | Unchanged; RLS already scopes `artifact` |

**Pros:** The mechanism is a unique constraint and a `where tenant_id =`. Because
`storageKeyForDigest()` derives the key from the digest alone, the physical saving survives
anyway: identical content is one object, and the second tenant's upload overwrites it with
itself.

**Cons:** Every tenant pays the transfer and the read-back hash for shared reference
material once. It removes the cross-tenant oracle from the API, not from the bucket.

### Option B: Global deduplication with a shared digest namespace

| Dimension | Assessment |
|---|---|
| Existence oracle | Direct, and observable through timing alone |
| Bytes stored per digest | One object |
| Redundant transfer | None |
| Authorization model | Undefined — the row is nobody's |

**Pros:** Strictly the best storage and bandwidth outcome, on the simpler constraint
`unique (digest)`.

**Cons:** Tenant A can test any digest against tenant B's holdings, free, through a
documented endpoint. It also breaks ADR-0002: a row visible to every tenant cannot carry a
`tenant_isolation` policy, so the table mapping content to storage would be the one table
outside the boundary.

### Option C: Global deduplication with per-tenant access control lists over shared objects

| Dimension | Assessment |
|---|---|
| Existence oracle | Suppressed only if the ACL check precedes the answer |
| Bytes stored per digest | One object |
| Redundant transfer | Not avoided — a tenant without a grant still uploads |
| Authorization model | A second one, over objects, that no RLS policy can express |

**Pros:** Keeps the saving while making sharing explicit rather than incidental, and is the
honest foundation for cross-study references (PRD R14).

**Cons:** The saving it protects is one this deployment already has for free. Once the ACL
check runs before the answer, an ungranted tenant is told nothing and uploads the bytes —
Option A's behaviour, reached through an entitlement table, a grant lifecycle, and a
revocation path that must invalidate presigned URLs already issued.

### Option D: No deduplication at all

| Dimension | Assessment |
|---|---|
| Existence oracle | None |
| Bytes stored per digest | One object per binding |
| Redundant transfer | Every time |
| Deletion story (R15) | Trivial — one object, one owner |

**Pros:** No shared ownership anywhere, so retention and legal hold become per-run
operations with no reference counting.

**Cons:** Fails R3, and discards the case that motivated content addressing — the same
calibration file attached to four hundred runs, which is the ordinary shape of instrument
output.

## Trade-off analysis

Option C was hardest to argue against, and it lost on a fact about this system rather than on
principle. Its advantage over A is the storage saving, and A already has it, because ADR-0003
keys objects by digest with no tenant prefix: the two options store the same bytes. What C
additionally buys is avoiding a redundant *transfer*, and only for a tenant granted access to
content it never uploaded. For everyone else it behaves exactly like A while costing a grant
model, a revocation path, and a second authorization surface below the one RLS covers.

Quantify what is given up. Acquisition data does not duplicate across tenants: an
instrument emits bytes no other instrument will emit, so that intersection is empty in
practice. Duplication is confined to material distributed to both parties — calibration
stacks, genome references and their indices, standard panels. That set is bounded, roughly
constant per tenant, and measured in tens of gigabytes against ingest measured in hundreds
per run. The waste is `O(tenants × reference set)` rather than a fraction of total volume,
and it is paid as one extra transfer and read-back hash per tenant per digest, not as
duplicated storage.

Where A is weakest: it removes the oracle from the API, not from the world. RLS stops at
the database (ADR-0002) and the bucket is one flat namespace, so anyone obtaining a broad
read on it can test digests directly.

The sharper residual is intra-tenant. `begin` authorises the caller against the run's study,
and `bindExistingArtifact` then searches the whole tenant. A user holding `operator` on one
study can declare a guessed digest, learn from the `alreadyPresent` response that the tenant
holds it, and — because the bind makes the artifact reachable from their own run — pass
`requireAnyStudyRole` on the download. That is recorded rather than claimed away.

Content addressing carries the integrity property regardless of dedup scope: the digest is
verified against the stored bytes by `sha256OfStream` on completion, and the key is a
function of the verified digest.

## Consequences

**Easier:** Deduplication is one constraint and one predicate; `aliquot.artifact` stays an
ordinary table under `apply_tenant_rls('artifact')` with no exemption to argue. Concurrent
identical uploads are absorbed by `onConflict(['tenant_id','digest']).doNothing()` and both
callers bind the winning row.

**Harder:** A tenant onboarding onto an instrument re-uploads its reference set, and there is
no supported way to seed it. A digest present under two tenants has two `artifact` rows with
different ids, so any future sharing feature must treat digest, not artifact id, as the
identity of content. Deletion (R15) is harder than the row count suggests: the rows are per
tenant, the object is not.

**To revisit:** R14. Global dedup with explicit grants becomes right when three things hold:
a customer asks for sharing by name, so the grant has a subject rather than being
incidental; the existence answer is gated on a grant check that runs first and is uniform in
timing; and reference counting exists, since a shared object without one makes deletion a
silent corruption of someone else's run. Also revisit if cross-tenant duplicated bytes ever
exceed a low single-digit percentage of stored volume — that would mean the estimate above
was wrong about the data.

## Action items

1. - [x] `artifact_digest_unique_per_tenant unique (tenant_id, digest)` in `0004_runs.sql`, with the reasoning in the migration.
2. - [x] `bindExistingArtifact` filters `tenant_id` before `digest`; no lookup in `src/` ranges over digests globally.
3. - [x] Same digest, differing declared size raises `SizeMismatchError` (422) and binds nothing.
4. - [x] `artifact.deduplicated` audit event, so a skipped transfer is still an event in the chain.
5. - [x] `test/integration/immutability.spec.ts` asserts both halves: a duplicate within a tenant violates the constraint, the same digest under two tenants yields two rows.
6. - [ ] Confine the lookup to studies the caller holds a role in, or record the intra-tenant oracle as accepted.
7. - [ ] Measure cross-tenant digest overlap on real data before R14 is scoped.
8. - [ ] Reference counting over `storage_key`, as a precondition for R15.
