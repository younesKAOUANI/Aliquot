-- 0001_foundation.sql
--
-- Roles, schema, extensions, and the session-scoped helpers that row-level
-- security depends on.
--
-- Roles are cluster-level objects, so creating them inside a migration is
-- slightly unusual. It is done here deliberately: the same migration set has to
-- produce an identical database under docker compose and under Testcontainers,
-- and a Testcontainers Postgres has no init scripts of ours. Making role
-- creation idempotent is cheaper than maintaining two bootstrap paths that can
-- drift apart -- and a drifted bootstrap path means the isolation tests are
-- exercising a database that is not the one we ship.

-- No extensions. sha256() and gen_random_uuid() have both been core since
-- PostgreSQL 13, so pgcrypto buys nothing here, and an extension is a real
-- constraint on where this can be deployed -- several managed Postgres
-- offerings gate extension installation behind a support ticket.

create schema if not exists aliquot;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
--
-- aliquot_app     the API process. Tenant-scoped by RLS at all times.
-- aliquot_worker  the processing tier. Identical to aliquot_app for domain
--                 tables, plus the ability to see the job queue across tenants
--                 -- it has to, in order to claim work it does not yet know the
--                 tenant of. Having claimed a job it sets app.tenant_id from
--                 the job row and is scoped exactly like the API from then on.
--
-- Neither role has BYPASSRLS. Neither role is a superuser. This is asserted at
-- startup (see src/database/rls-assertions.ts) because a deployment that
-- accidentally hands the application a privileged role silently loses the
-- second layer of isolation while every test still passes.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'aliquot_app') then
    create role aliquot_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'aliquot_worker') then
    create role aliquot_worker nologin;
  end if;
end
$$;

alter role aliquot_app nobypassrls nosuperuser;
alter role aliquot_worker nobypassrls nosuperuser;

grant usage on schema aliquot to aliquot_app, aliquot_worker;

-- ---------------------------------------------------------------------------
-- Session context
-- ---------------------------------------------------------------------------
--
-- Every request runs inside a transaction that issues
--
--     SET LOCAL app.tenant_id = '<uuid>';
--     SET LOCAL app.actor_id  = '<uuid>';
--     SET LOCAL app.actor_type = 'user' | 'instrument' | 'system';
--
-- SET LOCAL rather than SET: the value must die with the transaction. A plain
-- SET survives on a pooled connection and the next request inherits the
-- previous request's tenant, which is the precise failure this whole layer
-- exists to prevent.
--
-- current_tenant_id() returns NULL when the setting is absent rather than
-- raising. That is what makes the policies deny-by-default: every policy
-- compares tenant_id against this function, and `tenant_id = NULL` is NULL,
-- which RLS treats as false. A request that forgets to set the variable sees
-- zero rows instead of every row.

create or replace function aliquot.current_tenant_id() returns uuid
language sql stable
as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid;
$$;

create or replace function aliquot.current_actor_id() returns uuid
language sql stable
as $$
  select nullif(current_setting('app.actor_id', true), '')::uuid;
$$;

create or replace function aliquot.current_actor_type() returns text
language sql stable
as $$
  select nullif(current_setting('app.actor_type', true), '');
$$;

grant execute on function aliquot.current_tenant_id() to aliquot_app, aliquot_worker;
grant execute on function aliquot.current_actor_id() to aliquot_app, aliquot_worker;
grant execute on function aliquot.current_actor_type() to aliquot_app, aliquot_worker;

-- ---------------------------------------------------------------------------
-- Shared conventions
-- ---------------------------------------------------------------------------

-- A SHA-256 digest in lower-case hex. Used pervasively; the domain is here so
-- that "a column that holds a digest" is a single decision rather than twelve.
create domain aliquot.sha256_hex as text
  check (value ~ '^[0-9a-f]{64}$');

-- Actor of an audited action. Instruments are first-class principals, not a
-- special case of a user account, because "which machine produced this" is a
-- question the provenance model has to answer directly.
create type aliquot.actor_type as enum ('user', 'instrument', 'system');

-- Applying row-level security is three statements that must all be present and
-- are easy to get partially right. Wrapping them means "this table is tenant
-- scoped" is one line at the point of table creation, and the FORCE -- the one
-- most likely to be forgotten, and the one that matters when migrations run as
-- the table owner -- cannot be omitted independently.
create or replace function aliquot.apply_tenant_rls(p_table text) returns void
language plpgsql
as $$
begin
  execute format('alter table aliquot.%I enable row level security', p_table);
  execute format('alter table aliquot.%I force row level security', p_table);
  execute format(
    'create policy tenant_isolation on aliquot.%I '
    'using (tenant_id = aliquot.current_tenant_id()) '
    'with check (tenant_id = aliquot.current_tenant_id())',
    p_table
  );
end
$$;

-- Schema-level default privileges are not used. Every table grants explicitly
-- in the migration that creates it, so that reading a migration tells you the
-- full privilege story for the tables it introduces. audit_event in particular
-- depends on NOT being granted UPDATE or DELETE, and a default grant that
-- quietly handed those out would be very hard to notice.
