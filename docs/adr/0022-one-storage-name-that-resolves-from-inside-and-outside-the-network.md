# ADR-0022: One storage name that resolves from inside and outside the compose network

**Status:** Accepted
**Date:** 2026-08-04
**Deciders:** Kaouani Younes Islam

## Context

A presigned URL is signed for exactly one host. SigV4 covers the `Host` header, so the
origin of a signed URL cannot be changed afterwards — rewriting it produces
`SignatureDoesNotMatch`, one HTTP round trip later and with no indication that the origin
was the problem.

Until now that constraint cost nothing here, because every client of a presigned URL ran
inside the compose network: the worker, the seed, and `docker compose run --rm demo`. They
all resolved `minio:9000`, the README explained why the demo had to run in a container, and
the question stopped there.

ADR-0021 broke that. The sandbox tab uploads **from the visitor's browser**, straight to
the object store, which is the same path an instrument takes and the reason a 300 GB stack
does not have to be proxied through a Node process. A browser on the developer's machine
cannot resolve `minio`. So on a local `docker compose up` — the documented way in, and the
one a reviewer uses — the single feature that lets a stranger *do* something instead of
reading about it fails, and fails in the least diagnosable way available: `fetch` rejects
with a bare `TypeError`, no status, no headers, nothing in the response, while `curl`
against the identical URL from inside the network succeeds. It reads like a browser bug.

What is actually needed is narrow: **one name for the object store that resolves to the
same store from a container and from the host**. Everything else follows from that.

Getting it wrong is not subtle in production — there the store has one public endpoint and
none of this arises — but getting it wrong locally means the repository ships a feature
that only works on the deployment, which is the same as not having built it.

## Decision

The object store answers to `minio.localhost` on the compose network, listening on the port
it is published on, and every service in the stack uses that single endpoint.
`STORAGE_PUBLIC_ENDPOINT` exists as an escape hatch for deployments where the two genuinely
differ, and is unset in production.

## Options considered

### Option A: proxy the upload through the API for the sandbox

| Dimension | Assessment |
|---|---|
| Local and deployed behave alike | Yes |
| New configuration | None |
| What it costs | The architecture's central claim |
| Failure mode when wrong | A memory profile that only appears under real file sizes |

**Pros:** No naming problem at all — the browser talks to the origin it loaded the page
from, and CORS stops mattering too. One code path, no environment-dependent behaviour.

**Cons:** It makes the demonstration dishonest. The whole point of the upload step is that
the bytes do *not* pass through the API; that is why the service can ingest a 300 GB stack
on a small box, and it is stated in `docs/ARCHITECTURE.md` and shown in the sandbox
timeline. A sandbox that proxies is demonstrating a different system from the one being
described. It also puts an unbounded upload through a Node process for the one path that
anonymous callers can reach.

### Option B: two endpoints — `STORAGE_PUBLIC_ENDPOINT` set in compose

| Dimension | Assessment |
|---|---|
| Local and deployed behave alike | No — an extra variable locally |
| New configuration | One variable |
| What it costs | Every in-network client of the API |
| Failure mode when wrong | The seed cannot upload; the stack comes up empty |

**Pros:** Explicit, and the mechanism is familiar to anyone who has run MinIO behind a
network. It is honest about the fact that two names exist.

**Cons:** It was tried, and it broke the seed within a minute. Presigned URLs are issued by
the API, so pointing them at `localhost` points them there for *every* client — including
`scripts/seed.ts`, which runs in a container where `localhost` is itself. The stack came up
with an empty database and a `fetch failed` buried in the seed log. Fixing that means either
teaching the seed to bypass the API's presigning (a second upload path, in the one script
whose job is to exercise the first) or accepting that `up` no longer populates anything.

### Option C: one name that resolves both ways

| Dimension | Assessment |
|---|---|
| Local and deployed behave alike | Yes — one endpoint in both |
| New configuration | None |
| What it costs | A dependency on `.localhost` resolution |
| Failure mode when wrong | Browser upload fails; everything else still works |

**Pros:** There is only ever one endpoint, so there is nothing to keep in sync and no client
that can be pointed at the wrong one. `minio.localhost` resolves inside the network because
it is a Docker network alias, and on the host because RFC 6761 reserves `.localhost` for
loopback — where the published port is waiting. Making MinIO listen on the port it is
published on removes the last asymmetry, so the URL is byte-identical on both sides.

