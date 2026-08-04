# ADR-0021: An ephemeral per-visitor tenant, so the public demo can be driven rather than watched

**Status:** Accepted
**Date:** 2026-08-04
**Deciders:** Younes Kaouani

Amends [ADR-0020](0020-read-only-demo-access-for-a-public-deployment.md), which remains in
force. Read-only demo access is still the default way in and is still the only thing the
seeded dataset can be reached through; this adds a second mechanism beside it rather than
replacing it.

## Context

ADR-0020 asked how a public deployment survives being looked at by someone hostile, or
merely bored, and answered it well. The answer optimised for one property — a public
deployment cannot be abused — and in reaching it removed the most convincing thing this
system does.

What a read-only demo can show is a pre-seeded dataset. A visitor reads a run that was
already quarantined, a lineage graph somebody else's worker wrote, and an audit chain that
was sixty-five events long before they arrived. All of it is true and none of it is
demonstrated: what the visitor is looking at is a recording. The claim that matters most —
that this service re-reads the stored bytes, hashes them, and refuses the ones that
disagree with what was declared — is precisely the claim a recording cannot support,
because a recording of software catching its own planted fault is indistinguishable from a
fixture. The reader this deployment exists for has seen a great many repositories whose
README claims more than the code does, and has no reason to grade this one differently.

So the deficiency is specific. It is not that the demo is thin; it is that the one guarantee
a stranger could check in ten minutes without reading code is the one guarantee they are
prevented from checking.

Two constraints shape any fix. The first is small: a public endpoint that does
unauthenticated work will be called in a loop, and this one would do considerably more work
per call than a sign-in. The deployment is a single small box with one API container, one
worker container and a Cloudflare R2 bucket, and bytes written there cost money.

The second is not small, and it is the real content of this decision. **This service's
entire posture is that nothing is ever deleted.** Audit events carry no `DELETE` grant and
a trigger that refuses one; artifacts are immutable; a sealed run is corrected by a
superseding run rather than a mutation ([ADR-0010](0010-correction-by-superseding-record-never-by-mutation.md));
a revoked membership keeps its row so that "who could have written this, and when did that
stop being true" stays answerable years later. Anything that lets a stranger write must
also answer what happens to what they wrote. If it stays, the deployment accumulates other
people's junk for ever and a reviewer's first screen is a list of runs called `test`. If it
goes, something has to delete it, and seven migrations have been spent making deletion
impossible.

## Decision

A visitor may provision a tenant of their own: `POST /v1/sandbox` takes no request body,
creates a tenant marked `kind = 'sandbox'` with an `expires_at` — together with the study,
operator, instrument and grants that make it usable — and returns an **ordinary** operator
session for it. Containment is a quota and a clock rather than a weakened guard, and
`SandboxReaper` deletes the tenant outright when its time is up; the deletion is safe
because `aliquot.reap_sandbox_tenant()` refuses, unconditionally and before it touches
anything, to act on a tenant whose `kind` is not `sandbox`.

## Options considered

### Option A: An ephemeral tenant per visitor, deleted on a TTL

| Dimension | Assessment |
|---|---|
| Complexity | High — a migration, two `SECURITY DEFINER` functions, three replaced triggers, a service, a guard, a reaper |
| What a visitor can demonstrate | The whole lifecycle, including read-back verification catching a byte they corrupted themselves |
| What one visitor can do to another | Nothing; neither can see that the other exists |
| What accumulates | Nothing — the tenant stops existing within the hour |
| Reach | Anyone with the link |
| Failure mode when wrong | A reaper that deletes something that is not a sandbox |

**Pros:** The demonstration becomes first-hand. The visitor declares a manifest, uploads
bytes they chose, flips one of them, and watches the service refuse the artifact and
quarantine the run — with both digests named. The session is an ordinary one with no `demo`
claim, so every role check, every RLS policy and every state-machine transition applies to
it exactly as to a paying tenant; a sandbox that reached the interesting paths by relaxing
a guard would demonstrate that the guards are negotiable rather than that the system works. It also showcases tenant isolation instead of straining
it: the visitor's tenant is empty except for what they put in it, which is the guarantee
made tangible rather than described. And `tenant.kind` gives the schema a word for "outside
the enduring record", which is a distinction it needed and did not have.

