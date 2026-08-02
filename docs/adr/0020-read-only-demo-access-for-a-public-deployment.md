# ADR-0020: Read-only demo access as a separate mechanism, not a relaxed development one

**Status:** Accepted
**Date:** 2026-08-02
**Deciders:** Younes Kaouani

## Context

This service is about to be deployed at a public URL so that people can look at it. The
reader we care about arrives without a credential, without having asked anyone for one, and
with about ten minutes of patience. If they cannot see a run, a lineage graph and a verified
audit chain inside that window, the deployment has achieved nothing that the repository did
not already achieve more cheaply.

Today there is exactly one way to obtain a session: `POST /v1/auth/token`, which takes an
email address and a tenant slug and mints a session for whoever they name, with no credential
of any kind. That is a complete authentication bypass, and it is treated as one — it is off by
default, the controller answers 404 when it is off, and `AppConfig` refuses to start a process
with `NODE_ENV=production` and `AUTH_DEV_TOKEN_ENDPOINT=true`. Three gates for one switch.

So the decision is forced by a collision: the only existing way in is the one thing that must
never be reachable from the internet, and the deployment must be reachable from the internet
to be worth doing.

What breaks if this is got wrong is the whole point of the exercise. The five guarantees this
service exists to provide include tenant isolation enforced below the application and an audit
chain nobody can rewrite. A demo that reaches those by turning off the mechanism that protects
them is not a demonstration of the guarantees; it is a demonstration that the guarantees are
negotiable when they are inconvenient. The data behind the URL is synthetic and worthless, but
the credibility of the argument is not, and the argument is the product.

There is a second constraint that is easy to miss. Whatever is built has to survive being
looked at by someone hostile, or merely bored. A public endpoint that does unauthenticated
work is a public endpoint that will be called in a loop.

## Decision

Demo access is a distinct mechanism with its own configuration, its own endpoint, its own
claim in the token and its own guard: `DEMO_MODE` enables `POST /v1/auth/demo`, which takes no
request body at all and mints a session for one pre-configured, pre-seeded account, marked
`demo: true` in the signed claims; `DemoReadOnlyGuard` then refuses that session on every HTTP
method except `GET`, `HEAD`, `OPTIONS` and two exactly-matched paths. `AUTH_DEV_TOKEN_ENDPOINT`
is untouched, still refuses to start in production, and now also refuses to start alongside
`DEMO_MODE`.

## Options considered

### Option A: A separate read-only demo endpoint with a demo-marked session

| Dimension | Assessment |
|---|---|
| Complexity | Moderate — one endpoint, one claim, one guard, one limiter |
| What an attacker gains from the endpoint | One session for one account an operator published |
| What the demo can change | Nothing, except one `session.issued` audit event per sign-in |
| Effect on the existing production guard | None; strengthened by a mutual-exclusion check |
| What a visitor sees | The product, including tenant isolation, with two tenants seeded |
| Failure mode when wrong | A new non-GET read endpoint is refused for demo sessions |

**Pros:** The security property is structural rather than procedural. The endpoint accepts no
input, so there is no parameter to influence, no address to enumerate and nothing to validate;
"who this caller becomes" is fixed at boot by an operator. Read-only is enforced by HTTP method
above the authorisation layer, so it holds even if the demo account is later granted a role by
accident. The existing bypass stays exactly as forbidden as it was. A reviewer can read
`demo-readonly.guard.ts` end to end in a minute and know what a demo session can do.

**Cons:** It is more code than any other option here: a config block, an endpoint, a token
claim, a principal field, a guard, a rate limiter, two error classes. The allow-list of
permitted writes is a list a future endpoint must be added to, and forgetting is silent until
somebody clicks the thing. A demo token is a real session token — short-lived and restricted,
but real — so the blast radius is not zero, it is bounded.

### Option B: Enable the existing development token endpoint in production

| Dimension | Assessment |
|---|---|
| Complexity | None — delete four lines from `config.ts` |
| What an attacker gains from the endpoint | A session for any account in any tenant, including admins |
| What the demo can change | Everything the named account can, which is everything |
| Effect on the existing production guard | Deletes it |
| What a visitor sees | The product, and also every other visitor's edits |
| Failure mode when wrong | Total authentication bypass, publicly documented |

**Pros:** Zero work, zero new surface area, nothing new to maintain, and the seed script and
the twelve browser tests already sign in this way, so nothing else would need touching.

**Cons:** The endpoint mints a session for an arbitrary principal. Publishing it does not give
a stranger a demo account, it gives them every account — including `mara.okafor@acme.test`, who
is an admin, and including whatever account the next seeded tenant introduces. Every mutation
in the service becomes reachable, so the first passer-by can seal, abandon, supersede and
revoke, and the demo dataset stops being the dataset the demo script describes.

