-- 0003_audit_chain.sql
--
-- The append-only, hash-chained audit log.
--
-- Three properties are enforced here rather than in application code, because
-- application code is one refactor away from not enforcing them:
--
--   1. Events cannot be updated or deleted. The application role is never
--      granted UPDATE or DELETE, and a trigger raises even for roles that are.
--   2. seq, prev_hash, hash and occurred_at are chosen by the database, not by
--      the caller. Four of the five hash inputs are therefore values the
--      application cannot pick. The fifth -- payload_digest -- it must supply,
--      because RFC 8785 canonicalisation is not something to reimplement in
--      plpgsql, and that digest is itself covered by the chain.
--   3. Appends to a tenant's chain are serialised by a row lock on the chain
--      head. Two concurrent appends cannot take the same prev_hash, which is
--      the failure that would silently fork a chain into two valid-looking
--      branches.

create table aliquot.audit_event (
  tenant_id       uuid   not null references aliquot.tenant(id),
  seq             bigint not null,

  id              uuid   not null,

  actor_type      aliquot.actor_type not null,
  actor_id        uuid,
  -- Denormalised label captured at the time of the event. If a user is renamed
  -- or an instrument decommissioned three years later, the audit trail must
  -- still read as it did on the day -- "Attributable" in ALCOA+ means the
  -- record stands on its own, not that it joins successfully today.
  actor_label     text not null,

  action          text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  target_type     text not null,
  target_id       uuid,

  payload         jsonb not null,
  payload_digest  aliquot.sha256_hex not null,

  prev_hash       aliquot.sha256_hex not null,
  hash            aliquot.sha256_hex not null,

  occurred_at     timestamptz not null,
  correlation_id  text,

  primary key (tenant_id, seq)
);

comment on column aliquot.audit_event.hash is
  'sha256(tenant_id | seq | prev_hash | payload_digest | occurred_at), pipe '
  'separated, occurred_at rendered as YYYY-MM-DDTHH24:MI:SS.USZ in UTC. The '
  'exact preimage is part of the contract: see aliquot.audit_hash_preimage().';

create index audit_event_target_idx
  on aliquot.audit_event (tenant_id, target_type, target_id, seq desc);
create index audit_event_occurred_idx
  on aliquot.audit_event (tenant_id, occurred_at desc);
create index audit_event_actor_idx
  on aliquot.audit_event (tenant_id, actor_type, actor_id, seq desc);

select aliquot.apply_tenant_rls('audit_event');

-- The whole point. INSERT and SELECT only, for every role that is not the
-- owner. There is no code path in this service that can update or delete an
-- audit event, because the privilege to do so does not exist.
grant select, insert on aliquot.audit_event to aliquot_app, aliquot_worker;
revoke update, delete, truncate on aliquot.audit_event from aliquot_app, aliquot_worker;

-- ---------------------------------------------------------------------------
-- Chain head
-- ---------------------------------------------------------------------------
--
-- One row per tenant, holding the sequence number and hash of the most recent
-- event. It exists to be locked: an append takes FOR UPDATE on this row, so
-- appends within a tenant are strictly ordered while appends across tenants
-- proceed in parallel.
--
-- The application role has no privileges on this table at all. It can only be
-- moved by append_audit_event(), which is SECURITY DEFINER. If the application
-- could write the head directly it could rewind the chain and re-append over
-- the top of it, which would defeat the entire mechanism.

create table aliquot.audit_chain_head (
  tenant_id   uuid primary key references aliquot.tenant(id),
  last_seq    bigint not null default 0,
  last_hash   aliquot.sha256_hex not null default repeat('0', 64),
  updated_at  timestamptz not null default clock_timestamp()
);

comment on column aliquot.audit_chain_head.last_hash is
  'Genesis value is 64 zeroes, so event 1 has a well-defined predecessor and '
  'the verifier needs no special case for the first link.';

-- ---------------------------------------------------------------------------
-- Hash preimage
-- ---------------------------------------------------------------------------
--
-- Factored out and IMMUTABLE so that the appender and any verifier are
-- guaranteed to agree on the byte string being hashed. Timestamp rendering is
-- the subtle part: microsecond precision, explicit UTC, fixed format. A
-- verifier that reads occurred_at through a driver that truncates to
-- milliseconds -- which is what JavaScript's Date does -- would compute a
-- different digest for an untampered event and report a false positive.
-- The read path therefore selects this rendering as text rather than
-- reconstructing it from a parsed timestamp.

create or replace function aliquot.audit_timestamp_text(p_ts timestamptz) returns text
language sql immutable
as $$
  select to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$;

create or replace function aliquot.audit_hash_preimage(
  p_tenant_id      uuid,
  p_seq            bigint,
  p_prev_hash      text,
  p_payload_digest text,
  p_occurred_at    timestamptz
) returns text
language sql immutable
as $$
  select p_tenant_id::text
      || '|' || p_seq::text
      || '|' || p_prev_hash
      || '|' || p_payload_digest
      || '|' || aliquot.audit_timestamp_text(p_occurred_at);
$$;

grant execute on function aliquot.audit_timestamp_text(timestamptz)
  to aliquot_app, aliquot_worker;
grant execute on function aliquot.audit_hash_preimage(uuid, bigint, text, text, timestamptz)
  to aliquot_app, aliquot_worker;

-- ---------------------------------------------------------------------------
-- Append
-- ---------------------------------------------------------------------------

