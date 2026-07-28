# Aliquot — Product Requirements

**Instrument Run Ingestion & Provenance Service**

| | |
|---|---|
| **Status** | v1.0 — M0–M7 complete |
| **Owner** | Younes Kaouani |
| **Last updated** | 2026-07-29 |

> *Aliquot*: a measured portion taken from a larger sample.

Companion documents: [ARCHITECTURE.md](ARCHITECTURE.md) for the technical design,
[adr/](adr/) for the decisions and their rejected alternatives.

---

## 1. Scope

Aliquot is **infrastructure, not science**. It does not analyse images, model
molecules, or interpret results. It solves the problem sitting underneath all of
those: getting data off instruments and into a research data platform without
losing track of where any of it came from.

---

## 2. Problem statement

Research labs generate data from instruments — microscopes, sequencers, plate
readers, mass spectrometers — at volumes that outpace the informal processes
used to manage them. A single lightsheet microscope session can produce
terabytes across thousands of files. The prevailing practice is a network share,
a folder naming convention, and institutional memory.

This fails in three specific ways:

1. **Ingestion is unreliable.** Instrument software retries on network failure.
   Operators re-run uploads they think failed. The result is duplicated runs,
   partial runs indistinguishable from complete ones, and silent corruption that
   surfaces months later during analysis.
2. **Provenance is lost.** Given a figure in a paper or a decision in a program,
   there is often no mechanical way to answer *which raw acquisition produced
   this, on which instrument, by whom, processed with which version of which
   code*. Reproducibility becomes archaeology.
3. **The record is not defensible.** In a regulated or audited environment,
   "we're fairly sure this file wasn't modified" is not an answer. Data
   integrity has to be demonstrable, not asserted.

The cost of not solving it compounds: analysis built on unverifiable inputs,
results that cannot be reproduced, and — where the work touches a regulatory
submission — findings that cannot be defended.

---

## 3. Goals

| # | Goal | How we know it succeeded |
|---|---|---|
| G1 | Ingestion is exactly-once from the caller's perspective | A run submitted N times with the same idempotency key produces exactly one run record and N identical responses |
| G2 | Every stored byte is integrity-verified | Every artifact's stored digest matches the digest declared by the producer; mismatches quarantine the run rather than being accepted |
| G3 | Any output can be traced to its inputs mechanically | For any artifact, the full ancestry — back to originating run, instrument, operator, and processor version — is retrievable in a single API call |
| G4 | Tampering is detectable, not merely discouraged | Any post-hoc modification of an audited record is detected by chain verification, which names the specific broken link |
| G5 | Data is isolated between studies by construction | A caller scoped to study A cannot read study B's data even given a bug in application-layer authorization |

---

## 4. Non-goals

| Non-goal | Why |
|---|---|
| **Being a LIMS or ELN** | Sample management, experiment planning, and lab workflow are large, well-served product categories. This service sits underneath them and integrates via API. |
| **Scientific analysis of any kind** | No image segmentation, no base calling, no feature extraction beyond a deliberately trivial demonstration worker. Domain analysis is a different competency and faking it is transparent. |
| **Formal GxP / 21 CFR Part 11 validation** | The system is *designed against* those principles and can be validated, but validation is an organizational process involving qualification protocols and signed evidence, not a code property. Claiming otherwise would be dishonest. |
| **Electronic signatures workflow** | Genuinely required in a regulated deployment, genuinely out of scope for v1. The audit model is designed so signatures can attach to audit events later without restructuring. |
| **Petabyte-scale storage engineering** | The design accounts for large objects and documents where it would break, but tiering, lifecycle policy, and cold archive are deployment concerns rather than service concerns. |
| **A rich end-user UI** | A minimal read-only viewer exists to make the lineage graph and audit chain legible. Anything more competes for effort with the part that matters. |

---

## 5. Personas and user stories

### Instrument Operator — runs the machine, uploads the output

- As an instrument operator, I want run submission to be safe to retry, so that
  a network failure mid-upload does not create a duplicate run or leave me
  unsure whether to resubmit.
- As an instrument operator, I want to resume an interrupted upload from where
  it stopped, so that a dropped connection at 900 GB of a 1 TB transfer does not
  cost me the whole transfer.
- As an instrument operator, I want a clear signal that a run is complete and
  verified, so that I know when it is safe to clear local storage on the
  acquisition workstation.
- *(Edge case)* As an instrument operator, when an artifact fails checksum
  verification, I want the run marked as quarantined and the specific artifact
  named, so that I re-upload only what is broken.

### Research Scientist — consumes the data

- As a research scientist, I want to find all runs for my study filtered by
  instrument and date, so that I can assemble an analysis cohort without asking
  a colleague where things were saved.
- As a research scientist, I want to see the complete ancestry of any derived
  artifact, so that I can state precisely what a result was computed from.
- As a research scientist, I want to know which version of which processor
  produced a derived artifact, so that I can reproduce or invalidate downstream
  conclusions when a processing bug is found.

### Data Steward / QA — accountable for the record

- As a data steward, I want an append-only audit trail of every state change
  with actor, timestamp, and before/after state, so that I can reconstruct what
  happened without relying on application logs.
