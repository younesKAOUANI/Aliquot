-- 0006_provenance.sql
--
-- Derivations: the record of a processing activity that consumed artifacts and
-- produced artifacts.
--
-- The shape follows W3C PROV rather than being invented (ADR-008):
--
--   artifact    -> prov:Entity
--   run         -> prov:Activity  (acquisition)
--   derivation  -> prov:Activity  (computation)
--   app_user    -> prov:Agent     (prov:Person)
--   instrument  -> prov:Agent     (prov:SoftwareAgent / device)
--
-- Using the standard vocabulary is not decoration. It means provenance can be
-- exported to PROV-JSON and consumed by tooling that already exists, instead of
-- being trapped in a shape only this service understands.

create table aliquot.derivation (
  id                 uuid primary key,
  tenant_id          uuid not null references aliquot.tenant(id),

  processor_name     text not null check (processor_name ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  -- Semver of the code that ran. This is the column that makes "a processing
  -- bug was found -- what is affected?" a query rather than an investigation.
  processor_version  text not null,

  parameters         jsonb not null default '{}'::jsonb,
  parameters_digest  aliquot.sha256_hex not null,

  -- sha256 over the canonicalised, order-normalised list of input artifact
  -- digests. Order-normalised because the same inputs in a different order are
  -- the same inputs; a positional digest would let an identical job run twice.
  inputs_digest      aliquot.sha256_hex not null,

  started_at         timestamptz not null default clock_timestamp(),
  completed_at       timestamptz,

  -- Origin run, kept for the common query "what did processing this run
  -- produce" without walking the artifact graph.
  source_run_id      uuid references aliquot.run(id),

  -- This constraint *is* the worker's idempotency guarantee. Re-running
  -- identical work cannot create a second derivation record, so a worker that
  -- crashes after writing output but before acknowledging the job converges on
  -- retry instead of duplicating.
  constraint derivation_identity_unique
    unique (tenant_id, inputs_digest, processor_name, processor_version, parameters_digest)
);

create index derivation_source_run_idx on aliquot.derivation (tenant_id, source_run_id);

select aliquot.apply_tenant_rls('derivation');
grant select, insert, update on aliquot.derivation to aliquot_app, aliquot_worker;
revoke delete, truncate on aliquot.derivation from aliquot_app, aliquot_worker;

create table aliquot.derivation_input (
  tenant_id      uuid not null references aliquot.tenant(id),
  derivation_id  uuid not null references aliquot.derivation(id),
  artifact_id    uuid not null references aliquot.artifact(id),
  -- What this input was to the activity: 'primary', 'reference', 'calibration'.
  -- prov:qualifiedUsage carries the same idea.
  role           text not null default 'primary',

  primary key (derivation_id, artifact_id)
);

create index derivation_input_artifact_idx
  on aliquot.derivation_input (tenant_id, artifact_id);

select aliquot.apply_tenant_rls('derivation_input');
grant select, insert on aliquot.derivation_input to aliquot_app, aliquot_worker;
revoke update, delete, truncate on aliquot.derivation_input from aliquot_app, aliquot_worker;

create table aliquot.derivation_output (
  tenant_id      uuid not null references aliquot.tenant(id),
  derivation_id  uuid not null references aliquot.derivation(id),
  artifact_id    uuid not null references aliquot.artifact(id),
  logical_name   text not null,

  primary key (derivation_id, artifact_id)
);

create index derivation_output_artifact_idx
  on aliquot.derivation_output (tenant_id, artifact_id);

select aliquot.apply_tenant_rls('derivation_output');
grant select, insert on aliquot.derivation_output to aliquot_app, aliquot_worker;
revoke update, delete, truncate on aliquot.derivation_output from aliquot_app, aliquot_worker;

-- ---------------------------------------------------------------------------
-- Lineage traversal
-- ---------------------------------------------------------------------------
--
-- Recursive CTE, which is the right tool up to a few thousand nodes and the
-- wrong one beyond that. The depth cap is not a performance guard; it is a
-- cycle guard. Cycles should be impossible -- an artifact is content-addressed
-- and cannot be produced by an activity that consumed it, since that would
-- require knowing its digest before computing it -- but "should be impossible"
-- is not a reason to let a query run forever if the invariant is ever broken.

create or replace function aliquot.artifact_ancestors(p_artifact_id uuid, p_max_depth integer default 32)
returns table (
  artifact_id    uuid,
  depth          integer,
  derivation_id  uuid,
  via_role       text
)
language sql stable
as $$
  with recursive walk as (
    select a.id as artifact_id, 0 as depth, null::uuid as derivation_id, null::text as via_role
      from aliquot.artifact a
     where a.id = p_artifact_id

    union all

    select di.artifact_id, w.depth + 1, d.id, di.role
      from walk w
      join aliquot.derivation_output dout on dout.artifact_id = w.artifact_id
      join aliquot.derivation d           on d.id = dout.derivation_id
      join aliquot.derivation_input di    on di.derivation_id = d.id
     where w.depth < p_max_depth
  )
  select distinct on (artifact_id, derivation_id)
         artifact_id, depth, derivation_id, via_role
    from walk
   order by artifact_id, derivation_id, depth;
$$;

create or replace function aliquot.artifact_descendants(p_artifact_id uuid, p_max_depth integer default 32)
returns table (
  artifact_id    uuid,
  depth          integer,
  derivation_id  uuid,
  via_role       text
)
language sql stable
as $$
  with recursive walk as (
    select a.id as artifact_id, 0 as depth, null::uuid as derivation_id, null::text as via_role
      from aliquot.artifact a
     where a.id = p_artifact_id

    union all

    select dout.artifact_id, w.depth + 1, d.id, di.role
      from walk w
      join aliquot.derivation_input di  on di.artifact_id = w.artifact_id
      join aliquot.derivation d         on d.id = di.derivation_id
      join aliquot.derivation_output dout on dout.derivation_id = d.id
     where w.depth < p_max_depth
  )
  select distinct on (artifact_id, derivation_id)
         artifact_id, depth, derivation_id, via_role
    from walk
   order by artifact_id, derivation_id, depth;
$$;

grant execute on function aliquot.artifact_ancestors(uuid, integer) to aliquot_app, aliquot_worker;
grant execute on function aliquot.artifact_descendants(uuid, integer) to aliquot_app, aliquot_worker;

-- ---------------------------------------------------------------------------
-- PROV projection
-- ---------------------------------------------------------------------------
--
-- Views rather than a second copy of the data. The PROV vocabulary is an export
-- format, not a storage format; materialising it would create two sources of
-- truth that can disagree.
--
-- security_invoker is not optional here. Without it a view executes with the
-- privileges of its owner, so the underlying tables' RLS policies are evaluated
-- against the owner rather than the calling role -- and a view over an
-- RLS-protected table silently becomes a hole straight through tenant
-- isolation. This is the single easiest way to undo everything in 0001.

create or replace view aliquot.prov_entity with (security_invoker = true) as
  select a.tenant_id,
         a.id                                    as entity_id,
         'aliquot:artifact/' || a.id::text       as prov_id,
         a.digest,
         a.size_bytes,
         a.media_type,
         a.created_at                            as generated_at
    from aliquot.artifact a;

create or replace view aliquot.prov_activity with (security_invoker = true) as
  select r.tenant_id,
         r.id                              as activity_id,
         'aliquot:run/' || r.id::text      as prov_id,
         'acquisition'                     as activity_kind,
         r.registered_at                   as started_at,
         r.sealed_at                       as ended_at
    from aliquot.run r
  union all
  select d.tenant_id,
         d.id                                 as activity_id,
         'aliquot:derivation/' || d.id::text  as prov_id,
         'computation'                        as activity_kind,
         d.started_at,
         d.completed_at
    from aliquot.derivation d;

create or replace view aliquot.prov_agent with (security_invoker = true) as
  select u.tenant_id,
         u.id                                as agent_id,
         'aliquot:user/' || u.id::text       as prov_id,
         'prov:Person'                       as prov_type,
         u.display_name                      as label
    from aliquot.app_user u
  union all
  select i.tenant_id,
         i.id                                   as agent_id,
         'aliquot:instrument/' || i.id::text    as prov_id,
         'prov:SoftwareAgent'                   as prov_type,
         i.display_name                         as label
    from aliquot.instrument i;

grant select on aliquot.prov_entity, aliquot.prov_activity, aliquot.prov_agent
  to aliquot_app, aliquot_worker;
