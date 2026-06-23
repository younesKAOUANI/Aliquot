-- 0005_idempotency.sql
--
-- Idempotency keys for mutating endpoints.
--
-- The unique constraint is the entire concurrency mechanism. The first caller
-- inserts (tenant, key, endpoint) and proceeds; a concurrent duplicate collides
-- and is told to retry rather than being handed a half-built resource. There is
-- no application-level lock, no check-then-act, and therefore no race window
-- between the check and the act.
--
-- The request fingerprint is what separates a retry from a mistake. Matching on
-- the key alone means a client that reuses a key with different content
-- silently receives the response to a request it did not make -- which is worse
-- than an error, because it looks like success.

create type aliquot.idempotency_state as enum ('IN_FLIGHT', 'COMPLETED');

create table aliquot.idempotency_key (
  id                   uuid primary key,
  tenant_id            uuid not null references aliquot.tenant(id),

  key                  text not null check (length(key) between 8 and 255),
  -- Scoped per endpoint. The same key against a different endpoint is a
  -- different operation; collapsing them would make key generation a
  -- cross-endpoint coordination problem for the client.
  endpoint             text not null,

  -- sha256(JCS(request body)) -- see src/common/canonical-json.ts. Canonical
  -- form matters: a client that re-serialises the same object with different
  -- key ordering on retry must still be recognised as retrying.
  request_fingerprint  aliquot.sha256_hex not null,

  state                aliquot.idempotency_state not null default 'IN_FLIGHT',

  response_status      integer check (response_status between 100 and 599),
  response_body        jsonb,
  resource_id          uuid,

  created_at           timestamptz not null default clock_timestamp(),
  completed_at         timestamptz,
  -- 24 hours after creation. Long enough to cover any realistic client retry
  -- schedule including an overnight outage; short enough that the table does
  -- not become a second copy of the API's response history.
  expires_at           timestamptz not null,

  constraint idempotency_key_unique unique (tenant_id, key, endpoint),
  constraint idempotency_completed_has_response
    check ((state = 'COMPLETED') = (response_status is not null and completed_at is not null))
);

-- Reclamation index. Expired rows are deleted by a scheduled sweep rather than
-- being filtered at read time: a caller replaying a key after expiry must be
-- treated as a first-time caller, and leaving tombstones around invites the
-- opposite behaviour to creep in.
create index idempotency_key_expiry_idx on aliquot.idempotency_key (expires_at);

select aliquot.apply_tenant_rls('idempotency_key');

-- DELETE is granted here and almost nowhere else. Idempotency records are
-- operational bookkeeping with a documented retention window, not part of the
-- audited record -- the audit event for the underlying operation is what
-- endures. Expiry is therefore a real delete rather than a tombstone.
grant select, insert, update, delete on aliquot.idempotency_key to aliquot_app, aliquot_worker;