- As a data steward, I want to verify the integrity of the audit trail on
  demand, so that I can demonstrate the record has not been altered rather than
  assert it.
- As a data steward, I want study-level access boundaries enforced at the
  database layer, so that isolation does not depend on every endpoint getting
  authorization right.

### Platform Engineer — integrates downstream

- As a platform engineer, I want a reliable event stream of run lifecycle
  transitions, so that downstream pipelines trigger on sealed runs without
  polling.
- As a platform engineer, I want processing to be safely re-runnable, so that a
  worker crash or a redeploy mid-job does not produce duplicate derived
  artifacts.

---

## 6. Requirements

### P0 — Must have

**R1. Idempotent run registration**

A run is registered with a caller-supplied idempotency key. Replays return the
original result.

- [x] Given a run submitted with idempotency key `K` and body `B`, when the
      identical request is repeated, then the original response is returned with
      the original resource identifier and no second run is created
- [x] Given key `K` was used with body `B`, when a request arrives with key `K`
      and a materially different body, then the request is rejected with
      `409 Conflict` and an error naming the mismatch
- [x] Given two identical requests arrive concurrently, then exactly one run is
      created and both callers receive the same response
- [x] Idempotency records expire on a documented retention window, and expiry
      behaviour is specified rather than incidental

**R2. Declared-then-uploaded artifact model**

A run declares its expected artifacts before uploading them, so completeness is
checkable rather than assumed.

- [x] A run manifest declares each artifact by logical name, expected size, and
      expected SHA-256 digest
- [x] A run cannot be sealed while any declared artifact is missing or unverified
- [x] Artifacts not declared in the manifest are rejected on upload

**R3. Resumable, integrity-verified upload**

- [x] Uploads are chunked and resumable; an interrupted transfer resumes from
      the last completed chunk
- [x] On completion, the computed digest is compared against the declared digest
- [x] On digest mismatch, the artifact is rejected, the run transitions to
      `QUARANTINED`, and an audit event records the failure
- [x] Storage is content-addressed: two artifacts with identical content occupy
      storage once

**R4. Run lifecycle with an immutability boundary**

- [x] The run state machine is explicit and every transition is validated
- [x] Sealing is the immutability boundary: after `SEALED`, run metadata and
      artifact bindings cannot be modified
- [x] Immutability is enforced at the database layer, not only in application code
- [x] Correction after sealing is by superseding record, never by mutation; the
      superseded run remains retrievable

**R5. Hash-chained audit trail**

- [x] Every state-changing operation appends an audit event capturing actor,
      action, target, timestamp, and payload digest
- [x] Each event includes the hash of its predecessor, forming a per-tenant chain
- [x] Audit events are insert-only; `UPDATE` and `DELETE` privileges are not
      granted to the application role
- [x] A verification endpoint walks the chain and returns either a clean result
      or the sequence number of the first broken link
- [x] Timestamps are server-authoritative; client-supplied times are recorded as
      a separate declared field, never as the audit time

**R6. Lineage**

- [x] Every derived artifact records its input artifacts, the processor name,
      and the processor version
- [x] A lineage endpoint returns full ancestry for any artifact, back to
      originating runs
- [x] A lineage endpoint returns full descendancy — everything derived from a
      given artifact
- [x] The lineage model maps onto W3C PROV concepts (Entity / Activity / Agent)
      so it can be exported to a standard interchange format

**R7. Multi-tenancy and authorization**

- [x] Every domain row carries a tenant identifier
- [x] Isolation is enforced by row-level security in the database, so an
      application-layer bug cannot leak across tenants
- [x] Roles are at minimum: operator (write runs), scientist (read), steward
      (read + audit verify), admin (manage instruments and members)
- [x] Instruments authenticate as first-class machine clients, distinct from
      human users

**R8. Reliable processing dispatch**

- [x] Sealing a run enqueues processing work in the same database transaction as
      the state change — no dual-write
- [x] Workers are idempotent: re-processing the same input with the same
      processor version does not create a duplicate derivation
- [x] Failed jobs retry with backoff and land in a dead-letter state with the
      failure reason retained

### P1 — Should have

- [x] **R9. Search.** Filter runs by study, instrument, operator, state, and
      acquisition date range, with cursor pagination.
- [x] **R10. Periodic chain checkpointing.** Chain head digests are periodically
      written to a location outside the primary database, closing the gap where
      an actor with full database access could rewrite the chain and its
      verification data together.
- [x] **R11. Read-only lineage viewer.** A minimal UI rendering the provenance
      graph and audit chain. Its job is to make the demo legible, not to be a
      product.
- [x] **R12. OpenAPI specification** served from the service, with a browsable
      client.

### P2 — Future considerations (designed for, not built)

- **R13. Electronic signature attachment.** Audit events are modelled so a
  signature record can reference an event digest without schema change.
- **R14. Cross-study artifact references.** Content-addressed storage already
  permits it; the authorization model would need explicit grant semantics. See
  [ADR-0017](adr/0017-tenant-scoped-rather-than-global-content-deduplication.md).
