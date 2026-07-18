# ADR-0018: A dependency-free static viewer instead of an SPA toolchain

**Status:** Accepted
**Date:** 2026-07-18
**Deciders:** Younes Kaouani

## Context

Two of this system's outputs are close to unreadable as JSON. A lineage response is a node and
edge list with a `depth` on each node; an audit page is fifty rows of hex where the point is that
each hash covers the one before it. Neither survives being pasted into a terminal.

PRD R11 asks for exactly one thing — "a minimal UI rendering the provenance graph and audit chain.
Its job is to make the demo legible, not to be a product" — and the non-goals table says a rich
end-user UI "competes for effort with the part that matters". The guarantees live in migrations,
`chain-verifier.ts` and `lineage-graph.ts`. Effort spent on a UI is effort not spent there.

The binding constraint is the other one. `docker compose up` and nothing else is stated as hard in
`ARCHITECTURE.md`, and the compose file carries the migration runner, role bootstrap, bucket
creation and seed as ordered services precisely so no step lands in a README. Every build step is
a way for that to stop being true: a lockfile, a node version, a transitive dependency that
publishes a broken release, and a failure mode on a machine that is not mine.

## Decision

The viewer is three static files — `src/viewer/public/index.html`, `app.js`, `styles.css`, 791
lines total. Plain ES modules loaded with `<script type="module">`, no framework, no bundler, no
npm dependency, no build step. `src/main.ts` registers `@fastify/static` at prefix `/` with
`decorateReply: false`, and the Dockerfile ships it with one `COPY src/viewer/public
./dist/viewer/public` — a copy, not a build.

## Options considered

### Option A: Dependency-free static ES modules

| Dimension | Assessment |
|---|---|
| Added dependencies | Zero; `@fastify/static` was already needed |
| Build steps in CI and Dockerfile | None — one `COPY` |
| Failure mode on a reviewer's machine | Only what the browser cannot parse |
| Escaping | Hand-written `escapeHtml`, applied per interpolation |
| Ceiling | Three screens, no routing, no shared state |

**Pros:** The one-command constraint is preserved by construction rather than defended. Nothing
here can break the API build, and all of it is readable in ten minutes.

**Cons:** Every class of bug a framework removes is now mine, escaping first among them. The files
sit outside every automated check in the repository.

### Option B: React with Vite

| Dimension | Assessment |
|---|---|
| Added dependencies | A second tree, a second lockfile, a second `npm audit` surface |
| Build steps in CI and Dockerfile | A stage in both, plus cache invalidation on it |
| Failure mode on a reviewer's machine | Build failure before the app ever runs |
| Escaping | Default-safe; JSX escapes interpolated values |
| Ceiling | Far above anything this UI will need |

**Pros:** Removes hand-escaping as a category. Gives routing, keyed reconciliation and component
reuse for free — the three things Option A gives up. It is what I would choose for a real UI.

**Cons:** A permanent second toolchain for three screens, with a dependency tree larger than this
repository whose vulnerabilities become my upgrade obligations. It puts a compile between a
reviewer and a running system, in a project whose stated promise is that there is not one.

### Option C: Server-rendered templates

| Dimension | Assessment |
|---|---|
| Added dependencies | One template engine and its Nest integration |
| Build steps in CI and Dockerfile | None, but templates must be copied and resolved at runtime |
| Failure mode on a reviewer's machine | Path resolution differing between `tsx` and `dist` |
| Escaping | Default-safe in any modern engine |
| Ceiling | Poor for the graph; good for the tables |

**Pros:** Escaping by default with no build step — Option B's main benefit at Option A's cost.

**Cons:** It puts the viewer inside the API. Rendering controllers would share the guards and
become a second consumer of every service, so a UI change could plausibly alter API behaviour. It
also does not help where help was needed: the SVG graph and the interactive
`POST /v1/audit/verify` both end up as client-side JavaScript inside a template anyway.

### Option D: No viewer at all

| Dimension | Assessment |
|---|---|
| Added dependencies | Zero |
| Build steps in CI and Dockerfile | None |
| Failure mode on a reviewer's machine | None |
| Escaping | Not applicable |
| Ceiling | `/docs` and `curl` |