**Cons:** It is a trick, and a reader will stop at it. It rests on two behaviours that are
correct but not obvious: that a container's resolver does *not* short-circuit `.localhost`
(glibc only special-cases the bare name, so Docker's DNS answers), and that the host's does.
It also means the published MinIO port is no longer freely remappable from the container
port, which is a small loss of flexibility in a file whose header advertises remappable
ports.

## Trade-off analysis

Option B was the obvious answer and is the one most stacks use. It lost on evidence rather
than on taste: it was implemented, and it silently broke the seed — which is the more
important local guarantee, because a stack that comes up empty fails every other scenario in
`docs/WALKTHROUGH.md`. The general lesson is that `STORAGE_PUBLIC_ENDPOINT` is not really
"where the browser is"; it is "where *every* client is", and this stack has clients on both
sides of the boundary.

Option A was the hardest to argue against, because it makes the problem vanish rather than
solving it, and because "the sandbox proxies, the real path does not" is a defensible
scoping. It lost because the sandbox exists specifically to be watched: a visitor is invited
to read each step as the request it actually made, and a step captioned `PUT` to the object
store that in truth posted to the API would be the one dishonest line on a page whose entire
argument is that nothing here is staged.

Where Option C is weaker than the one it beat: Option B fails loudly and in an obvious place
if the name is wrong, whereas Option C's failure — a host that does not resolve
`*.localhost` — presents only as the browser upload not working, on someone else's machine,
with a message about CORS. That is mitigated but not eliminated: containers reach the store
regardless, so the stack still comes up populated and only the sandbox tab degrades, and the
tab already prints a specific diagnosis for a PUT that never got a status.

`STORAGE_PUBLIC_ENDPOINT` is kept even though compose no longer sets it. It is eight lines
of implementation, it is the correct answer for a deployment whose store is genuinely
reachable by two names, and having it means the next person hitting this does not have to
rediscover that rewriting a signed URL is not an option. It is tested for both what it
signs and whether the store accepts the signature — a URL that merely names the right host
and fails to authenticate would pass a weaker test.

## Consequences

**Easier:** `docker compose up` produces a stack where the sandbox tab works end to end from
a browser, with no extra variable and no note in the README about which shell to run things
from. `docker compose run --rm demo` no longer *has* to run in a container — it still does,
because nothing else about it changed, but the reason has evaporated.

**Harder:** The published MinIO port and the container port are now the same number by
construction, so `ALIQUOT_MINIO_PORT` moves both. MinIO's healthcheck needs `MC_HOST_local`
because `mc ready local` assumes 9000. And there is a name in `docker-compose.yml` that
looks like a mistake and is not, which is a permanent tax on the next reader — paid down
with the comment above it and this ADR.

**To revisit:** if a developer reports that the sandbox tab fails locally with a CORS-shaped
error while every container works, their resolver is not honouring `.localhost` and this
should become Option B plus a seed that uploads through the SDK. Also revisit if the seed
ever stops being the only in-network client of the API — the argument against Option B is
entirely about clients on both sides of the boundary, and it weakens if there is only one
side.

## Action items

1. - [x] `minio.localhost` as a Docker network alias on the `minio` service.
2. - [x] MinIO listening on the published port (`--address`), with ports mapped 1:1 and
   `MC_HOST_local` so the healthcheck follows.
3. - [x] `STORAGE_ENDPOINT: http://minio.localhost:${ALIQUOT_MINIO_PORT:-9000}` for the API,
   worker, seed and demo — one endpoint, four services.
4. - [x] `STORAGE_PUBLIC_ENDPOINT` in `src/config/config.ts`, optional, defaulting to
   `STORAGE_ENDPOINT`; a second `S3Client` in `S3ObjectStore` used only for signing.
5. - [x] `test/integration/presign-endpoint.spec.ts` — asserts the default, and that a
   configured public endpoint both changes the origin and still authenticates there.
6. - [x] `test/e2e/sandbox.spec.ts` — the browser upload, which is the only test in the
   repository that would have caught this at all.
7. - [x] The README passages explaining why the demo must run inside the network corrected,
   rather than left describing a constraint that no longer exists.