- **R15. Retention and legal hold.** Deletion is deliberately absent from v1.
  When added, it must be tombstone-based so the audit chain survives.
- **R16. Federated instrument agents.** An on-premise agent that watches an
  acquisition directory and pushes autonomously.

---

## 7. Success criteria

For a service rather than a consumer feature, "success metrics" are system
properties, verified by tests rather than by analytics. Each row below maps to a
suite in `test/integration/`.

| Property | Verification | Status |
|---|---|---|
| Exactly-once registration under concurrency | `idempotency.spec.ts` fires eight concurrent identical requests; asserts one row and identical responses | Automated |
| Tampering is always detected | `audit-chain.spec.ts` mutates rows via a privileged connection; verification names the exact sequence number | Automated |
| Isolation holds under application bugs | `isolation.spec.ts` issues deliberately unscoped queries as a tenant-scoped role, across every table in the catalogue; asserts zero rows | Automated |
| Sealed records cannot be altered | `immutability.spec.ts` attempts every column via a superuser connection | Automated |
| Corruption is always caught | `scripts/demo.ts` and `scripts/seed.ts` upload a corrupted artifact and assert the run quarantines naming it | Script only — a dedicated byte-flip suite against MinIO is the next test to write |
| Processing is re-runnable | `scripts/seed.ts` waits on real processing; derivation identity is enforced by a unique constraint | Script only — worker crash and redelivery need a dedicated suite |
| No partial run is ever sealed | Enforced by `seal()` re-deriving the manifest digest and refusing on any unverified entry | Not yet asserted at every intermediate manifest state |

---

## 8. Resolved questions

These were open during design. Both were blocking, and both are recorded here
with the reasoning rather than being quietly settled in code.

**Does the audit chain cover artifact bytes, or only metadata?**
*Resolved: metadata only.* The chain covers the declared digest, which is itself
a commitment to the bytes. Hashing terabytes on every chain verification would
make verification an operation nobody runs, and a verification nobody runs is
not a control. Byte-level verification is a separate on-demand operation against
content-addressed storage. See
[ADR-0003](adr/0003-content-addressed-object-storage-keyed-by-sha-256.md).

**Superseding vs. amending sealed runs — new identifier or new version under a
stable identifier?**
*Resolved: new identifier, with `supersedes_run_id` pointing backwards.* An
external citation — a figure in a paper, a row in a downstream warehouse — must
keep pointing at exactly the bytes it cited. A version under a stable identifier
silently changes what a reference means when a correction lands, which is the
precise failure this system exists to prevent. Full reasoning and the cost of
this choice in
[ADR-0010](adr/0010-correction-by-superseding-record-never-by-mutation.md).

**Does the demo worker do anything real?**
*Resolved: yes, deliberately small.* Two processors ship: `checksum-manifest`
emits a byte-deterministic manifest of the run, and `metadata-extract` reads
structural metadata from formats it recognises by magic bytes. Both are real
work; neither pretends to be science. A `sleep` would have demonstrated the
dispatch machinery equally well and been less convincing about it.

**Which instrument metadata schema to model against?**
*Resolved: none, for now.* The `run.protocol` column stores the producer's own
metadata as JSONB, unmodelled. OME-XML is the obvious candidate for imaging and
inventing a lossy subset of it would be worse than storing the original and
indexing what is actually queried. Revisit when a second instrument class is
onboarded and the shared query surface becomes visible.

---

## 9. Phasing

Milestone-based. Each milestone had a definition of done and was independently
demonstrable. No milestone started before its predecessor's DoD was met.

| Milestone | Scope | Definition of done | Status |
|---|---|---|---|
| **M0 — Skeleton** | Service scaffold, Docker Compose, migrations, CI, Testcontainers harness | `docker compose up` yields a running service with a green integration test against a real database | Done |
| **M1 — Identity & tenancy** | Tenants, studies, users, instruments, roles, RLS policies | Isolation test passes: a tenant-scoped role cannot read another tenant's rows even with an unscoped query | Done |
| **M2 — Idempotent registration** | Run creation, idempotency keys, manifest declaration, state machine | R1 and R4 acceptance criteria pass, including the concurrency case | Done |
| **M3 — Upload & integrity** | Chunked resumable upload, content-addressed storage, digest verification, quarantine | R3 passes; corrupted-chunk test quarantines correctly | Done |
| **M4 — Audit chain** | Append-only events, hash chaining, verification endpoint, insert-only grants | Tamper test names the exact broken sequence number | Done |
| **M5 — Processing & lineage** | Transactional enqueue, idempotent worker, derivation records, lineage queries | R6 and R8 pass; a derived artifact returns full ancestry | Done |
| **M6 — Surface** | OpenAPI, search, read-only viewer, seeded demo dataset | A cold `docker compose up` reaches a demo-ready state with data present | Done |
| **M7 — Evidence** | ADRs finalized, README as design doc, demo script | A stranger can understand the system's purpose and key decisions in ten minutes without reading code | Done |

**Parking lot:** federated agents, retention policy, e-signatures, OME-XML deep
modelling, cross-study references, S3 lifecycle tiering.
