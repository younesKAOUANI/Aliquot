# ADR-0003: Content-addressed object storage keyed by SHA-256

**Status:** Accepted
**Date:** 2026-06-27
**Deciders:** Younes Kaouani

## Context

An imaging run is a directory tree and the sizes are not moderate: one
light-sheet acquisition is a few hundred gigabytes. The same reference and
calibration files ship with every run on a given instrument — one 40 GB stack
attached to four hundred runs is the ordinary case, not an edge case.

Bytes never pass through the API process (ADR-0006); the client is handed a
presigned URL and writes to the store directly. That constrains the key more
than it first appears: it must be chosen *before* any byte moves, be
reproducible on a retry arriving days later, and be recomputable at download
time from the artifact row alone. PRD R2 already has the manifest declaring each
artifact by logical name, size and SHA-256 before upload, so a digest is in hand
at exactly that moment; R3 requires the digest be checked on completion and
identical content occupy storage once.

What breaks if this is got wrong: a key derived from anything mutable — run id,
logical name, upload time — makes a retried write produce a second object, so a
crashed worker leaves orphans nothing can reconcile, and storage grows with the
number of bindings rather than the amount of distinct data.

## Decision

Every object this service stores is keyed by a pure function of its SHA-256:
`sha256/<first two hex>/<next two hex>/<full digest>`, produced by
`storageKeyForDigest()` in `src/common/digest.ts`. Objects and their
`aliquot.artifact` rows are immutable once written, and deduplication is by
`(tenant_id, digest)` — within a tenant, never across tenants.

## Options considered

### Option A: Key derived from the content digest (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | One pure function; no key table, no allocator |
| Deduplication | Free, by construction |
| Write idempotence | Identical bytes land at the identical key; a retry overwrites an object with itself |
| Deletion / GC | Hard: an object is referenced by an unknown number of rows |

**Pros:** The key is derivable from the digest alone, which is why
`UploadService.downloadUrl` can call `storageKeyForDigest(view.digest)` with
nothing else in hand. Writes become idempotent without a lock: the processing
tier writes processor outputs *before* the transaction referencing them, so a
rollback leaves an unreferenced object rather than a row pointing at bytes never
stored. Deduplication is the unique constraint
`artifact_digest_unique_per_tenant` and nothing more. The two-level fan-out is
not for S3's benefit — it stopped needing prefix sharding years ago — but for
filesystem-backed stores and for every human who lists this bucket.

**Cons:** Reference counting is deferred, not solved; v1 has no deletion at all
(PRD R15), which is the only reason that is survivable. Two tenants holding
identical bytes hold one object.

### Option B: Opaque key per manifest entry (`runs/<run_id>/<logical_name>`)

| Dimension | Assessment |
|---|---|
| Complexity | Lower; no digest needed at key time |
| Deduplication | None, unless a separate digest index is built and maintained |
| Write idempotence | Per manifest entry only |
| Deletion / GC | Trivial — one object, one owner |

**Pros:** The bucket is legible without the database. Retention and legal hold
are straightforward because ownership is one-to-one.

**Cons:** Fails R3's storage clause outright. Correcting one file rewrites the
whole run, and correction is by superseding record (ADR-0010), so that is the
normal path. Recovering deduplication later means a digest-to-key table — a
content-addressed store with an extra hop and a consistency problem.

### Option C: Content-addressed with a tenant prefix (`t/<tenant_id>/sha256/ab/cd/…`)

| Dimension | Assessment |
|---|---|
| Complexity | Same function, one more argument at every call site |
| Deduplication | Per tenant, matching the logical model exactly |
| Isolation risk | Lowest; no object shared between tenants |
| Deletion / GC | Refcount confined to one tenant |

**Pros:** Physical layout matches the logical one. Deleting a tenant is a prefix
delete. No retention action can touch another tenant's bytes.

**Cons:** Identical content held by two tenants is stored twice. The key stops
being a function of the digest and becomes a function of a pair.

## Trade-off analysis

Option B was never close: it loses deduplication, a stated acceptance criterion,
and forces a full re-upload on every correction.