More importantly, the way this option gets adopted is by weakening a guard that was written
specifically to prevent it. That guard's comment says a development-only credential minting
endpoint reachable in production is a total authentication bypass and that refusing to start is
the only proportionate response. Reaching past it to ship a demo is how a guard stops meaning
anything: the next person who wants something reads the precedent, not the comment.

### Option C: No authentication at all — make everything public

| Dimension | Assessment |
|---|---|
| Complexity | Low — mark the read controllers `@Public()` |
| What an attacker gains from the endpoint | Nothing; there is nothing to gain |
| What the demo can change | Nothing, if the mutating routes stay guarded |
| Effect on the existing production guard | None |
| What a visitor sees | Runs and lineage, with no tenant and therefore no isolation |
| Failure mode when wrong | The reads have no tenant context, so RLS returns nothing or everything |

**Pros:** Genuinely the least code, and it removes the sign-in step entirely, which is the one
piece of friction between a stranger and the lineage graph.

**Cons:** It defeats the thing it is meant to show. Tenant isolation is the headline guarantee
(ADR-0002), and it is enforced by row-level security keyed on `app.tenant_id`, which is derived
from the principal. With no principal there is no tenant, and a request either sees nothing —
because `current_tenant_id()` is `NULL` and the policies deny by default — or sees everything,
because someone added a bypass to make the demo work. The second is worse and is what actually
happens. A system that demonstrates multi-tenancy by not having tenants demonstrates nothing,
and the seed goes to the trouble of creating a second tenant precisely so that a reviewer can
watch the same endpoint return two disjoint sets under two credentials.

It also removes the audit trail's subject. Every read would be unattributable, and "who looked
at this" is a question this service is otherwise able to answer.

### Option D: HTTP basic auth in front of the whole site

| Dimension | Assessment |
|---|---|
| Complexity | Lowest — three lines in the reverse proxy, no application change |
| What an attacker gains from the endpoint | Nothing; the endpoint is not reachable |
| What the demo can change | Everything, once past the door |
| Effect on the existing production guard | None if the dev endpoint stays off; otherwise it hides a bypass behind one password |
| What a visitor sees | A browser password prompt |
| Failure mode when wrong | One shared password, shared by whoever shares it |

**Pros:** Simplest thing that could possibly work, and it is honest about what it is. No new
code in this repository, no new endpoint, no new claim, no rate limiter. It composes with
everything: the site behind it can be the ordinary application with the ordinary sign-in.

**Cons:** It loses the case the deployment exists for. The reader we are trying to reach is
someone who followed a link, not someone who wrote to ask for credentials — a password prompt
turns them away at the door, and a password published next to the link is not a password. It
also does nothing about what happens after the door: the site behind it is either still
unreachable without a session, in which case the problem is unsolved, or it is fronted by the
development token endpoint, in which case a single shared password is the only thing standing
between the internet and every account.

## Trade-off analysis

Option D was the hardest to argue against, and it took the longest to reject.

It is the only option with no new code, and "no new code" is a real argument in a repository
maintained by one person, where every endpoint is a permanent obligation and every guard is a
thing that can be wrong. It also has a property none of the others have: it composes with
whatever comes later. If this service ever federates to an OIDC provider, basic auth in front
of the site keeps working unchanged, whereas the demo endpoint is a second sign-in path that
has to be reasoned about again.

It lost on what it is actually for. The deployment is not a staging environment that needs
protecting from strangers; it is an artefact whose entire purpose is to be seen by a stranger
who did not ask permission first. A password prompt in front of it converts every potential
reader into a correspondent, and most of them simply close the tab. Publishing the password
next to the link — which is what actually happens — reduces D to "the dev token endpoint on
the public internet, with a speed bump", which is Option B with extra steps and a false sense
of having done something.

Option B is worth naming precisely because it is what expedience looks like. It is one commit,
it works immediately, and the failure is invisible on the day it ships. The reason it is not
merely a weaker choice but a disqualifying one is that the cost is not borne by the demo — it
is borne by the guard. `config.ts` refuses to start a production process with the development
endpoint enabled. That check is worth something only for as long as nobody has an important
reason to remove it, and "we needed to ship the demo" is exactly the shape of the important
reason that kills checks like it. Building a second mechanism instead means the guard was never
the obstacle, and the mutual-exclusion check added here makes the two mechanisms explicitly
alternatives rather than a spectrum.

Where the chosen option is weaker than the ones it beat:

- **It is the most code.** D is three lines of proxy configuration; this is roughly two
  hundred lines across seven files, all of which have to be maintained and none of which
  existed before. The mitigation is that most of it is declarative — an allow-list, a claim,
  a config block — and the one piece with real logic, the limiter, is ninety lines with a
  stated replacement path.
- **A demo token is a real session token.** It is signed with the same secret and verified by
  the same code as any other. Its blast radius is bounded by the guard and by a one-hour
  expiry rather than by being a different kind of object. If `DemoReadOnlyGuard` were removed
  or its registration order changed, the demo account would become an ordinary session for a
  real member of a real study. The integration suite asserts the outcome — a demo token
  refused a run registration — rather than the ordering, so a reshuffle fails as a demo
  session successfully creating a run.
