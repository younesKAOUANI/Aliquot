-- 0007_jobs.sql
--
-- The job queue (ADR-004).
--
-- This table exists so that enqueueing work and the state change that
-- justifies it are the same transaction. Sealing a run inserts the job; if the
-- seal rolls back, so does the job; if the process dies between them, there is
-- no "between them". That is the entire argument for keeping the queue in
-- Postgres, and it is worth more here than the throughput a broker would buy.

create type aliquot.job_state as enum ('PENDING', 'ACTIVE', 'COMPLETED', 'DEAD');

create table aliquot.job (
  id                uuid primary key,
  tenant_id         uuid not null references aliquot.tenant(id),

  queue             text not null check (queue ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  payload           jsonb not null default '{}'::jsonb,

  state             aliquot.job_state not null default 'PENDING',
  priority          integer not null default 0,

  -- Deduplication at enqueue time. Sealing is itself idempotent, so the same
  -- seal replayed through an idempotency key must not enqueue twice; the
  -- conflict is treated as "already enqueued", which is success.
  dedupe_key        text,

  attempts          integer not null default 0,
  max_attempts      integer not null default 5,

  run_after         timestamptz not null default clock_timestamp(),
  lease_expires_at  timestamptz,
  claimed_by        text,
  last_error        text,

  created_at        timestamptz not null default clock_timestamp(),
  started_at        timestamptz,
  completed_at      timestamptz
);

create unique index job_dedupe_idx
  on aliquot.job (tenant_id, queue, dedupe_key)
  where dedupe_key is not null;

-- The claim index. Partial on PENDING because the ready set is tiny relative to
-- history, and history is never scanned by the hot path.
create index job_claimable_idx
  on aliquot.job (queue, priority desc, run_after)
  where state = 'PENDING';

-- Lease reclamation. Separate index because it is scanned by a different
-- predicate and folding them together would make both worse.
create index job_lease_idx
  on aliquot.job (lease_expires_at)
  where state = 'ACTIVE';

create index job_dead_idx
  on aliquot.job (tenant_id, completed_at desc)
  where state = 'DEAD';

alter table aliquot.job enable row level security;
alter table aliquot.job force row level security;

-- Two policies, and the asymmetry is the point.
--
-- The API is tenant-scoped like everything else: it enqueues into its own
-- tenant and can inspect its own queue depth, nothing more.
create policy tenant_isolation on aliquot.job
  using (tenant_id = aliquot.current_tenant_id())
  with check (tenant_id = aliquot.current_tenant_id());

-- The worker cannot be tenant-scoped at claim time, because the whole point of
-- claiming is to discover which tenant's work is next. It therefore sees the
-- queue across tenants -- and only the queue. Having claimed a job it sets
-- app.tenant_id from job.tenant_id and is scoped exactly like the API for every
-- domain table it subsequently touches. The privilege is bounded to the one
-- table where cross-tenant visibility is structurally unavoidable, rather than
-- being handed out as a blanket BYPASSRLS.
create policy worker_claims_across_tenants on aliquot.job
  to aliquot_worker
  using (true)
  with check (true);

grant select, insert, update on aliquot.job to aliquot_app, aliquot_worker;
revoke delete, truncate on aliquot.job from aliquot_app, aliquot_worker;

-- ---------------------------------------------------------------------------
-- Claiming
-- ---------------------------------------------------------------------------
--
-- FOR UPDATE SKIP LOCKED is what makes this a queue rather than a table N
-- workers fight over. Each worker locks only rows nobody else holds and never
-- blocks on a contended row.
--
-- Expired leases are reclaimed in the same statement as new work. A worker that
-- died mid-job leaves an ACTIVE row whose lease runs out; the next poll picks
-- it up with attempts already incremented, so a job that reliably kills its
-- worker still walks its retry budget down to DEAD instead of looping forever.

create or replace function aliquot.claim_jobs(
  p_queue         text,
  p_worker_id     text,
  p_limit         integer default 1,
  p_lease_seconds integer default 300
) returns setof aliquot.job
language sql
as $$
  update aliquot.job j
     set state            = 'ACTIVE',
         attempts         = j.attempts + 1,
         claimed_by       = p_worker_id,
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         started_at       = coalesce(j.started_at, clock_timestamp())
   where j.id in (
     select c.id
       from aliquot.job c
      where c.queue = p_queue
        and (
              (c.state = 'PENDING' and c.run_after <= clock_timestamp())
           or (c.state = 'ACTIVE'  and c.lease_expires_at < clock_timestamp())
        )
      order by c.priority desc, c.run_after
      limit p_limit
        for update skip locked
   )
  returning j.*;
$$;

grant execute on function aliquot.claim_jobs(text, text, integer, integer) to aliquot_worker;

-- Releasing a failed job. Backoff is exponential with a ceiling; exhausting the
-- attempt budget moves the job to DEAD with the failure text retained, because
-- a dead-letter queue that discards the reason is a dead-letter queue nobody
-- can act on.
create or replace function aliquot.release_job(
  p_job_id    uuid,
  p_error     text,
  p_base_secs integer default 5,
  p_max_secs  integer default 3600
) returns aliquot.job
language sql
as $$
  update aliquot.job j
     set state = case when j.attempts >= j.max_attempts then 'DEAD'::aliquot.job_state
                      else 'PENDING'::aliquot.job_state end,
         run_after = clock_timestamp()
                   + make_interval(secs => least(p_max_secs, p_base_secs * power(2, j.attempts - 1)::integer)),
         lease_expires_at = null,
         claimed_by = null,
         last_error = p_error,
         completed_at = case when j.attempts >= j.max_attempts then clock_timestamp() else null end
   where j.id = p_job_id
  returning j.*;
$$;

grant execute on function aliquot.release_job(uuid, text, integer, integer) to aliquot_worker;