Option C was hard to argue against and is where this decision is weakest. It
gives everything A gives, plus physical separation and a tractable deletion
story. It lost on two grounds and only one is strong. The strong one: A retains
cross-tenant *physical* deduplication — a vendor's reference stack is stored
once for the deployment — while the observable namespace stays per tenant,
because the only existence check there is, `UploadService.bindExistingArtifact`,
filters on `tenant_id` before digest. A global lookup would turn the response
into an oracle: "already present" for a digest this tenant never uploaded says
another tenant holds that file, which here may be an unpublished result
(ADR-0017). The weak ground was call-site convenience, which is not an argument
and is recorded as one that was made.

That cost is deferred, not avoided. When retention or legal hold lands (R15),
deleting an object for tenant A may destroy bytes tenant B's rows reference. The
hedge is that `aliquot.artifact.storage_key` is stored rather than recomputed:
objects already written keep their original key, so a later move to Option C's
layout does not rewrite history.

The second weakness is the digest itself: it is computed by the client. On
completion, `UploadService.complete` re-reads the assembled object through
`ObjectStore.openReadStream` and hashes it in one streaming pass
(`sha256OfStream`), counting bytes independently of `Content-Length`. Be precise
about what that buys: it proves the stored bytes hash to the digest the producer
*declared*. It catches every transport failure — a truncated part, a flipped
bit, a proxy that recompressed something — and it makes the guarantee
falsifiable, since a mismatch raises `DigestMismatchError` (422,
`https://aliquot.dev/problems/digest-mismatch`), quarantines the run and appends
`artifact.rejected`. It does not prove the declaration honest: digest and bytes
come from the same party over the same channel, so a producer that hashed
different bytes than it sent is not detected. Closing that means hashing at
acquisition on the instrument — a different trust boundary and a different piece
of software (R16).

The re-read is not cheap: one extra full read of every ingested byte, the
dominant cost of ingest. The store's entity tag is no substitute — a multipart
ETag is the MD5 of the concatenated part MD5s with the part count appended, and
its value depends on how the client chunked the upload.

Deduplication carries its own residual risk. `bindExistingArtifact` binds on the
*declared* digest without moving bytes, so a caller who learns a digest obtains
the content by declaring it. RLS confines that to their tenant and the
`operator`/`admin` roles gate it, but within a tenant, knowing a digest is
functionally knowing the content.

## Consequences

**Easier:** Deduplication is a unique constraint, not a subsystem. Retries are
safe everywhere. Artifacts are trivially immutable — `reject_artifact_mutation()`
refuses every UPDATE and DELETE on `aliquot.artifact`, and nothing it refuses
could have been legitimate. Lineage is acyclic by construction.

**Harder:** Deletion; nothing in v1 removes an object, and whatever does needs a
reference count spanning tenants. Debugging by bucket listing, since keys carry
no run, name or tenant. Ingest permanently carries a second full read of every
byte.

**To revisit:** when deletion, retention or legal hold enters scope (R15); when
a tenant requires that its bytes share no object with another's, which means
Option C's prefix for new writes; or when instrument-side hashing (R16) ships,
at which point read-back stops being the only integrity check and its cost
becomes arguable rather than mandatory.

## Action items

- [x] `aliquot.sha256_hex` domain, defined once in
      `migrations/0001_foundation.sql`.
- [x] `storageKeyForDigest()` with the two-level fan-out, covered by
      `test/unit/digest.spec.ts` ("fans out two levels from the digest prefix",
      "is a pure function of the digest", "refuses a malformed digest").
- [x] `artifact_digest_unique_per_tenant` in `migrations/0004_runs.sql`, proven
      per-tenant by "deduplicate within a tenant by digest" and "do not
      deduplicate across tenants" in `test/integration/immutability.spec.ts`.
- [x] `artifact_no_update` trigger plus `revoke update, delete, truncate` on
      `aliquot.artifact` from `aliquot_app` and `aliquot_worker`.
- [x] Re-read and rehash on completion, recorded in the `artifact.verified`
      payload as `verifiedBy: 'read-back-sha256'` so the trail says how the
      claim was established, not merely that it was made.
- [x] Dedup path moves no bytes and emits `artifact.deduplicated`.
- [x] Processor outputs share the addressing via `upsertArtifact()`, with
      `onConflict(...).doNothing()` because the trigger forbids `DO UPDATE`.
- [ ] Reference counting or tombstones for `aliquot.artifact`, required before
      any deletion path exists (R15).
- [ ] A reconciliation job reporting objects with no artifact row; an aborted
      multipart upload leaves bytes nothing points at.
- [ ] Emit the read-back duration as a metric, not only a log line.
