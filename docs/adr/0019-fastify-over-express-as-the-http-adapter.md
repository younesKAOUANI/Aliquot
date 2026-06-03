# ADR-0019: Fastify over Express as the HTTP adapter

**Status:** Accepted
**Date:** 2026-06-03
**Deciders:** Younes Kaouani

## Context

NestJS abstracts its HTTP layer behind an adapter, and the two first-party ones are Express and
Fastify. The choice is made at `NestFactory.create`, before any controller exists, and gets more
expensive to reverse with every handler naming an adapter type. The upload route table is next to
be written and the router's grammar decides its shape, so it cannot be deferred.

The system the adapter serves is a control plane. Artifact bytes move directly between client and
object store over presigned URLs and never enter this process (ADR-0006), which is why
`bodyLimit` in `src/main.ts` is 2 MiB. Bodies are manifests and part receipts; responses are a run
view, a page of audit events, a presign. Latency is a Postgres round trip inside `withTenant()`,
plus an S3 presign on the upload path.

That rules out the argument this decision is usually made on. Adapter benchmarks measure the part
of a request this service spends almost none of its time in, and a decision resting on them would
be reasoning from a habit rather than from this system. What it does decide: how much of
`src/main.ts` is adapter API, what shape a Nest middleware takes, and how a route captures a
multi-segment parameter — which matters because logical names contain slashes.

## Decision

The HTTP adapter is `FastifyAdapter` from `@nestjs/platform-fastify`, configured in `src/main.ts`
and mirrored in the integration harness. Adapter types stay out of service and repository code:
where a handler needs the reply it is `FastifyReply` at the controller boundary, no deeper.

## Options considered

### Option A: Fastify via `@nestjs/platform-fastify`

| Dimension | Assessment |
|---|---|
| Async lifecycle | Native — registration and close are promise-based |
| Response serialisation | Schema-compiled; declared fields only |
| Nest ecosystem coverage | Smaller share; divergences undocumented |
| Middleware model | Bundled middie; hands over the raw Node request |
| Wildcard routing | find-my-way: bare `*`, terminal only |
| Testing | `app.inject()`, no socket |

**Pros:** Boot and shutdown are awaited end to end, which is what `enableShutdownHooks()` needs to
close the pool after in-flight transactions rather than under them. CORS, form bodies, static
serving and proxy trust are first-party, not a middleware supply chain.

**Cons:** Middleware sees a different request object than guards and filters do. The router takes
one wildcard form, not the one Nest's middleware matcher uses. The first search result for any
oddity will be about Express.

### Option B: Express via `@nestjs/platform-express`

| Dimension | Assessment |
|---|---|
| Async lifecycle | None beyond `server.close(cb)` |
| Response serialisation | `res.json` over whatever the handler returned |
| Nest ecosystem coverage | The default; docs and modules assume it |
| Middleware model | Native — same `req` as everything else |
| Wildcard routing | path-to-regexp 8: named, permitted mid-path |
| Testing | supertest, ephemeral port |

**Pros:** The safest option in the Nest world: every documentation example and third-party module
applies untranslated. `@Post('runs/:runId/artifacts/*name/upload')` routes directly, so the upload
endpoints stay three decorators.

**Cons:** No lifecycle to hook, so anything ordered around readiness or drain is hand-rolled. No
declaration to serialise a response against. Express 5 is itself a version boundary — it took
path-to-regexp 8 and dropped the bare `*` — so "it works on Express" is version-qualified now.

### Option C: Drop Nest for bare Fastify or Hono

| Dimension | Assessment |
|---|---|
| Wiring | Manual construction, manual singleton discipline |
| Request lifecycle | Guard, filter and tenant context rebuilt by hand |
| Adapter seam | None |

**Pros:** One framework instead of two; no decorator metadata.

**Cons:** The DI container is load-bearing here, not decoration. `CoreModule` being `@Global()`
guarantees one `DatabaseService` and therefore one pool; `APP_GUARD` makes authentication the
default a route opts out of; `@Ctx()` turns a principal into a tenant-scoped `RequestContext`
before a handler touches the database. Rebuilding that by hand means rebuilding the part of the
request path where a mistake is a tenant leak.

## Trade-off analysis

Express was hardest to argue against: it is the option where an oddity has already been explained
by somebody else, and this is one maintainer. It lost on three arguments, none of them
throughput.

