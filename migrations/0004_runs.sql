-- 0004_runs.sql
--
-- Runs, artifacts, the manifest that binds them, upload sessions, and the
-- immutability boundary.

create type aliquot.run_state as enum (
  'OPEN',
  'SEALED',
  'PROCESSING',
  'PROCESSED',
  'PROCESSING_FAILED',
  'QUARANTINED',
  'ABANDONED'
);

-- ---------------------------------------------------------------------------
-- Artifacts: content-addressed, deduplicated, immutable
-- ---------------------------------------------------------------------------
--
-- One row per distinct piece of content per tenant. The same calibration file
-- uploaded with four hundred runs is one artifact row and four hundred
-- run_artifact rows -- which is not a hypothetical, it is the normal case on
-- any imaging platform.
--
-- Deduplication is scoped to the tenant rather than being global. Global
-- dedup is strictly better for storage and strictly worse for isolation: the
-- existence of a digest becomes an oracle telling tenant A that tenant B holds
-- a particular file. That is a real confidentiality leak in a setting where the
-- file might be an unpublished result, and the storage saving does not buy
-- enough to pay for it.

create table aliquot.artifact (
  id                 uuid primary key,
  tenant_id          uuid not null references aliquot.tenant(id),
  digest             aliquot.sha256_hex not null,
  size_bytes         bigint not null check (size_bytes >= 0),
  -- sha256/<first two hex>/<next two hex>/<full digest>. Derived, stored
  -- anyway: the derivation rule is a decision that may change, and objects
  -- already written keep their original key.
  storage_key        text not null,
  media_type         text not null default 'application/octet-stream',
  first_seen_run_id  uuid not null,
  created_at         timestamptz not null default clock_timestamp(),

  constraint artifact_digest_unique_per_tenant unique (tenant_id, digest)
);

select aliquot.apply_tenant_rls('artifact');
grant select, insert on aliquot.artifact to aliquot_app, aliquot_worker;
revoke update, delete, truncate on aliquot.artifact from aliquot_app, aliquot_worker;

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------

create table aliquot.run (
  id             uuid primary key,
  tenant_id      uuid not null references aliquot.tenant(id),
  study_id       uuid not null references aliquot.study(id),
  instrument_id  uuid not null references aliquot.instrument(id),
  operator_id    uuid not null references aliquot.app_user(id),

  state          aliquot.run_state not null default 'OPEN',

  -- Client-declared acquisition time. Descriptive only: an instrument
  -- workstation's clock is frequently wrong, sometimes by years, and this
  -- value is never used for ordering or for audit timing.
  acquired_at    timestamptz,
  -- Server time. Authoritative.
  registered_at  timestamptz not null default clock_timestamp(),
  sealed_at      timestamptz,
  quarantined_at timestamptz,
  abandoned_at   timestamptz,

  -- Correction is by superseding record, never by mutation (ADR-010). The new
  -- run points backwards; the superseded run is never touched, so it stays
  -- byte-identical to what any external citation referred to.
  supersedes_run_id uuid references aliquot.run(id),
  supersede_reason  text,

  -- Digest of the canonicalised manifest, fixed at registration. Sealing
  -- recomputes it from the run_artifact rows and refuses if it has moved, so a
  -- manifest cannot be quietly widened between registration and seal.
  manifest_digest aliquot.sha256_hex not null,

  -- Free-form instrument metadata (acquisition settings, channel layout).
  -- Deliberately not modelled: the useful schema here is OME-XML or a
  -- vendor equivalent, and inventing a lossy subset of it would be worse than
  -- storing the original and indexing what we actually query.
  protocol jsonb not null default '{}'::jsonb,

  quarantine_reason text,

  -- Processing state. These are the only columns that may move after sealing,
  -- because they describe what was done *to* the run, not what the run is.
  processing_attempts     integer not null default 0,
  processing_started_at   timestamptz,
  processing_completed_at timestamptz,
  processing_error        text,

  constraint run_supersede_reason_present
    check ((supersedes_run_id is null) = (supersede_reason is null)),
  constraint run_no_self_supersede
    check (supersedes_run_id is distinct from id),
  constraint run_sealed_at_consistent
    check ((state in ('SEALED','PROCESSING','PROCESSED','PROCESSING_FAILED')) = (sealed_at is not null)),
  constraint run_quarantine_reason_present
    check ((state = 'QUARANTINED') = (quarantine_reason is not null))
);

-- Search: study + state + acquisition window is the query the scientist
-- persona actually issues. id is included last so the index also serves the
-- cursor, which is (acquired_at, id).
create index run_search_idx
  on aliquot.run (tenant_id, study_id, state, acquired_at desc, id desc);
