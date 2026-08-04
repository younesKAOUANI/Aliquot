-- 0008_sandbox_tenants.sql
--
-- Ephemeral tenants, and the one code path in this service that deletes.
--
-- ---------------------------------------------------------------------------
-- Why this is not a contradiction
-- ---------------------------------------------------------------------------
--
-- Everything else in this schema is built on the premise that nothing is
-- removed. Audit events have no DELETE grant and a trigger that refuses one;
-- artifacts are content-addressed and immutable; a sealed run is corrected by a
-- superseding run rather than by a mutation; a revoked membership keeps its row
-- so that "who could have written this, and when did that stop being true" stays
-- answerable years later. The reaper introduced below deletes whole tenants.
--
-- That is reconcilable only if "the record" is defined, and `kind` is where it
-- gets defined. ALCOA+ asks that a record be Enduring: it must outlive the
-- system, the staff and the study it came from. A sandbox tenant is not a
-- record. It is a stranger pressing the buttons for an hour to see what the
-- buttons do, against synthetic bytes they invented, with an expiry fixed before
-- the first one was pressed. Enduring is a property demanded of evidence, and
-- there is no evidence here to demand it of.
--
-- The load-bearing word in that paragraph is "is", and `kind` is what makes it a
-- fact about the schema instead of a convention in a service method. A tenant is
-- permanent unless a row says otherwise, the column is NOT NULL with a permanent
-- default so every tenant that already exists and every tenant created by any
-- code path that has not heard of sandboxes is permanent, and the deletion
-- function below refuses -- unconditionally, before it touches anything -- to
-- act on a tenant that is not `kind = 'sandbox'`. A reaper whose only protection
-- was a WHERE clause would be one typo away from deleting a customer; this one
-- can have its WHERE clause deleted entirely and still not.

create type aliquot.tenant_kind as enum ('permanent', 'sandbox');

alter table aliquot.tenant
  add column kind        aliquot.tenant_kind not null default 'permanent',
  add column expires_at  timestamptz;

-- Biconditional, not two independent nullability rules. A sandbox without an
-- expiry never gets reaped and quietly becomes permanent storage that nobody
-- owns; a permanent tenant with an expiry is a customer with a date on it.
-- Neither is a state this table should be able to represent.
alter table aliquot.tenant
  add constraint tenant_expiry_matches_kind
  check ((kind = 'sandbox') = (expires_at is not null));

comment on column aliquot.tenant.kind is
  'Whether this tenant is part of the enduring record. A sandbox tenant is '
  'explicitly outside it and is the only thing aliquot.reap_sandbox_tenant() '
  'will delete.';

-- The reaper's scan, and nothing else. Partial on the kind so the index holds
-- only live sandboxes -- a deployment with a hundred thousand permanent tenants
-- and six sandboxes pays for six rows.
create index tenant_sandbox_expiry_idx
  on aliquot.tenant (kind, expires_at)
  where kind = 'sandbox';

-- ---------------------------------------------------------------------------
-- Provisioning
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER for the same reason append_audit_event() is: the application
-- role must be able to cause exactly one specific, auditable effect that it has
-- no privilege to cause directly. `aliquot.tenant` is granted SELECT and nothing
-- else to aliquot_app (migration 0002), because tenant creation is an
-- administrative act. Granting INSERT to make the sandbox endpoint work would
-- hand the API the ability to create permanent tenants as a side effect of
-- wanting to create disposable ones.
--
-- Here the caller supplies the id, the slug and the lifetime; `kind` is a
-- literal in the function body and `expires_at` is computed from the server's
-- clock. There is no argument that lets a caller of this function produce a
-- permanent tenant, and no argument that lets one produce a sandbox that outlives
-- the ceiling below.
--
-- ON CONFLICT DO NOTHING rather than letting the unique index raise: the slug
-- carries 32 bits of randomness, so a collision is rare but not impossible, and
-- a raised exception would abort the caller's whole transaction -- which by then
-- also holds the study, the operator and the instrument. Returning zero rows
-- lets the caller retry with a fresh slug inside the same transaction.

create or replace function aliquot.provision_sandbox_tenant(
  p_id          uuid,
  p_slug        text,
  p_name        text,
  p_ttl_minutes integer
) returns setof aliquot.tenant
language plpgsql
security definer
set search_path = aliquot, pg_catalog
as $$
begin
  -- A ceiling in the database as well as in the configuration. The configuration
  -- is a number in an environment file that an operator can raise without
  -- thinking about it; this is the point at which "ephemeral" stops being true.
  if p_ttl_minutes < 1 or p_ttl_minutes > 1440 then
    raise exception 'a sandbox lifetime must be between 1 and 1440 minutes, not %', p_ttl_minutes
      using errcode = 'invalid_parameter_value';
  end if;

  return query
    insert into aliquot.tenant (id, slug, name, kind, expires_at)
    values (
      p_id,
      p_slug,
      p_name,
      'sandbox',
      clock_timestamp() + make_interval(mins => p_ttl_minutes)
    )
    on conflict (slug) do nothing
    returning aliquot.tenant.*;
end
$$;