**Cons:** It is by a wide margin the most code, and part of it is the most dangerous code in
the repository — the only privileged deleter in a system built on not deleting. It puts
anonymous writes on a public URL and a variable storage bill on a personal deployment. It
requires the immutability triggers of migrations 0003 and 0004 to grow an exception, and an
exception in a trigger whose entire value is that it has none is a real cost, paid
permanently, for a feature that serves visitors rather than customers.

### Option B: One shared sandbox tenant, reset on a schedule

| Dimension | Assessment |
|---|---|
| Complexity | Moderate — one seeded tenant, one endpoint, one scheduled sweep |
| What a visitor can demonstrate | The lifecycle, in a tenant full of strangers' attempts |
| What one visitor can do to another | Seal their run, abandon it, exhaust the shared quota, bury it under noise |
| What accumulates | Everything, until a scheduled mass deletion nobody can attribute |
| Reach | Anyone with the link |
| Failure mode when wrong | The first thing every visitor sees is the previous visitor's mess |

**Pros:** Substantially less machinery. The tenant is created by the seed like any other, so
there is no tenant creation from an API role, no `SECURITY DEFINER` provisioning function,
no random slug and no provisioning transaction that has to be all-or-nothing. Reaping
becomes "delete rows older than an hour in this one tenant", which a scheduled job with
owner rights can do without relaxing any trigger per row. Storage is trivially bounded by a
single quota rather than by a quota multiplied by an unknown number of live sandboxes.

**Cons:** It undercuts the guarantee it exists to showcase. Two visitors in one tenant see
each other's runs, and within a tenant an operator is an operator — so a stranger can seal
the run somebody else is still uploading to, or abandon it, and the state machine will
correctly let them. The demo then teaches the opposite of the headline claim: that this is a
system where other people's work shows up in your list. One person's mess becomes everyone
else's first impression, and the mess is guaranteed rather than likely, because the first
thing anybody types into a public form is not `plate-04-field-001.png`.

It also does not escape the deletion problem, it only hides it. A scheduled sweep is still a
deletion, run more often, protected by a predicate — `where tenant_id = <the sandbox one>
and registered_at < now() - interval '1 hour'` — that a typo can widen into every tenant in
the database. Option A deletes too; the difference is that A's deletion is gated by a
column the schema will not let a caller choose, and B's is gated by a `WHERE` clause.

### Option C: Stay read-only

| Dimension | Assessment |
|---|---|
| Complexity | None — this is what is deployed |
| What a visitor can demonstrate | Nothing they did not read |
| What one visitor can do to another | Nothing |
| What accumulates | Nothing |
| Reach | Anyone with the link |
| Failure mode when wrong | None. It is already correct, and already insufficient |

**Pros:** It is free in every dimension. No anonymous writes, no storage that varies with
traffic, nothing to reap, no exception in any trigger, and no new surface to be wrong about.
It is also the honest opportunity-cost argument: every hour spent here is an hour not spent
on `audit_checkpoint.external_ref`, which is a real gap in a guarantee this repository
actually claims, whereas an unconvincing demo is a presentation problem. That argument is
not a strawman and it very nearly won.

**Cons:** It leaves the strongest claim in the system as the one a reader is least able to
check. On a read-only deployment, "read-back verification catches a corrupted byte and
quarantines the run" is a paragraph beside a screenshot of a run that already says
`QUARANTINED`, seeded by the same author who wrote the paragraph. There is no way for the
reader to close that gap from the browser, and asking them to close it by cloning the
repository is Option D, whose reach is discussed there.

### Option D: A write demo that only runs under `docker compose`

