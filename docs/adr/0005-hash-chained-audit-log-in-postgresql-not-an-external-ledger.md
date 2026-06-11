# ADR-0005: Hash-chained audit log in PostgreSQL, not an external ledger

**Status:** Accepted
**Date:** 2026-06-11
**Deciders:** Younes Kaouani

## Context

One of the five guarantees this service exists to provide is *detectable tampering*: if the
record of who did what to a run is altered afterwards, that must be discoverable mechanically
rather than by argument. The audit trail is what an auditor reads when they do not trust us, so
"the application only ever inserts" is not an answer — it is the claim under examination.

The threat model is narrow and belongs before the mechanism. It is **accidental modification**
(a migration with a careless `UPDATE`, a support script run against the wrong database, a
refactor that decides an event needs backfilling) and **insider tampering** (someone editing
the record of an action after taking it). It is not an adversary who controls the hardware.

Constraints. An audit event must commit in the same transaction as the change it describes: a
sealed run whose seal event rolled back, and a seal event for a run that never sealed, are both
worse than the operation failing. This is a single-node deployment whose only infrastructure is
PostgreSQL and S3-compatible storage. Tenant isolation is enforced below the application by
row-level security (ADR-0002). Testing is integration-first against real dependencies
(ADR-0012), so a component that cannot be stood up in a container cannot be covered by the
suite that proves the guarantee.

What breaks if this is got wrong is the entire value proposition: a log that can be edited
silently invites reliance it does not deserve.

## Decision

The audit trail is a hash-chained, append-only table in the same PostgreSQL database as the data
it audits, with the chain computed inside `aliquot.append_audit_event()` and periodic checkpoints
designed to be anchored outside the database. We do not adopt a managed ledger service, a
blockchain, or an external append-only log file.

## Options considered

### Option A: Hash-chained table in the primary database (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | One migration, one plpgsql function, one verifier |
| Atomicity with the audited write | Exact: same transaction, no second system to fail |
| Accidental modification | Blocked by grants and by a trigger, independently |
| Full-privilege insider | Partial: a consistent rewrite still verifies |
| Testability | Full, including scripted tamper cases |

**Pros:** `AuditService.append(trx, ctx, event)` takes the caller's transaction rather than
opening one, so the event and the change are one commit or neither. `seq`, `prev_hash`, `hash`
and `occurred_at` are assigned inside `append_audit_event()`, so four of the five hash inputs
are values the audited process cannot choose (ADR-0015). `aliquot_app` and `aliquot_worker`
hold `SELECT, INSERT` and nothing else, and `aliquot.reject_audit_mutation()` raises
`integrity_constraint_violation` even for a role granted too much (ADR-0007). `ChainVerifier`
rebuilds the preimage in TypeScript, sharing no code with the appender, and localises a break
to a sequence number with reason `payload_digest`, `hash`, `prev_hash_mismatch` or
`sequence_gap`.

**Cons:** The evidence and the thing it is evidence about live under one authority. Nothing here
binds the chain to anything outside the database.

### Option B: Managed immutable ledger (QLDB-style) or a blockchain

| Dimension | Assessment |
|---|---|
| Complexity | High: second store, second consistency model |
| Atomicity with the audited write | None — dual write |
| Full-privilege insider | Genuinely defeated: journal under separate authority |
| Testability | Poor: no container-based fake with real semantics |

**Pros:** This is the option that actually fixes the residual risk rather than pricing it. A
journal written under different credentials, verified against a digest the database role cannot
influence, defeats the consistent-rewrite attack, and removes our obligation to own a verifier.

**Cons:** No transaction spans PostgreSQL and an external ledger. Writing the state change here
and the audit event there is a dual write, whose failure mode is exactly what the audit log
exists to prevent: a change with no record, or a record of a change that did not happen.
Restoring atomicity means an outbox and a relay — more moving parts than the chain it replaces,
plus a window where the log lags the data. Tenant scoping would have to be reimplemented outside
RLS. The blockchain framing is worse: consensus resolves disagreement between mutually
distrusting writers, and this system has one writer.

### Option C: Append-only log files on WORM storage

| Dimension | Assessment |
|---|---|
| Complexity | Low to write, high to query |
| Atomicity with the audited write | None — dual write, and a flush is not a commit |
| Full-privilege insider | Good, where object-lock retention is enforced by the store |
| Testability | Partial: MinIO implements object lock |

**Pros:** Retention is enforced by the storage service rather than by us, and it composes with
the object store already in the stack.