grant execute on function aliquot.provision_sandbox_tenant(uuid, text, text, integer)
  to aliquot_app;

-- ---------------------------------------------------------------------------
-- Relaxing the immutability triggers, for sandbox rows only
-- ---------------------------------------------------------------------------
--
-- The triggers in 0003 and 0004 refuse every UPDATE and DELETE outright, and
-- they are the reason the immutability claim is worth anything: they hold for
-- roles the grants were never checked against, for a psql session, and for a
-- migration. The reaper has to get past three of them.
--
-- The alternative was `SET session_replication_role = 'replica'` inside the
-- reaping function, which switches every user trigger off for the transaction.
-- It is one line instead of three replaced functions, and it was rejected
-- because it also switches off the foreign key triggers -- so a table this
-- service adds later and the reaper forgets would leave rows referencing a
-- tenant that no longer exists, silently, with no error to notice. The FK
-- checks are the thing that makes the delete order below verifiable, and
-- turning them off to delete a sandbox would be paying for the reaper's
-- convenience with the schema's ability to catch the reaper being wrong.
--
-- So the exception is stated per row instead: these triggers now permit a
-- DELETE of a row whose tenant is a sandbox, and refuse everything else exactly
-- as before. Two independent gates still stand between the application and an
-- audit event: aliquot_app and aliquot_worker hold no DELETE privilege on
-- audit_event at all, so reaching this relaxation at all requires owner rights.

create or replace function aliquot.is_sandbox_tenant(p_tenant_id uuid) returns boolean
language sql stable
as $$
  select exists (
    select 1 from aliquot.tenant t where t.id = p_tenant_id and t.kind = 'sandbox'
  );
$$;

grant execute on function aliquot.is_sandbox_tenant(uuid) to aliquot_app, aliquot_worker;

create or replace function aliquot.reject_audit_mutation() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and aliquot.is_sandbox_tenant(old.tenant_id) then
    return old;
  end if;

  raise exception 'aliquot.% is append-only: % rejected', tg_table_name, tg_op
    using errcode = 'integrity_constraint_violation',
          detail  = 'row: ' || coalesce(to_jsonb(old)::text, '<none>');
end
$$;

create or replace function aliquot.reject_artifact_mutation() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and aliquot.is_sandbox_tenant(old.tenant_id) then
    return old;
  end if;

  raise exception 'artifact % is immutable (%)', old.id, tg_op
    using errcode = 'integrity_constraint_violation';
end
$$;

create or replace function aliquot.enforce_run_artifact_immutability() returns trigger
language plpgsql
as $$
declare
  v_run_id uuid := coalesce(new.run_id, old.run_id);
  v_state  aliquot.run_state;
begin
  if tg_op = 'DELETE' and aliquot.is_sandbox_tenant(old.tenant_id) then
    return old;
  end if;

  select r.state into v_state from aliquot.run r where r.id = v_run_id;

  if v_state is not null and v_state <> 'OPEN' then
    raise exception 'run % is %; its manifest bindings are frozen', v_run_id, v_state
      using errcode = 'integrity_constraint_violation';
  end if;

  return coalesce(new, old);
end
$$;

-- ---------------------------------------------------------------------------
-- Shared objects
-- ---------------------------------------------------------------------------
--
-- Storage keys are derived from the digest alone (`sha256/ab/cd/<digest>`, see
-- storageKeyForDigest) and are therefore global, while `artifact` rows are per
-- tenant by ADR-0017. Two tenants holding identical bytes hold two rows and one
-- object. Deleting a sandbox's objects by walking its own artifact rows would
-- therefore delete bytes a permanent tenant is still pointing at, and the
-- symptom is the worst kind: that tenant's run stays VERIFIED, its manifest
-- still digests correctly, and the download 404s. An integrity guarantee that
-- fails by producing a verified record with no bytes behind it is worse than one
-- that fails loudly.
--
-- This is the query that prevents it, and it has to see across tenants to be
-- able to answer -- which is exactly the cross-tenant visibility `artifact`'s
-- RLS policy exists to deny. Note what that means: this function is the
-- existence oracle ADR-0017 refused to build when it chose per-tenant dedup over
-- global dedup, because the oracle tells the asker that *somebody else* holds a
-- given digest. It is granted to aliquot_worker alone, it is not reachable from
-- any request path, and it returns nothing but digests the caller already had.
-- That is the whole of the argument for its existence; if it were ever granted
-- to aliquot_app, ADR-0017 would be untrue.
--
-- The privilege assertion is not decoration. RLS is bypassed here because the
-- definer is the migration owner, which migration 0001 already requires to be a
-- superuser (only a superuser can ALTER ROLE ... NOSUPERUSER). If that ever
-- stopped being so, every read below would return zero rows under FORCE ROW
-- LEVEL SECURITY, the function would report "no other tenant holds this digest"
-- for every digest, and the reaper would delete every shared object it saw.
-- Failing to start is the only acceptable behaviour for a check whose silent
-- failure mode is data loss.