**Pros:** The cheapest option, and defensible: OpenAPI at `/docs` already exercises every endpoint.

**Cons:** It fails R11 on the two things hardest to appreciate from JSON. A reader shown a hash
chain as a column of hex has to be told it is tamper-evident; a reader shown `chain intact` and
then a seeded break naming `BROKEN at seq 87` has been shown it.

## Trade-off analysis

React was the hardest to argue against, and the argument is not that a bundler is heavy. It is
that `escapeHtml` in `app.js` is a hand-written helper applied one interpolation at a time, and
the failure mode is silent: forget one call and a study slug renders as markup. That is exactly
the class of bug Option B deletes. Several sites are deliberately unescaped — `run.id`,
`run.manifestDigest`, `event.seq`, `event.hash` — because a UUIDv7, a hex digest and a bigint
sequence have no injectable shape. That reasoning is correct today and enforced by nothing.

Three things bound it. The viewer is read-only: every call is a `GET` except
`POST /v1/audit/verify`, a read that needs a body. It renders only rows the caller could already
read under RLS (ADR-0002), so the injectable strings — study slug, logical name, quarantine
reason — are authored by the tenant reading them. And the surface is 376 lines of one file, small
enough to audit each interpolation by reading it. The residual risk is a tenant defacing its own
operator's session, and there is no `Content-Security-Policy` header on the static route to blunt
it. That is an action item, not a solved problem.

The graph layout followed from the same instinct. `renderGraph()` places nodes in columns by
`node.depth`, which `lineage-graph.ts` computes as a layout layer rather than a hop count —
negative upstream, positive downstream, the queried artifact at 0, activities on the odd layers
between the entities they relate, which is the bipartite shape of a PROV graph (ADR-0008). The
server did the layout; the client is one pass and a Bézier per edge. A force-directed layout needs
a simulation, animates on load, and settles differently each time. Provenance is a DAG with a
meaningful direction, and physics trades that direction for aesthetics.

## Consequences

**Easier:** No second lockfile, no second `node_modules`, no build stage that can fail before the
service starts. A viewer change cannot break `npm run build`, and a reviewer can read the entire
client.

**Harder:** There is no router — view switching toggles an `active` class over the three `.view`
sections, so no run has a URL and a reload returns to the runs list. There is no shared state
beyond a three-field `state` object and the token in `sessionStorage`. There is no component reuse:
the runs row and the manifest row are separate template literals that will drift. Updates are
whole-subtree `innerHTML` assignments, so scroll and focus position are discarded on re-render and
the handlers in `showRun()` must be reattached after every write. Escaping is manual. And
`src/viewer/public/**` is ignored by `eslint.config.mjs`, outside the `format` glob, never seen by
`tsc`, and deliberately not registered by `test/integration/support/app.ts` — so `npm run verify`
says nothing about it. A typo here reaches a reviewer.

**To revisit:** This stops being the right call the moment the UI needs routing, shared state, or
more than a couple of screens. Deep-linking to a run, a write path beyond chain verification, or a
second maintainer are each sufficient alone — at which point Option B is correct and this ADR is
superseded rather than amended.

## Action items

1. - [x] Three static files, no npm dependency, no build step.
2. - [x] Served by `@fastify/static` from `src/main.ts` at prefix `/`, `decorateReply: false`.
3. - [x] Dockerfile copies `src/viewer/public` into `dist/`; no build stage added.
4. - [x] Layered SVG in `renderGraph()` keyed on the server-computed `node.depth`.
5. - [x] One error path in `api()` rendering RFC 9457 `detail` plus `brokenAtSeq`.
6. - [x] Verification result names the exact sequence number, not "invalid".
7. - [x] Token held in `sessionStorage`, never `localStorage`.
8. - [ ] `Content-Security-Policy` on the static route, forbidding inline script.
9. - [ ] A smoke check in CI that `/` returns 200 and `app.js` parses as a module.
10. - [ ] A single render helper that escapes by default, removing the per-site obligation.