**Cons:** The audit trail is a first-class query surface here — `GET /v1/audit` filters by
action, target and actor, pages on `seq`, and is confined by RLS. Files provide none of that
without a derived index, which is a third copy to keep honest. The dual-write objection applies
unchanged, and a crash between commit and flush loses the record of a change that did happen.

## Trade-off analysis

Option B was the hardest to argue against, and it lost on atomicity rather than on cost. It is
the only option that closes the residual risk properly, and the chosen design does not close it.
What decided the matter is that an external ledger cannot participate in the transaction that
changes the data. Every arrangement restoring atomicity puts a queue between an event and its
record, and a queue is a place where records are delayed, replayed or dropped. Trading a
tamper-evidence gap for a durability gap is a bad trade when the first has a cheaper remedy and
the second does not.

That remedy is checkpointing, and it is the real answer to Option B rather than a consolation.
`aliquot.audit_checkpoint` records `(through_seq, chain_hash, event_count)` and carries
`external_ref` for whatever a mirror returns: an object version id under a different credential,
a transparency log index, a countersignature. Once a checkpoint is corroborated outside the
database, verification from that point is anchored to a value the database role cannot rewrite,
and `ChainVerifier.anchorFor()` compares its seed against the checkpoint rather than trusting
the stored row. That buys the same property as an external ledger at checkpoint granularity
instead of per event, without putting the write path across two systems, and it makes
verification O(events since checkpoint) instead of O(all events).

The residual risk, without hedging: **an actor with full database privileges can rewrite an
event, recompute every subsequent hash, and this system will report the chain as intact.** They
can rewrite the checkpoint rows in the same transaction. Chaining raises the cost of tampering
from one `UPDATE` to a coordinated rewrite of everything downstream; it does not make it
impossible. This is recorded as a passing test rather than a caveat in prose —
`test/integration/audit-chain.spec.ts` contains *"does NOT detect a rewrite that also recomputes
every following hash"* next to *"DOES detect the same rewrite when anchored to a prior
checkpoint"* — so a stronger claim written into the docs later has a test contradicting it.
Until `external_ref` is populated by a real mirror, a checkpoint proves internal consistency and
nothing more, and a `null` there should be read that way.

## Consequences

**Easier:** Appends are ordinary SQL inside an existing transaction, so no code path can produce
a change without its event. Verification, checkpointing and querying run against one database
with one isolation model, and the whole mechanism is exercisable in CI, tamper cases included.

**Harder:** We own the preimage format forever — the microsecond rendering in
`aliquot.audit_timestamp_text()` is contract, and a driver that truncates it reports every event
as tampered. Appends within a tenant serialise on the `audit_chain_head` row lock, so per-tenant
write throughput has a ceiling no connection pooling removes. `audit_event` is unpartitioned and
grows without bound. The security posture has to be restated wherever the feature is described,
because "hash-chained" is read as a stronger claim than it is.

**To revisit:** if a deployment comes under formal 21 CFR Part 11 scrutiny requiring a third
party to attest that the operator cannot alter records; if contention on `audit_chain_head`
becomes a measured bottleneck; or if a managed ledger appears that can enlist in a PostgreSQL
transaction, which removes the argument this decision rests on.

## Action items

1. - [x] `aliquot.audit_event` with `(tenant_id, seq)` primary key, chain columns and RLS
   (`migrations/0003_audit_chain.sql`).
2. - [x] `append_audit_event()` as `SECURITY DEFINER`, taking the tenant from
   `aliquot.current_tenant_id()` and refusing with `insufficient_privilege` when unset.
3. - [x] `SELECT, INSERT` only for `aliquot_app` and `aliquot_worker`, plus
   `reject_audit_mutation()` triggers that hold independently of the grants.
4. - [x] `ChainVerifier` recomputing the preimage in TypeScript; `ChainBrokenError` maps to
   `ProblemType.CHAIN_BROKEN` with HTTP 409.
5. - [x] `aliquot.audit_checkpoint` with `external_ref`, and `CheckpointService.create()`
   refusing to checkpoint a chain that does not verify.
6. - [x] Tamper suite: payload edit, mid-chain delete, rewritten hash, reordered pair,
   concurrent appends, both limit-of-chaining cases.
7. - [ ] Scheduled checkpointing. `AUDIT_CHECKPOINT_INTERVAL_MS` is parsed in
   `src/config/config.ts` and read by nothing; checkpoints exist only on
   `POST /v1/audit/checkpoints`.
8. - [ ] An external mirror populating `external_ref` — S3 Object Lock under a distinct
   credential is the intended first implementation.
9. - [ ] Scheduled verification from the last corroborated checkpoint, alerting on `ok: false`.
