# Architecture Decision Records

Every decision here had a real alternative. The rejected options are the
valuable part of each record — they are the evidence that a decision was made
rather than defaulted into.

These were written as the decisions were taken, not assembled afterwards. Where
one turned out to be wrong it is superseded rather than edited, because the
wrong turn is part of the record.

Format: [`TEMPLATE.md`](TEMPLATE.md). House rules for writing them:
[`../../CLAUDE.md`](../../CLAUDE.md).

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-idempotency-key-with-request-fingerprint-not-natural-key-upsert.md) | Idempotency key with request fingerprint, not natural-key upsert | Accepted |
| [0002](0002-shared-schema-with-row-level-security-for-tenant-isolation.md) | Shared schema with row-level security for tenant isolation | Accepted |
| [0003](0003-content-addressed-object-storage-keyed-by-sha-256.md) | Content-addressed object storage keyed by SHA-256 | Accepted |
| [0004](0004-job-queue-in-postgresql-rather-than-a-dedicated-broker.md) | Job queue in PostgreSQL rather than a dedicated broker | Accepted |
| [0005](0005-hash-chained-audit-log-in-postgresql-not-an-external-ledger.md) | Hash-chained audit log in PostgreSQL, not an external ledger | Accepted |
| [0006](0006-presigned-direct-to-storage-upload-bytes-never-transit-the-api.md) | Presigned direct-to-storage upload; bytes never transit the API | Accepted |
| [0007](0007-immutability-enforced-by-database-trigger-and-grants-not-application-code.md) | Immutability enforced by database trigger and grants, not application code | Accepted |
| [0008](0008-lineage-modelled-on-w3c-prov.md) | Lineage modelled on W3C PROV | Accepted |
| [0009](0009-jcs-rfc-8785-canonical-json-for-all-digests.md) | JCS (RFC 8785) canonical JSON for all digests | Accepted |
| [0010](0010-correction-by-superseding-record-never-by-mutation.md) | Correction by superseding record, never by mutation | Accepted |
| [0011](0011-uuidv7-for-primary-keys.md) | UUIDv7 for primary keys | Accepted |
| [0012](0012-integration-first-testing-with-testcontainers.md) | Integration-first testing with Testcontainers | Accepted |
| [0013](0013-kysely-as-the-data-access-layer-rather-than-an-orm.md) | Kysely as the data-access layer rather than an ORM | Accepted |
| [0014](0014-implement-the-job-queue-rather-than-adopting-pg-boss.md) | Implement the job queue rather than adopting pg-boss | Accepted |
| [0015](0015-audit-hash-computed-in-the-database-canonicalisation-in-the-application.md) | Audit hash computed in the database, canonicalisation in the application | Accepted |
| [0016](0016-unprivileged-noinherit-login-role-with-set-local-role-per-transaction.md) | Unprivileged NOINHERIT login role with SET LOCAL ROLE per transaction | Accepted |
| [0017](0017-tenant-scoped-rather-than-global-content-deduplication.md) | Tenant-scoped rather than global content deduplication | Accepted |
| [0018](0018-a-dependency-free-static-viewer-instead-of-an-spa-toolchain.md) | A dependency-free static viewer instead of an SPA toolchain | Accepted |
| [0019](0019-fastify-over-express-as-the-http-adapter.md) | Fastify over Express as the HTTP adapter | Accepted |
| [0020](0020-read-only-demo-access-for-a-public-deployment.md) | Read-only demo access as a separate mechanism, not a relaxed development one | Accepted (amended by 0021) |
| [0021](0021-an-ephemeral-write-sandbox-for-the-public-demo.md) | An ephemeral per-visitor tenant, so the public demo can be driven rather than watched | Accepted |

## Reading order

If you are reviewing this system and have time for four, read these:

1. **[0002](0002-shared-schema-with-row-level-security-for-tenant-isolation.md)** —
   tenant isolation, and why the deciding argument was which failure mode you
   can write a test for.
2. **[0005](0005-hash-chained-audit-log-in-postgresql-not-an-external-ledger.md)** —
   the audit chain, and an honest statement of what it does *not* protect
   against.
3. **[0004](0004-job-queue-in-postgresql-rather-than-a-dedicated-broker.md)** —
   why the reflexive Node choice (Redis + BullMQ) reintroduces the exact bug
   being avoided.
4. **[0010](0010-correction-by-superseding-record-never-by-mutation.md)** —
   the one that most shapes the API, and the one that was open longest.

## How these map to the system

| Concern | ADRs |
|---|---|
| Tenant isolation | 0002, 0016, 0017, 0021 |
| Authentication and public access | 0020, 0021 |
| Data lifetime and deletion | 0010, 0021 |
| Exactly-once ingestion | 0001, 0011 |
| Integrity of stored bytes | 0003, 0006, 0017 |
| Tamper evidence | 0005, 0007, 0009, 0015 |
| Immutability and correction | 0007, 0010 |
| Provenance | 0008 |
| Processing reliability | 0004, 0014 |
| Implementation and tooling | 0012, 0013, 0018, 0019 |