create or replace function aliquot.append_audit_event(
  p_actor_type     aliquot.actor_type,
  p_actor_id       uuid,
  p_actor_label    text,
  p_action         text,
  p_target_type    text,
  p_target_id      uuid,
  p_payload        jsonb,
  p_payload_digest text,
  p_correlation_id text default null
) returns table (seq bigint, hash text, occurred_at timestamptz)
language plpgsql
security definer
set search_path = aliquot, pg_catalog
as $$
declare
  v_tenant_id   uuid;
  v_seq         bigint;
  v_prev_hash   text;
  v_occurred_at timestamptz;
  v_hash        text;
begin
  -- The tenant is taken from the session, never from an argument. A caller
  -- cannot write into another tenant's chain even by mistake, and SECURITY
  -- DEFINER does not become a hole through the isolation boundary.
  v_tenant_id := aliquot.current_tenant_id();
  if v_tenant_id is null then
    raise exception 'app.tenant_id is not set; refusing to append an unattributable audit event'
      using errcode = 'insufficient_privilege';
  end if;

  -- Establish the head on first use. ON CONFLICT DO NOTHING rather than an
  -- exception handler: two concurrent first-ever appends for a new tenant are
  -- a real race, and one of them must lose quietly.
  insert into aliquot.audit_chain_head (tenant_id)
  values (v_tenant_id)
  on conflict (tenant_id) do nothing;

  select h.last_seq, h.last_hash
    into v_seq, v_prev_hash
    from aliquot.audit_chain_head h
   where h.tenant_id = v_tenant_id
     for update;

  v_seq := v_seq + 1;
  v_occurred_at := clock_timestamp();

  v_hash := encode(
    sha256(
      convert_to(
        aliquot.audit_hash_preimage(v_tenant_id, v_seq, v_prev_hash, p_payload_digest, v_occurred_at),
        'UTF8'
      )
    ),
    'hex'
  );

  insert into aliquot.audit_event (
    tenant_id, seq, id,
    actor_type, actor_id, actor_label,
    action, target_type, target_id,
    payload, payload_digest,
    prev_hash, hash,
    occurred_at, correlation_id
  ) values (
    v_tenant_id, v_seq, gen_random_uuid(),
    p_actor_type, p_actor_id, p_actor_label,
    p_action, p_target_type, p_target_id,
    p_payload, p_payload_digest,
    v_prev_hash, v_hash,
    v_occurred_at, p_correlation_id
  );

  update aliquot.audit_chain_head
     set last_seq = v_seq, last_hash = v_hash, updated_at = clock_timestamp()
   where tenant_id = v_tenant_id;

  return query select v_seq, v_hash, v_occurred_at;
end
$$;

grant execute on function aliquot.append_audit_event(
  aliquot.actor_type, uuid, text, text, text, uuid, jsonb, text, text
) to aliquot_app, aliquot_worker;

-- ---------------------------------------------------------------------------
-- Insert-only enforcement
-- ---------------------------------------------------------------------------
--
-- Redundant with the revoked grants for the application, and that is the
-- intent. The grants stop the application; the trigger stops a migration, a
-- psql session, or a future role that was granted more than it should have
-- been. Tamper tests connect as the owner precisely to prove this layer
-- exists independently of the grants.

-- Deliberately column-agnostic so the same trigger guards audit_event and
-- audit_checkpoint, which do not share a key shape.
create or replace function aliquot.reject_audit_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'aliquot.% is append-only: % rejected', tg_table_name, tg_op
    using errcode = 'integrity_constraint_violation',
          detail  = 'row: ' || coalesce(to_jsonb(old)::text, '<none>');
end
$$;

create trigger audit_event_no_update
  before update on aliquot.audit_event
  for each row execute function aliquot.reject_audit_mutation();

create trigger audit_event_no_delete
  before delete on aliquot.audit_event
  for each row execute function aliquot.reject_audit_mutation();

-- ---------------------------------------------------------------------------
-- Checkpoints
-- ---------------------------------------------------------------------------
--
-- A chain in the same database as the data it audits does not defend against an
-- actor holding full database privileges: they can rewrite an event and then
-- recompute every hash after it. Chaining raises the cost of tampering from one
-- UPDATE to a full rewrite; it does not make it impossible.
--
-- Closing that gap needs the chain head recorded somewhere the database role
-- cannot reach. A checkpoint is that record: (through_seq, chain_hash) written
-- periodically and mirrored to an append-only external location. Verification
-- from the last externally-corroborated checkpoint forward is then genuinely
-- tamper-evident, and full-history verification becomes O(events since
-- checkpoint) rather than O(all events).
--
-- external_ref carries whatever the mirror produced -- an object version id, a
-- transparency log index, a signature. It is null when checkpointing is
-- configured to be local-only, which is the honest default for a single-node
-- deployment.

create table aliquot.audit_checkpoint (
  id            uuid primary key,
  tenant_id     uuid not null references aliquot.tenant(id),
  through_seq   bigint not null,
  chain_hash    aliquot.sha256_hex not null,
  event_count   bigint not null,
  created_at    timestamptz not null default clock_timestamp(),
  external_ref  text,

  constraint audit_checkpoint_unique_seq unique (tenant_id, through_seq)
);

create index audit_checkpoint_latest_idx
  on aliquot.audit_checkpoint (tenant_id, through_seq desc);

select aliquot.apply_tenant_rls('audit_checkpoint');

grant select, insert on aliquot.audit_checkpoint to aliquot_app, aliquot_worker;
revoke update, delete, truncate on aliquot.audit_checkpoint from aliquot_app, aliquot_worker;

create trigger audit_checkpoint_no_update
  before update on aliquot.audit_checkpoint
  for each row execute function aliquot.reject_audit_mutation();

create trigger audit_checkpoint_no_delete
  before delete on aliquot.audit_checkpoint
  for each row execute function aliquot.reject_audit_mutation();