create index run_instrument_idx
  on aliquot.run (tenant_id, instrument_id, acquired_at desc);
create index run_operator_idx
  on aliquot.run (tenant_id, operator_id, acquired_at desc);
-- Reverse supersede lookup. There is no superseded_by column on purpose:
-- writing one would mean mutating a sealed run to record that it had been
-- corrected, which is exactly the thing sealing forbids.
create index run_supersedes_idx
  on aliquot.run (tenant_id, supersedes_run_id)
  where supersedes_run_id is not null;

select aliquot.apply_tenant_rls('run');
grant select, insert, update on aliquot.run to aliquot_app, aliquot_worker;
revoke delete, truncate on aliquot.run from aliquot_app, aliquot_worker;

alter table aliquot.artifact
  add constraint artifact_first_seen_run_fk
  foreign key (first_seen_run_id) references aliquot.run(id);

-- ---------------------------------------------------------------------------
-- Manifest entries
-- ---------------------------------------------------------------------------
--
-- Declared at registration, satisfied by upload. The declaration is what makes
-- completeness checkable: without it, "the run finished uploading" and "the
-- run uploaded everything it was going to" are the same statement, and a
-- truncated transfer is indistinguishable from a small run.

create type aliquot.artifact_verification_state as enum (
  'DECLARED',   -- in the manifest, no bytes yet
  'UPLOADING',  -- an upload session is open
  'VERIFIED',   -- stored, size and digest match the declaration
  'REJECTED'    -- stored bytes disagreed with the declaration
);