create or replace function aliquot.digests_referenced_elsewhere(
  p_digests          text[],
  p_excluding_tenant uuid
) returns setof text
language plpgsql
stable
security definer
set search_path = aliquot, pg_catalog
as $$
begin
  if not exists (
    select 1 from pg_catalog.pg_roles
     where rolname = current_user and (rolsuper or rolbypassrls)
  ) then
    raise exception
      'aliquot.digests_referenced_elsewhere() is owned by %, which does not bypass row-level '
      'security; it cannot see other tenants'' artifacts and would wrongly report every digest '
      'as unshared', current_user
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select distinct a.digest::text
      from aliquot.artifact a
     where a.digest::text = any (p_digests)
       and a.tenant_id <> p_excluding_tenant;
end
$$;

grant execute on function aliquot.digests_referenced_elsewhere(text[], uuid) to aliquot_worker;

-- ---------------------------------------------------------------------------
-- Reaping
-- ---------------------------------------------------------------------------
--
-- SECURITY DEFINER because the reaper needs DELETE on a dozen tables that
-- deliberately do not grant it -- artifact, run, run_artifact, audit_event and
-- audit_checkpoint all revoke it explicitly, and that revocation is load-bearing
-- for every other tenant in the database. Widening those grants so a background
-- task could tidy up would mean the API role could delete a customer's audit
-- trail, which is a considerably larger change than it looks.
--
-- Concentrating the privilege here instead is acceptable for one reason and it
-- is the reason stated at the top of this file: the function's first act is to
-- establish that the tenant is a sandbox, and it raises if it is not. It takes a
-- tenant id and deletes that tenant entirely -- it has no predicate a caller can
-- get subtly wrong, no partial mode, and no way to be pointed at a permanent
-- tenant. Execute is granted to aliquot_worker only, because the API may be
-- scaled to several instances and a deletion loop should not race with itself.
--
-- Expiry is deliberately NOT checked here. `kind` is the safety property and it
-- belongs in the function; "has this one expired yet" is a scheduling question
-- that belongs to the caller's WHERE clause, and hard-coding it would also make
-- it impossible for an operator to drop a sandbox early.
--
-- Deletion order is child-to-parent, and the foreign keys are left enabled so
-- that a table added by a later migration and forgotten here fails this function
-- loudly rather than leaving orphans behind.

create or replace function aliquot.reap_sandbox_tenant(p_tenant_id uuid)
returns table (runs bigint, artifacts bigint, audit_events bigint)
language plpgsql
security definer
set search_path = aliquot, pg_catalog
as $$
declare
  v_kind   aliquot.tenant_kind;
  v_runs   bigint := 0;
  v_arts   bigint := 0;
  v_events bigint := 0;
begin
  -- FOR UPDATE, so two reapers that both saw this tenant expire serialise here
  -- and the loser finds no row.
  select t.kind into v_kind
    from aliquot.tenant t
   where t.id = p_tenant_id
     for update;

  if v_kind is null then
    return query select 0::bigint, 0::bigint, 0::bigint;
    return;
  end if;

  if v_kind <> 'sandbox' then
    raise exception 'tenant % is %, not a sandbox; it is part of the enduring record and will '
                    'not be deleted', p_tenant_id, v_kind
      using errcode = 'insufficient_privilege';
  end if;

  delete from aliquot.upload_part            where tenant_id = p_tenant_id;
  delete from aliquot.upload_session         where tenant_id = p_tenant_id;
  delete from aliquot.derivation_input       where tenant_id = p_tenant_id;
  delete from aliquot.derivation_output      where tenant_id = p_tenant_id;
  delete from aliquot.derivation             where tenant_id = p_tenant_id;
  delete from aliquot.run_artifact           where tenant_id = p_tenant_id;

  -- Before `run`, because artifact.first_seen_run_id points at one.
  delete from aliquot.artifact               where tenant_id = p_tenant_id;
  get diagnostics v_arts = row_count;

  -- One statement for every run in the tenant, so the self-reference through
  -- supersedes_run_id resolves: a non-deferrable foreign key is checked after
  -- the statement completes, not after each row.
  delete from aliquot.run                    where tenant_id = p_tenant_id;
  get diagnostics v_runs = row_count;

  delete from aliquot.membership             where tenant_id = p_tenant_id;
  delete from aliquot.instrument_study_grant where tenant_id = p_tenant_id;
  delete from aliquot.study                  where tenant_id = p_tenant_id;
  delete from aliquot.instrument             where tenant_id = p_tenant_id;
  delete from aliquot.app_user               where tenant_id = p_tenant_id;

  delete from aliquot.audit_event            where tenant_id = p_tenant_id;
  get diagnostics v_events = row_count;

  delete from aliquot.audit_checkpoint       where tenant_id = p_tenant_id;
  delete from aliquot.audit_chain_head       where tenant_id = p_tenant_id;
  delete from aliquot.idempotency_key        where tenant_id = p_tenant_id;
  delete from aliquot.job                    where tenant_id = p_tenant_id;

  delete from aliquot.tenant                 where id = p_tenant_id;

  return query select v_runs, v_arts, v_events;
end
$$;

grant execute on function aliquot.reap_sandbox_tenant(uuid) to aliquot_worker;