| Dimension | Assessment |
|---|---|
| Complexity | Low — a driver script, and no production surface at all |
| What a visitor can demonstrate | Everything, including tamper detection, after cloning |
| What one visitor can do to another | Nothing |
| What accumulates | Their own disk |
| Reach | Only people who will clone a repository |
| Failure mode when wrong | It breaks on a stranger's laptop and nobody ever says so |

**Pros:** Free on the deployment in every sense that matters — no anonymous writes, no
storage bill, no reaper, no privileged deletion, nothing new that can be attacked. It also
already exists: `scripts/demo.ts` drives the full lifecycle end to end, including the one
thing no public option can ever show, because it needs owner rights on the database —
disabling the append-only trigger, rewriting an event, and watching verification name the
exact sequence number that broke.

**Cons:** Reach, which is the entire point of having a deployment. The reader who followed a
link and has ten minutes will not clone a repository, install Docker, wait for Postgres and
MinIO to become healthy and then read a script's output; the population that will do that
overlaps almost exactly with the population already persuaded. It also fails silently — a
compose stack that breaks on somebody else's machine produces no bug report, only a closed
tab. This option stays, and is where the tamper demonstration continues to live; it is
simply not a substitute for something a stranger can press.

## Trade-off analysis

Option C was the hardest to argue against, and it lost on one sentence: the value of this
repository to a reader is entirely the credibility of its claims, and there is exactly one
claim a reader can verify in ten minutes without reading code — that corrupt bytes are
caught — which is the claim C withholds. Everything else here is downstream of accepting
that.

Option B is worth naming because it is the shape of the cheaper answer, and because it fails
in an instructive way. It is not merely a weaker demo; it is a demo that argues against the
product. Tenant isolation is the first of the five guarantees, and B's visitor experience is
strangers appearing in your list of runs and sealing work you had not finished. When the
cheap option contradicts the headline claim, the cost of the expensive option is buying the
claim back.

### The tension this decision actually has to resolve

**This service's posture is that nothing is ever deleted, and the reaper deletes.** That is
not a detail to be noted and moved past. Three immutability triggers had to grow an
exception to permit it, and those triggers are the reason the immutability claim is worth
anything: they hold for roles the grants were never checked against, for a `psql` session
and for a migration.

It is reconcilable only if "the record" is defined, and `tenant.kind` is where it gets
defined. ALCOA+ asks that a record be Enduring: it must outlive the system, the staff and
the study that produced it. A sandbox tenant is not a record. It is a stranger pressing the
buttons for an hour to see what the buttons do, against synthetic bytes they invented, with
an expiry fixed before the first one was pressed. Enduring is a property demanded of
evidence, and there is no evidence here to demand it of.

The load-bearing word in that paragraph is *is*, and the mechanism exists to make it a fact
about the schema rather than a convention in a service method:

- `kind` is `NOT NULL` with a `permanent` default, so every tenant that already existed —
  and every tenant created by any future code path that has never heard of sandboxes — is
  permanent without anyone deciding so.
- `expires_at` is tied to `kind` by a biconditional `CHECK`, so "a sandbox with no expiry"
  (never reaped, silently permanent storage nobody owns) and "a permanent tenant with a date
  on it" (a customer with a countdown) are states the table cannot represent.
- `aliquot.reap_sandbox_tenant()` takes a tenant id, reads its kind under `FOR UPDATE`, and
  raises before touching anything if it is not `sandbox`. It has no predicate a caller can
  get subtly wrong, no partial mode, and no argument that points it at a permanent tenant. A
  reaper protected only by its own `WHERE` clause would be one typo from deleting a
  customer; this one can have its `WHERE` clause deleted entirely and still not.

What that argument buys is not that the deletion is invisible or safe by construction. It is
that the blast radius is nameable, is stated in the schema, and is enforced one layer below
the code most likely to be wrong.

### Residual risks

- **Anonymous writes on a public URL, bounded only by quota, rate limit and TTL.** Nothing
  identifies the caller; the limiter keys on source address and a determined caller has
  many. What actually bounds the damage is that each tenant is a hard ceiling on runs and
  bytes and stops existing within the hour, so the worst realistic case is a bill and a busy
  worker rather than a corrupted dataset. There is no global cap on the number of live
  sandboxes, which is the first thing to add if this is ever abused in practice.