**Lifecycle.** Fastify's plugin graph is promise-based, so `await app.register(...)` and
`await app.listen(...)` mean readiness, and close runs teardown in reverse registration order.
That composes with `enableShutdownHooks()`, which routes SIGTERM through
`DatabaseService.onModuleDestroy` and `S3ObjectStore.onModuleDestroy`. Nest's module hooks are
adapter-independent; the difference is at the boundary, where a rolling deploy drains or
truncates.

**Serialisation.** Everything crossing the edge is parsed by a Zod schema through `parseWith`
(`src/http/zod-validation.ts`), so response shapes are declarations this codebase already has.
Compiled serialisation emits declared fields and nothing else — accident prevention before speed:
a column added to a `select` cannot ride out in a response it was never declared in. That is an
affordance rather than a fact, though. No response schemas are declared yet, so the reason is
potential rather than banked.

**A narrowed gap.** Most of what Express middleware was needed for is first-party in Fastify, and
Express 5's breaking changes mean the ecosystem argument no longer carries over from Express 4.

Where Fastify is plainly worse here:

- **Middleware sees a different request.** Nest runs middleware through a bundled middie, hooked
  on `onRequest`, which hands over the raw Node `IncomingMessage` rather than the `FastifyRequest`
  guards, controllers and `ProblemDetailsFilter` see. `CorrelationMiddleware.use()` is therefore
  typed against `IncomingMessage`, sets `request.correlationId` on the raw object, and writes the
  accepted id back into `request.headers[CORRELATION_HEADER]` — the headers object being the one
  thing both views share. Correct, and still adapter detail in the least adapter-aware code here.
- **Two wildcard grammars.** find-my-way permits one multi-segment spelling, a bare `*` as the
  final character, while Nest's middleware matcher uses path-to-regexp 8 and wants
  `{ path: '*path' }` — which is why `HttpModule.configure()` and `UploadController` spell the
  same idea differently. Logical names contain slashes (`ch0/stack.tif`), so the three upload URLs
  collapse into one `@Post('runs/:runId/artifacts/*')` handler, with `splitOperation()` peeling
  `/upload`, `/upload/parts` or `/upload/complete` off the tail and raising `NotFoundError` when
  none matches. On Express that is three decorators and no splitter: the strongest argument the
  losing option had.

Against those, `app.inject()` is worth more than it looks: the harness boots with `init()` and no
socket, removing port allocation from suites sharing one container set, and the TCP round trip
from the eight-way idempotency race.

## Consequences

**Easier:** Boot and drain are awaited paths rather than callbacks. `bodyLimit`, `trustProxy` and
`genReqId` are options set once instead of packages assembled. The viewer is served by
`@fastify/static` (ADR-0018), registered on the adapter and therefore behind no guard. Suites run
the real pipeline without a listener.

**Harder:** Nest answers found in the wild need translating, and the cases where they do not apply
are unannounced. Middleware is written against the raw Node request, so the next one rediscovers
the middie handoff unless it reads `src/http/correlation.ts` first. The upload routes are shaped
by the router rather than the API.

**To revisit:** A genuinely Express-only Nest module becoming necessary — file-upload interceptors
are the usual one, and ADR-0006 exempts this service. Response schemas still unwired once the API
surface settles, which would mean one of the three reasons was theoretical. A third
adapter-shaped bug beyond the middie handoff and the wildcard grammar, saying the seam is thinner
than assumed. Or `@nestjs/platform-fastify` lagging a Fastify major, a version pinned by the
platform package rather than by us.

## Action items

1. - [x] `FastifyAdapter` with `bodyLimit` 2 MiB, `genReqId: () => ''`, `trustProxy` in `src/main.ts`.
2. - [x] The same options mirrored in `test/integration/support/app.ts`.
3. - [x] `@fastify/static` for the viewer, with `decorateReply: false`.
4. - [x] `CorrelationMiddleware` typed against `IncomingMessage`, middie handoff explained there.
5. - [x] `correlationIdOf()` as the one way to read the id from either request view.
6. - [x] Terminal wildcard route plus `splitOperation()`, `LOGICAL_NAME` mirroring the `run_artifact.logical_name` CHECK.
7. - [x] Adapter types confined to two `FastifyReply` references, both in controllers.
8. - [x] Suites driven through `app.inject()` after `app.init()`, no socket.
9. - [ ] Response serialisation schemas derived from the Zod output contracts.
10. - [ ] An assertion that an undeclared field cannot reach a response body, after (9).
11. - [ ] An assertion that `x-correlation-id`, `correlationId` and `audit_event.correlation_id` agree.