create table aliquot.run_artifact (
  id                  uuid primary key,
  tenant_id           uuid not null references aliquot.tenant(id),
  run_id              uuid not null references aliquot.run(id),

  -- Path-like name within the run, e.g. 'ch0/stack.tif'. Instruments organise
  -- output as a directory tree and flattening it loses information the
  -- scientist relies on.
  --
  -- Length and shape are separate constraints because PostgreSQL's POSIX regex
  -- engine caps a bounded repetition at 255, and it does not tell you so until
  -- the pattern is first executed -- the CHECK is created happily and every
  -- INSERT then fails with "invalid repetition count(s)". Splitting them also
  -- produces a better error: too long and malformed are different mistakes.
  logical_name        text not null
                      constraint run_artifact_name_length
                        check (length(logical_name) between 1 and 512)
                      constraint run_artifact_name_shape
                        check (logical_name ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'),

  declared_digest     aliquot.sha256_hex not null,
  declared_size       bigint not null check (declared_size >= 0),
  declared_media_type text not null default 'application/octet-stream',

  artifact_id         uuid references aliquot.artifact(id),
  verification_state  aliquot.artifact_verification_state not null default 'DECLARED',
  verified_at         timestamptz,
  rejection_reason    text,

  created_at          timestamptz not null default clock_timestamp(),

  constraint run_artifact_name_unique_per_run unique (tenant_id, run_id, logical_name),
  constraint run_artifact_verified_has_artifact
    check ((verification_state = 'VERIFIED') = (artifact_id is not null and verified_at is not null)),
  constraint run_artifact_rejected_has_reason
    check ((verification_state = 'REJECTED') = (rejection_reason is not null))
);

create index run_artifact_run_idx on aliquot.run_artifact (tenant_id, run_id);
create index run_artifact_artifact_idx on aliquot.run_artifact (tenant_id, artifact_id)
  where artifact_id is not null;

select aliquot.apply_tenant_rls('run_artifact');
grant select, insert, update on aliquot.run_artifact to aliquot_app, aliquot_worker;
revoke delete, truncate on aliquot.run_artifact from aliquot_app, aliquot_worker;

-- ---------------------------------------------------------------------------
-- Upload sessions
-- ---------------------------------------------------------------------------
--
-- One session per manifest entry that actually needs bytes moved. Parts are
-- tracked here rather than only in the object store so that "resume from part
-- 412" is answerable without a round trip that lists parts, and so that a
-- session survives an object-store restart in local development.

create type aliquot.upload_session_state as enum ('OPEN', 'COMPLETED', 'ABORTED');

create table aliquot.upload_session (
  id                uuid primary key,
  tenant_id         uuid not null references aliquot.tenant(id),
  run_artifact_id   uuid not null references aliquot.run_artifact(id),
  storage_key       text not null,
  -- The object store's own multipart upload id. Opaque to us.
  storage_upload_id text not null,
  part_size         bigint not null check (part_size >= 5 * 1024 * 1024),
  total_parts       integer not null check (total_parts between 1 and 10000),
  state             aliquot.upload_session_state not null default 'OPEN',
  created_at        timestamptz not null default clock_timestamp(),
  expires_at        timestamptz not null,
  completed_at      timestamptz
);

-- At most one open session per manifest entry. Two concurrent sessions for the
-- same entry would race to complete and one would overwrite the other's parts.
create unique index upload_session_one_open_per_artifact
  on aliquot.upload_session (tenant_id, run_artifact_id)
  where state = 'OPEN';

select aliquot.apply_tenant_rls('upload_session');
grant select, insert, update on aliquot.upload_session to aliquot_app, aliquot_worker;

create table aliquot.upload_part (
  tenant_id          uuid not null references aliquot.tenant(id),
  upload_session_id  uuid not null references aliquot.upload_session(id),
  part_number        integer not null check (part_number between 1 and 10000),
  etag               text not null,
  size_bytes         bigint not null check (size_bytes >= 0),
  completed_at       timestamptz not null default clock_timestamp(),

  primary key (upload_session_id, part_number)
);

select aliquot.apply_tenant_rls('upload_part');
grant select, insert, update on aliquot.upload_part to aliquot_app, aliquot_worker;

-- ---------------------------------------------------------------------------
-- The immutability boundary
-- ---------------------------------------------------------------------------
--
-- Everything above is ordinary schema. This is the part that carries the
-- guarantee, and it is in the database rather than in a service method because
-- a service method is one refactor, one new endpoint, or one well-meaning
-- migration script away from being bypassed. A trigger is not.
--
-- The diff is computed over to_jsonb(row) minus an allow-list, rather than
-- column by column. That fails closed: a column added by a later migration is
-- frozen by default, and someone who wants it mutable after sealing has to say
-- so explicitly and, in saying so, think about whether it should be.

create or replace function aliquot.enforce_run_immutability() returns trigger
language plpgsql
as $$
declare
  -- Columns describing what was done *to* a sealed run rather than what the
  -- run is. Freezing these would make it impossible to record that processing
  -- had happened at all.
  v_mutable constant text[] := array[
    'state',
    'processing_attempts',
    'processing_started_at',
    'processing_completed_at',
    'processing_error'
  ];
begin
  if old.state = 'OPEN' then
    return new;
  end if;

  if old.state in ('QUARANTINED', 'ABANDONED') then
    raise exception 'run % is in terminal state % and cannot be modified', old.id, old.state
      using errcode = 'integrity_constraint_violation';
  end if;

  if (to_jsonb(old) - v_mutable) <> (to_jsonb(new) - v_mutable) then
    raise exception 'run % is sealed; only processing state may change', old.id
      using errcode = 'integrity_constraint_violation',
            detail  = 'attempted change: ' || (to_jsonb(new) - v_mutable)::text;
  end if;

  -- Even within the processing columns, the state machine still applies. This
  -- duplicates the application-level transition table on purpose: the
  -- application table is the readable, exhaustively unit-tested definition,
  -- and this is the one that holds when something reaches the table by another
  -- route.
  if new.state <> old.state and not (
       (old.state = 'SEALED'            and new.state = 'PROCESSING')
    or (old.state = 'PROCESSING'        and new.state in ('PROCESSED', 'PROCESSING_FAILED'))
    or (old.state = 'PROCESSING_FAILED' and new.state = 'PROCESSING')
  ) then
    raise exception 'illegal run transition % -> % for run %', old.state, new.state, old.id
      using errcode = 'integrity_constraint_violation';
  end if;

  return new;
end
$$;

create trigger run_immutability
  before update on aliquot.run
  for each row execute function aliquot.enforce_run_immutability();

-- Artifact bindings freeze with the run. Checked against the run's state at
-- statement time rather than cached on the row, so there is no window in which
-- the two disagree.
create or replace function aliquot.enforce_run_artifact_immutability() returns trigger
language plpgsql
as $$
declare
  v_run_id uuid := coalesce(new.run_id, old.run_id);
  v_state  aliquot.run_state;
begin
  select r.state into v_state from aliquot.run r where r.id = v_run_id;

  if v_state is not null and v_state <> 'OPEN' then
    raise exception 'run % is %; its manifest bindings are frozen', v_run_id, v_state
      using errcode = 'integrity_constraint_violation';
  end if;

  return coalesce(new, old);
end
$$;

create trigger run_artifact_immutability
  before insert or update or delete on aliquot.run_artifact
  for each row execute function aliquot.enforce_run_artifact_immutability();

-- Content-addressed rows describe bytes that already exist under a key derived
-- from their own digest. There is nothing about them that can legitimately
-- change; an UPDATE here is always a bug or an attack.
create or replace function aliquot.reject_artifact_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'artifact % is immutable (%)', old.id, tg_op
    using errcode = 'integrity_constraint_violation';
end
$$;

create trigger artifact_no_update
  before update or delete on aliquot.artifact
  for each row execute function aliquot.reject_artifact_mutation();