- **Storage cost varies with traffic.** The exposure is live sandboxes multiplied by
  `SANDBOX_MAX_TOTAL_BYTES`, which at the deployed values is 32 MiB each for at most an
  hour. That is affordable and it is not zero, and there is no bucket lifecycle rule
  configured to act as a second net beneath the reaper.
- **The reaper is the one privileged deleter in the system, and a bug in its predicate is
  the worst failure mode available here.** The protections above are real, but they are
  protections: the function runs as the migration owner, execute is granted to
  `aliquot_worker` alone, and the test that matters asserts against the function directly
  rather than through the reaper, precisely because the reaper is the part that might one
  day be wrong.
- **Content-addressed objects are shared across tenants.** Storage keys derive from the
  digest alone ([ADR-0003](0003-content-addressed-object-storage-keyed-by-sha-256.md)) while
  `artifact` rows are per tenant ([ADR-0017](0017-tenant-scoped-rather-than-global-content-deduplication.md)),
  so a sandbox and a permanent tenant holding identical bytes hold two rows and one object.
  Deleting a sandbox's objects by walking its own rows would delete bytes the permanent
  tenant still points at, and the symptom is the worst kind available: that tenant's run
  goes on reporting itself `VERIFIED`, its manifest still digests correctly, and the
  download 404s. This is implemented — `digests_referenced_elsewhere()`, called *after* the
  rows are gone so that "referenced by another tenant" and "referenced at all" are the same
  question. Note what that function is: the existence oracle ADR-0017 declined to build. It
  is granted to `aliquot_worker` alone and is unreachable from any request path, and if it
  were ever granted to `aliquot_app`, ADR-0017 would stop being true.
- **The rate limiter is per instance and in memory**, exactly as ADR-0020 recorded — and it
  now guards something considerably more expensive than a sign-in. Two replicas allow twice
  the configured rate, and a restart forgets every window.
- **The trigger exception is permanent and has exactly one shape.** The three triggers now
  permit a `DELETE` of a row whose tenant is a sandbox and refuse everything else as before.
  Anything that ever holds both `DELETE` on `audit_event` and a sandbox tenant id will not
  be stopped by them; what stops it today is that neither `aliquot_app` nor `aliquot_worker`
  holds that privilege at all.
- **A reap is not audited**, because the only chain it could be recorded in is the one being
  deleted. The reaper's log line, carrying the counts, is the whole record.

## Consequences

**Easier:** A stranger can produce the quarantine instead of reading about it, and can watch
an audit chain grow from `seq 1` — which the seeded demo structurally cannot show, since its
chain was long before the visitor arrived. The demo and the sandbox compose rather than
compete: read the seeded dataset, then go and make one. Because the session issued is
ordinary, the public deployment is also a continuous live exercise of the real authorisation
path, rather than of a demo-shaped subset of it. And `tenant.kind` gives the schema a
vocabulary for data that is deliberately outside the enduring record, which is a distinction
worth having independently of this feature.

**Harder:** There is now a code path in this service that deletes, and it is a permanent
obligation. Every tenant-scoped table added by a future migration must be added to
`reap_sandbox_tenant()`; the foreign keys are deliberately left enabled so that forgetting
fails loudly instead of orphaning rows, but it will be forgotten at least once, and the
integration suite enumerates tables from the catalogue for that reason. The immutability
triggers now have a branch, so reading one no longer answers "can this row ever be deleted"
without also reading `is_sandbox_tenant()`. Sandbox provisioning is the third caller of
`withoutTenantScope()`, whose comment says there should not be one without an argument.
Deployment gains a storage bill that varies with strangers' traffic, and two configuration
values with an ordering constraint that is checked at boot because getting it backwards
yields a sandbox in which the first upload always fails.

