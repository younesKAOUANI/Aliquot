# ADR-0006: Presigned direct-to-storage upload; bytes never transit the API

**Status:** Accepted
**Date:** 2026-06-28
**Deciders:** Younes Kaouani

## Context

The artifacts this service ingests are large. A light-sheet acquisition is a few
hundred gigabytes; the PRD's operator persona describes losing a 1 TB transfer
at 900 GB. R3 requires such a transfer to be chunked, resumable from the last
completed chunk, and verified against a digest declared before any bytes move.

The API is NestJS on Node, and Node is a bad byte pump. Concretely:

- **Event loop.** Every chunk crossing the process is a JavaScript callback on
  the single loop that also serves registration, seal, chain verification and
  search — thousands per second per transfer, competing with the control plane
  rather than running beside it.
- **Backpressure.** `pipe` propagates it only if every hop honours it. One that
  does not — a transform, a tee to a hash, a logging wrapper — and the fast side
  accumulates in the external heap. At 500 GB that is an out-of-memory kill, not
  a slowdown, and it stays invisible until artifacts get big enough.
- **Occupancy.** 500 GB over a shared 1 Gbit lab link is over an hour at the
  theoretical maximum and several hours in practice, with one app instance held
  for the duration. Given `app.enableShutdownHooks()` in `src/main.ts`, a
  rolling deploy either kills that transfer at 80 percent or waits hours to
  drain, while CPU-based autoscaling sees an idle-looking pod.

Nothing is bought with that. The digest of what a client *sent* is not the claim
being made; the claim is about what the store *holds*. Got wrong, this is not a
slow endpoint — the control plane's availability becomes a function of how much
data somebody happens to be uploading.

## Decision

Clients transfer artifact bytes directly to the object store using time-boxed
presigned S3 multipart URLs minted per request by the API; artifact bytes never
pass through the API process on the client's transfer path, in either direction.
The API is a control plane that authorises, plans the part layout, records what
landed, and verifies the result.

## Options considered

### Option A: Proxy the bytes through the API

| Dimension | Assessment |
|---|---|
| Complexity | Low to write, high to operate |
| Peak memory per transfer | Bounded only by backpressure at every hop |
| API instance occupancy | Hours per large artifact |
| Resumability | Built from nothing (`Range`, tus, or bespoke) |

**Pros:** One trust boundary — no capability tokens in the wild, no CORS, no
storage endpoint reachable by clients, storage credentials never leaving the
server. The simplest possible client, one PUT to one URL. The API sees every
byte, so it could hash inline and report progress.

**Cons:** Every item in the Context section. Egress is paid twice, and idle
timeouts on every ingress must be raised to hours. Resumability, which the
object store already implements, would be rebuilt against a client population of
vendor-shipped instrument agents.

### Option B: Presigned direct-to-storage, single PUT

| Dimension | Assessment |
|---|---|
| Complexity | Lowest of the three |
| Object size ceiling | 5 GiB — a protocol limit, not a tuning knob |
| Resumability | None; a failure at 900 GB restarts at zero |

**Pros:** One signature per artifact, no session state, nothing to reconcile.

**Cons:** It fails R3 twice over. The 5 GiB ceiling excludes the normal case,
and the URL must outlive its transfer: an 800 GB PUT needs a signature valid for
hours, which is the long-lived write capability a short TTL exists to avoid. An
in-flight PUT cannot be handed a fresh URL; a resumable upload can. That is the
real reason uploads here are multipart, not chunk-level retry.

### Option C: Presigned multipart with server-side part tracking (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Three-call protocol; the part arithmetic is ours to get right |
| API cost per transfer | O(parts) HMAC signatures, zero bytes |
| URL lifetime required | One part, one hour (`STORAGE_PRESIGN_TTL_SECONDS`) |
| Observability of progress | Only what the client chooses to report |

**Pros:** The TTL stays short because `UploadService.begin` re-signs only the
outstanding parts on each call — fresh signatures, never stored ones, so no live
write capability is persisted anywhere. `upload_part` answers "resume from part
412" with one indexed read rather than a `ListParts` round trip. `planParts`
grows the part size when the configured 64 MiB default would exceed the
10,000-part ceiling, so a 640 GB-plus artifact is an ordinary upload rather than
a support ticket.

**Cons:** Three calls instead of one. The API cannot see the transfer. Abandoned
multipart uploads accrue real storage cost. `src/uploads/part-plan.ts` is a new
correctness surface where an off-by-one produces a truncated or padded object.

## Trade-off analysis

Option A was hardest to argue against, and not for the obvious reason. The
strong argument for proxying is not simplicity — it is that the bytes are
already flowing past, so the digest could be computed inline, deleting the
read-back pass in `UploadService.complete()` that is the dominant cost of ingest
at these sizes.