- **The rate limiter is per instance and in memory.** Two replicas allow twice the configured
  rate and a restart forgets every window. That is correct for a single-container deployment
  and is the first thing to change if there is ever a second one. It also does nothing against
  an attacker with many source addresses; what it prevents is the ordinary case of a script or
  a crawler in a loop.
- **Read-only is an allow-list over HTTP methods.** A future read endpoint that needs a request
  body — a complex search, say — is silently refused for demo sessions until somebody adds it
  to `ALLOWED_WRITES`. The symptom is a 403 on the demo and nothing else, which is the
  direction the mistake should fall, but it is a maintenance obligation and it will be
  forgotten at least once.
- **The demo is not perfectly read-only.** A sign-in appends one `session.issued` audit event,
  so a visitor can lengthen the chain, bounded by the rate limit. Suppressing that event was
  considered and rejected: an unattributable session in a service whose subject is attribution
  is a worse property than a chain that grows. The event records `mechanism:
  'public-demo-endpoint'`, so demo traffic is distinguishable from every other kind.

## Consequences

**Easier:** A stranger with a link is two clicks from a lineage graph and a verified audit
chain, with no correspondence and no shared password. Tenant isolation stays demonstrable,
because the demo session is a real member of a real tenant and `GET /v1/runs` under it returns
one tenant's runs and not the other's. The published deployment runs with
`AUTH_DEV_TOKEN_ENDPOINT` off, which is the configuration the production guard was written to
require, so the demo is now evidence for that guard rather than pressure against it. Demo
activity is identifiable in the audit trail by its mechanism.

**Harder:** Every future non-GET endpoint has to be classified as a read or a write for
`ALLOWED_WRITES`, and nothing forces that decision at the point the endpoint is written.
`Principal.isDemo` is a required field, so any future path that produces a principal has to say
what it is — which is deliberate, and is one more thing to say. The seed cannot run against a
demo-mode deployment: it signs in through `POST /v1/auth/token`, which is mutually exclusive
with `DEMO_MODE`, so provisioning is now a two-step sequence (seed with the development
endpoint, then restart with demo mode). The browser suite inherits that: the demo test probes
the endpoint and skips when it answers 404, so a single stack cannot exercise both sign-in
paths. Two more error classes and one more problem type are part of the public API surface and
cannot be renamed casually.

**To revisit:** A second API replica, at which point the in-memory limiter is wrong and the
window moves to PostgreSQL or a shared store — the seam is `DemoRateLimiter` and nothing
outside it knows how the count is kept. Federation to an OIDC provider, which would make the
demo endpoint the only remaining locally-minted credential and worth re-examining as a whole.
A demo dataset that is no longer disposable — anything a visitor could see that we would mind
them seeing invalidates the premise, not the implementation. Evidence that the allow-list has
been forgotten in practice, which is direct evidence that the obligation is not being
discharged by the mechanism chosen to discharge it, and would argue for classifying routes at
the handler with a decorator instead.

## Action items

1. - [x] `DEMO_MODE`, `DEMO_TENANT_SLUG`, `DEMO_USER_EMAIL`, `DEMO_TOKEN_TTL_SECONDS` and
   `DEMO_RATE_LIMIT_PER_MINUTE` parsed in `src/config/config.ts`, permitted in production.
2. - [x] Startup refusal when `DEMO_MODE` and `AUTH_DEV_TOKEN_ENDPOINT` are both enabled.
3. - [x] The existing production refusal on `AUTH_DEV_TOKEN_ENDPOINT` left exactly as it was.
4. - [x] `POST /v1/auth/demo` taking no request body, 404 when disabled, 503 when unseeded.
5. - [x] `demo: true` claim in `src/identity/tokens.ts`, carried to `Principal.isDemo`.
6. - [x] `DemoReadOnlyGuard` bound as an `APP_GUARD` after `AuthGuard`, allow-listing
   `POST /v1/auth/demo` and `POST /v1/audit/verify` by exact method and path.
7. - [x] `DemoRateLimiter`, fixed window, keyed by source address, answering 429 with
   `Retry-After`.
8. - [x] `RateLimitedError` and `DemoUnavailableError` in `src/common/problem-details.ts`.
9. - [x] "Try the demo" in the viewer, with a banner when the session in hand is a demo one.
10. - [x] `test/integration/demo-mode.spec.ts`: 404 when off, `demo: true` when on, reads
    permitted, four mutating verbs refused, `POST /v1/audit/verify` permitted, 429 past the
    threshold, 503 when unseeded.
11. - [ ] Document the five variables in `.env.example` and the deployment sequence in the
    README.
12. - [ ] A lint or test that fails when a non-GET route exists that is neither on the
    allow-list nor classified as a write, so the obligation in "Harder" is mechanical.
13. - [ ] Move the rate-limit window to PostgreSQL if a second API replica is ever deployed.