**To revisit:** Evidence of actual abuse — sustained provisioning from many addresses —
which argues for a global cap on live sandboxes rather than a tighter per-address rate. A
second API replica, at which point the in-memory limiter is wrong for this endpoint as well
as for the demo one. A viewer that drives the sandbox from the browser, which is the obvious
next step and is not built: today a visitor needs a terminal, which cuts the audience for
the best thing on the site. Any observation that the reaper deleted something it should not
have, which would mean this decision is wrong rather than merely mis-implemented, and would
argue for moving sandboxes into a separate database where deletion is not a shared
capability at all.

## Action items

1. - [x] `tenant.kind` and `expires_at` in `migrations/0008_sandbox_tenants.sql`, `NOT NULL`
   with a `permanent` default and a biconditional `CHECK` tying expiry to kind.
2. - [x] Partial index `tenant_sandbox_expiry_idx` on `(kind, expires_at)` so the reaper's
   scan never touches a permanent tenant.
3. - [x] `provision_sandbox_tenant()` as `SECURITY DEFINER`, with `kind` a literal in the
   body, a 1–1440 minute ceiling in the database as well as in configuration, and
   `ON CONFLICT DO NOTHING` so a slug collision costs a retry rather than the transaction.
4. - [x] `reap_sandbox_tenant()` as `SECURITY DEFINER`, refusing any tenant that is not a
   sandbox before it deletes anything, granted to `aliquot_worker` alone.
5. - [x] `digests_referenced_elsewhere()` with a `rolsuper`/`rolbypassrls` assertion, so a
   definer that cannot see other tenants fails loudly instead of reporting every digest
   unshared.
6. - [x] The three immutability triggers relaxed per row for sandbox tenants only, rather
   than by `session_replication_role = 'replica'`, which would also disable the foreign key
   checks the delete order depends on.
7. - [x] `SANDBOX_MODE` and seven `SANDBOX_*` values in `src/config/config.ts`, permitted in
   production, with a boot refusal when the per-artifact cap exceeds the tenant cap.
8. - [x] `POST /v1/sandbox` taking no request body, 404 when disabled, rate limited on its
   own budget; `GET /v1/sandbox` reporting quota and usage.
9. - [x] An ordinary session with no `demo` claim — admin of the sandbox tenant and nothing
   else — so `DemoReadOnlyGuard` does not apply and every role check runs as it does for a
   paying tenant. Admin rather than operator because `POST /v1/audit/verify` requires
   steward or above, and a visitor who can watch their own chain grow but not ask whether
   it is intact has been stopped one step short of the point. The privilege is bounded by
   the tenant, not by the role; `SANDBOX_MAX_WRITES` is what stops `admin` meaning
   "create ten thousand instruments".
10. - [x] `SandboxQuotaGuard` bound as an `APP_GUARD` after `AuthGuard` and
    `DemoReadOnlyGuard`, exempting safe methods and permanent tenants.
11. - [x] Per-artifact size refused at registration in
    `SandboxService.assertDeclarationsWithinQuota`, before any upload URL exists.
12. - [x] `SandboxExpiredError`, `SandboxQuotaExceededError` and `ArtifactTooLargeError` in
    `src/common/problem-details.ts`.
13. - [x] `SandboxReaper` in the worker process only, in batches, rows before objects, with
    the shared-object reference check after the rows are gone.
14. - [x] `test/integration/sandbox.spec.ts`: an ordinary session, quota refused at
    registration, a permanent tenant that cannot be reaped, and a shared object spared.
15. - [x] The variables documented in `.env.example` and `deploy/aliquot.env.example`, and a
    sandbox scenario in `docs/WALKTHROUGH.md`.
16. - [ ] A "Start a sandbox" control in the viewer, so the lifecycle can be driven without
    a terminal.
17. - [ ] A global cap on concurrently live sandboxes, independent of the per-address rate.
18. - [ ] An R2 lifecycle rule expiring objects the reaper failed to delete, as a second net.
19. - [ ] Move the rate-limit window to PostgreSQL if a second API replica is ever deployed.