That argument is weaker than it looks. An inline hash proves what the API
received, not what the bucket holds, and the latter is the claim G2 makes; a
proxying design would still want a read-back to be honest, so the saving shrinks
to one leg. Against it stands occupancy, which cannot be optimised away — it is
a property of running a multi-hour byte stream inside a single-threaded process
that is also the control plane. A dedicated non-Node byte proxy answers the
runtime objection at the price of a second deployable needing its own
authorisation path, which is a presigned URL again with more moving parts.

The chosen option is weaker than A in three ways, all accepted knowingly.

**The URL is the authorisation.** Row-level security does not reach the object
store; nothing is left to check once a signature is minted, and a leaked part
URL is a live write capability against one key until it expires. That is bounded
rather than eliminated: the TTL caps at one hour by default,
`src/observability/logger.ts` redacts `uploadUrl`, `downloadUrl` and
`presignedUrl` by key, and `GET /v1/artifacts/{id}/download` answers 302 with
`cache-control: no-store` so no shared proxy caches the `Location`. The residual
risk is narrow rather than absent: the key derives from the *declared* digest
(ADR-0003), so bytes that do not hash to it are caught by the read-back and land
the run in `QUARANTINED` with an `artifact.rejected` event. The worst outcome of
a leaked upload URL is a quarantined run, not a corrupted artifact.

**The API cannot observe progress.** `upload_part` knows only what the client
bothered to POST to `/upload/parts`. A client that has uploaded 9,000 parts and
reported none is indistinguishable from one that has done nothing. There is no
stall detection without polling the store, and `upload_session.expires_at` is
time-based at seven days, not activity-based.

**Bytes do transit the API once.** `complete()` streams the stored object back
through `sha256OfStream`, so the title is a claim about the client's transfer,
not about the process. That read buffers nothing and has no client attached, but
it is still Node moving hundreds of gigabytes, and it is the first thing to move
if ingest becomes CPU-bound.

## Consequences

**Easier:** The API scales on request rate rather than data volume, so a 2 MiB
Fastify `bodyLimit` is correct rather than a compromise. Resume is a re-call of
`begin`. Deduplication skips the transfer entirely — an already-held digest
returns `alreadyPresent` and moves no bytes.

**Harder:** Clients need a three-call driver and cannot be a plain `curl -T`.
The object store endpoint must be reachable from every instrument workstation, a
network requirement the API alone did not impose. Failures land in three places
— client, store, our session rows — and reconciling them is our problem:
`finishMultipart` must distinguish "the store refused" from "the store already
did it", and settles it with `headObject` rather than by reading error text.

**To revisit:**

- A deployment where clients cannot reach object storage directly (an
  egress-filtered or air-gapped instrument network). Proxying stops being a
  choice, and the byte path must not be Node.
- Both S3 and MinIO exposing a portable full-object SHA-256 for multipart with
  identical composition rules. That removes the read-back, the main remaining
  reason bytes touch this process at all.
- A browser client uploading. Bucket CORS becomes a hard dependency and STS
  credentials scoped to a key prefix become competitive with per-part signing.
- Presigned URL leakage observed rather than reasoned about.

## Action items

1. [x] `ObjectStore` seam exposing only operations expressible as a presigned
       URL — `src/storage/object-store.ts`.
2. [x] `presignUploadPart` / `presignGet` with TTL from
       `STORAGE_PRESIGN_TTL_SECONDS` (60s–24h, default 1h).
3. [x] `upload_session` and `upload_part` in `migrations/0004_runs.sql`, with
       `upload_session_one_open_per_artifact`.
4. [x] Fresh URLs on every `begin`, capped at `MAX_PRESIGNED_PARTS = 512`; no
       signature is ever persisted.
5. [x] `planParts` grows part size past the 10,000-part ceiling rather than
       refusing the upload.
6. [x] Read-back verification via `sha256OfStream`, with a `SizeMismatchError`
       (422) short-circuit on the `headObject` size before hashing begins.
7. [x] Presigned URLs redacted by key in `src/observability/logger.ts`; download
       is a 302 with `cache-control: no-store`, never a proxied body.
8. [x] Fastify `bodyLimit` at 2 MiB, with the reason recorded at the call site.
9. [ ] `test/unit/part-plan.spec.ts` — boundary cases for `planParts` and
       `partSpan`, which the module itself says warrant exhaustive tests.
10. [ ] `test/integration/upload-integrity.spec.ts` — subclass `ObjectStore` to
        flip a byte in transit; assert `REJECTED`, `QUARANTINED` and an
        `artifact.rejected` event. The evidence for R3.
11. [ ] Integration test for resume: abandon after N parts, re-call `begin`,
        assert only outstanding parts are signed.
12. [ ] Reclaim abandoned transfers. `upload_session.expires_at` is written and
        never read; no sweep and no `AbortIncompleteMultipartUpload` rule exist.
13. [ ] A metric for sessions opened and never completed — the only available
        signal for a stalled transfer.
14. [ ] Bucket CORS and an origin allow-list, before any browser-based upload.
