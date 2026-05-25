-- 0002_tenancy.sql
--
-- Tenants, studies, principals, and membership.
--
-- The tenant table is the one table that is deliberately NOT tenant-scoped by
-- RLS: it is the anchor the policies resolve against, and a policy on it would
-- be circular. It is instead protected by grants -- the application may read it
-- but never write it. Tenant creation is an administrative operation performed
-- by the migration/owner role.

create table aliquot.tenant (
  id          uuid primary key,
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text not null,
  created_at  timestamptz not null default clock_timestamp()
);

comment on table aliquot.tenant is
  'Isolation root. Not RLS-scoped -- it is what the policies resolve against.';

grant select on aliquot.tenant to aliquot_app, aliquot_worker;

-- ---------------------------------------------------------------------------
-- Principals
-- ---------------------------------------------------------------------------
--
-- Two kinds, kept structurally distinct rather than unified behind a
-- "principal" table with a discriminator. A user has an email and a session; an
-- instrument has a serial number and a long-lived credential. Forcing them into
-- one table would mean half the columns are null for half the rows, and the
-- provenance model genuinely wants to say "acquired by instrument X, operated
-- by human Y" as two separate facts.

create table aliquot.app_user (
  id            uuid primary key,
  tenant_id     uuid not null references aliquot.tenant(id),
  email         text not null check (email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  display_name  text not null,
  created_at    timestamptz not null default clock_timestamp(),
  disabled_at   timestamptz
);

-- Expression index rather than a table constraint: uniqueness has to be on the
-- case-folded address, and a UNIQUE constraint cannot take an expression.
create unique index app_user_email_unique_per_tenant
  on aliquot.app_user (tenant_id, lower(email));

select aliquot.apply_tenant_rls('app_user');
grant select, insert, update on aliquot.app_user to aliquot_app, aliquot_worker;

create table aliquot.instrument (
  id             uuid primary key,
  tenant_id      uuid not null references aliquot.tenant(id),
  slug           text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name   text not null,
  manufacturer   text,
  model          text,
  serial_number  text,
  -- Argon2id hash of the API key. The key itself is shown once at registration
  -- and never stored; there is no recovery path, only re-issue.
  api_key_hash   text not null,
  -- First 12 characters of the key, stored in clear, so an incoming credential
  -- can be located with an index lookup instead of hashing against every row.
  api_key_prefix text not null,
  created_at     timestamptz not null default clock_timestamp(),
  disabled_at    timestamptz,

  constraint instrument_slug_unique_per_tenant unique (tenant_id, slug)
);

create unique index instrument_api_key_prefix_idx
  on aliquot.instrument (api_key_prefix);

select aliquot.apply_tenant_rls('instrument');
grant select, insert, update on aliquot.instrument to aliquot_app, aliquot_worker;

-- ---------------------------------------------------------------------------
-- Studies and membership
-- ---------------------------------------------------------------------------

create table aliquot.study (
  id           uuid primary key,
  tenant_id    uuid not null references aliquot.tenant(id),
  slug         text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  title        text not null,
  description  text,
  created_at   timestamptz not null default clock_timestamp(),
  closed_at    timestamptz,

  constraint study_slug_unique_per_tenant unique (tenant_id, slug)
);

select aliquot.apply_tenant_rls('study');
grant select, insert, update on aliquot.study to aliquot_app, aliquot_worker;

-- Roles are per (user, study) rather than global per user. A scientist on one
-- study is frequently not entitled to another study in the same organisation --
-- blinded arms, competing programmes, human subject data with a narrower
-- consent scope. A tenant-global role would make that inexpressible.
create type aliquot.study_role as enum ('operator', 'scientist', 'steward', 'admin');

create table aliquot.membership (
  id          uuid primary key,
  tenant_id   uuid not null references aliquot.tenant(id),
  study_id    uuid not null references aliquot.study(id),
  user_id     uuid not null references aliquot.app_user(id),
  role        aliquot.study_role not null,
  granted_at  timestamptz not null default clock_timestamp(),
  granted_by  uuid references aliquot.app_user(id),
  revoked_at  timestamptz,

  constraint membership_unique_per_study_user unique (tenant_id, study_id, user_id)
);

create index membership_user_idx on aliquot.membership (tenant_id, user_id)
  where revoked_at is null;

select aliquot.apply_tenant_rls('membership');
grant select, insert, update on aliquot.membership to aliquot_app, aliquot_worker;

-- An instrument is authorised against the studies it may deposit into. Without
-- this, any instrument credential could register a run into any study in the
-- tenant, which makes the instrument credential -- a long-lived secret sitting
-- on an acquisition workstation in a shared lab -- far more dangerous than it
-- needs to be.
create table aliquot.instrument_study_grant (
  tenant_id      uuid not null references aliquot.tenant(id),
  instrument_id  uuid not null references aliquot.instrument(id),
  study_id       uuid not null references aliquot.study(id),
  granted_at     timestamptz not null default clock_timestamp(),
  granted_by     uuid references aliquot.app_user(id),

  primary key (instrument_id, study_id)
);

select aliquot.apply_tenant_rls('instrument_study_grant');
grant select, insert, delete on aliquot.instrument_study_grant to aliquot_app, aliquot_worker;
