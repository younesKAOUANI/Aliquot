# Deployment

Aliquot at <https://aliquot.youneskaouani.dev>: Docker Compose, images from
GHCR, deploys from GitHub Actions behind an approval gate.

It shares a VPS with two other projects. **TLS is not in this repository** — a
shared edge Caddy terminates for every name on the box, and its runbook, the
host preparation and the DNS list all live in the [`deploy/edge`](https://github.com/younesKAOUANI/portfolio/tree/main/deploy/edge)
directory of the portfolio repository. Read that first if you are setting the
machine up from nothing; this document covers Aliquot alone.

---

## Topology

```
                        internet
                            │
                     :80 :443 (only open ports)
                            │
                    ┌───────▼────────┐
                    │  edge / caddy  │  shared: TLS for all three sites
                    └───────┬────────┘
          aliquot.…dev      │   docker network `edge`
                     ┌──────▼──────┐
                     │ aliquot-api │
                     └──────┬──────┘
                            │  project network
                     ┌──────▼──────┐
                     │  postgres   │◀── worker
                     └─────────────┘

                 objects ──► Cloudflare R2 (off the box)
```

This stack publishes **no host port at all**. The API is reachable only by its
container alias on the shared `edge` network; Postgres is on the project network
and has no route in from anywhere.

**Two processes from one image.** `SERVICE_ROLE` selects which entrypoint runs.
They share the composition root, so the worker exercises the code paths the API
was tested with rather than a parallel wiring that can drift.

---

## Prerequisites

| | |
|---|---|
| Host | Prepared per the edge runbook, with the `edge` docker network created. |
| DNS | An `A` record for `aliquot.youneskaouani.dev`, set before the edge Caddy first starts. |
| Storage | A Cloudflare R2 bucket and a scoped API token. |
| GitHub | An environment named `production` holding the deploy secrets |

---

## First-time setup

### 1. Prepare the host

Once for the whole box, not once per project — see the edge runbook. In short:

```bash
ssh root@<host>
curl -fsSL https://raw.githubusercontent.com/younesKAOUANI/Aliquot/main/deploy/bootstrap.sh -o bootstrap.sh
less bootstrap.sh          # it is short; read it
DEPLOY_USER=deploy bash bootstrap.sh
docker network create edge
```

Installs Docker, creates the deploy user, opens only 22/80/443, disables SSH
password authentication, enables unattended security updates and `fail2ban`, and
schedules a nightly backup. It installs no secrets and starts nothing.

It calls `ufw --force reset`, so run it **first and once**. On a box already
serving the other two sites it resets the firewall out from under them.

> The deploy user is in the `docker` group, which on this box is equivalent to
> root. That is a deliberate trade — rootless Docker is tighter and costs more
> operationally than a single-service host justifies. It is stated here so it is
> a decision rather than an oversight.

### 2. Deploy key

Generate a keypair *for CI only*, not your personal key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/aliquot-deploy -C 'github-actions@aliquot' -N ''
```

Public half onto the box:

```bash
ssh-copy-id -i ~/.ssh/aliquot-deploy.pub deploy@<host>
```

Private half into the GitHub environment secret `DEPLOY_SSH_KEY`.

### 3. Secrets on the box

```bash
sudo cp /opt/aliquot/aliquot.env.example /etc/aliquot/aliquot.env
sudo chmod 600 /etc/aliquot/aliquot.env
sudo $EDITOR /etc/aliquot/aliquot.env
```

Generate every secret rather than inventing one:

```bash
openssl rand -hex 32      # AUTH_JWT_SECRET
openssl rand -base64 24   # POSTGRES_PASSWORD, APP_DB_PASSWORD, storage keys
```

### 4. GitHub environment

Settings → Environments → **production**. Add a required reviewer so a deploy is
a decision rather than a side effect of merging, then add:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | the VPS address |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | the private key from step 2 |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 <host>` |
| `DEPLOY_PORT` | optional, defaults to 22 |
| `DEPLOY_DIR` | optional, defaults to `/opt/aliquot` |

`DEPLOY_KNOWN_HOSTS` is pinned rather than scanned at deploy time. Trusting
whatever answers on the night is not host verification.

Until `DEPLOY_HOST` is set the deploy workflow **skips cleanly** and says so in
its summary, rather than failing on every release. A job that is always red is a
job nobody reads, and the first real deployment failure would then look exactly
like the eleven before it.

### 5. First deploy

```bash
gh workflow run release.yml     # build and publish the image
gh workflow run deploy.yml      # approve when prompted
```

### 6. Seed the demo dataset

Once, deliberately, because it is not part of a normal deploy:

```bash
ssh deploy@<host>
cd /opt/aliquot
docker compose -f docker-compose.prod.yml --env-file /etc/aliquot/aliquot.env \
  --profile seed run --rm seed
```

No flags to flip and no restart. The seed signs its own sessions with
`AUTH_JWT_SECRET` rather than calling `POST /v1/auth/token` — it already holds
that secret and the owner database credentials, so routing through a public
bypass to use authority it already has would have bought nothing and cost the
production guard. It creates identity objects directly and drives the whole run
lifecycle over HTTP, so a broken API fails the seed rather than producing data
that could not have been produced legitimately.

`DEMO_USER_EMAIL` defaults to the seeded **steward**, not the scientist.
`POST /v1/audit/verify` requires steward or admin, and chain verification is the
single most worth-seeing thing on the site — point the demo at a scientist and
the demo guard allows the call while the role check refuses it.

---

## Routine operations

### Deploying

Merging to `main` builds and publishes an image. Deployment waits for approval.
`deploy.sh` runs migrations to completion *before* any new container serves
traffic and aborts if they fail, so a bad migration never leaves half the stack
on a schema the rest does not have.

### Rolling back

```bash
ssh deploy@<host>
cat /opt/aliquot/.previous-image                    # what was running before
ALIQUOT_IMAGE=ghcr.io/youneskaouani/aliquot:sha-<older> bash /opt/aliquot/deploy.sh
```

**Migrations are forward-only and do not roll back.** Reverting the image
reverts the code, not the schema. That is survivable because every migration so
far is additive — but a release that drops or narrows a column needs a
compensating migration, not a rollback. Treat that as a design constraint when
writing one.

### Backups

Nightly at 03:20 UTC, and before every deploy. Custom-format dumps in
`/var/backups/aliquot`, retained 14 days, each verified readable with
`pg_restore --list` before it counts as a success.

```bash
bash /opt/aliquot/backup.sh                                    # on demand
bash /opt/aliquot/restore.sh /var/backups/aliquot/aliquot-<stamp>.dump
```

`restore.sh` takes a safety dump first, stops the API, restores in a single
transaction, and prints each tenant's audit event count so you can verify the
chain survived. **Restore into a scratch database and read the result at least
once** — a backup nobody has restored is a hypothesis.

> The database is backed up here. Objects are not, and do not need to be from
> this box: R2 holds them, replicated, off the machine. What is *not* covered
> either way is the pairing — a restored database references object keys, and if
> the bucket has been emptied since the dump those runs come back as metadata
> pointing at nothing. The system reports that honestly as a storage error
> rather than pretending the artifact is fine, but it is still data loss.

### Logs

```bash
docker compose -f /opt/aliquot/docker-compose.prod.yml \
  --env-file /etc/aliquot/aliquot.env logs -f api worker
```

Structured JSON with a correlation id that survives the queue: the id minted at
the edge is stored on the job row and restored by the worker, so both halves of
"why did this run never finish processing" share a key.

```bash
# everything about one request
docker compose ... logs api | jq -c 'select(.correlationId=="<id>")'
```

---

## Object storage

Cloudflare R2, addressed as S3. The application speaks nothing else, so AWS S3
or any S3-compatible endpoint is a change of five values in
`/etc/aliquot/aliquot.env`:

```
STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
STORAGE_BUCKET=aliquot
STORAGE_ACCESS_KEY_ID=<r2 access key>
STORAGE_SECRET_ACCESS_KEY=<r2 secret>
STORAGE_FORCE_PATH_STYLE=true
STORAGE_REGION=auto
```

`STORAGE_ENDPOINT` is the **account** endpoint from R2 → bucket → Settings →
S3 API, not the public bucket URL. Scope the token to Object Read & Write on
this bucket alone.

**Set the bucket's CORS policy** to allow `PUT` and `GET` from
`https://aliquot.youneskaouani.dev`. Miss it and browser uploads fail with an
opaque network error while `curl` against the very same presigned URL succeeds,
which is a genuinely nasty hour.

### Why not a bundled object store

The deployment used to ship MinIO alongside, and the reason it no longer does is
worth keeping:

**A presigned URL is signed for a specific hostname.** The browser performing an
upload and the worker reading the bytes back must resolve that hostname to the
same store, or every signature fails on one side of the fence. Self-hosting the
store therefore means giving it a public name and a certificate purely to
satisfy that constraint — and then owning durability for a single disk on a
single box that the nightly database dump does not cover.

R2's endpoint already resolves identically from everywhere, so the constraint
disappears rather than being worked around. On a host now shared with two other
projects, one fewer stateful container is worth more than the independence.

If you ever switch back or sideways, note that it does **not** migrate existing
objects. Copy them first (`rclone sync`), or accept that older artifacts become
unreadable while their metadata and audit history remain.

---

## Security posture

What is deliberately true of this deployment:

- **The dev token endpoint is unreachable three times over.** It mints a session
  for an arbitrary email address. The service refuses to start with it enabled
  when `NODE_ENV=production`; the compose file hard-codes it off; Caddy returns
  404 for the route. The deploy workflow asserts the 404 from the public
  internet after every release.
- **Public access is a read-only demo session** that takes no request body,
  resolves to one pre-seeded account, and is refused on every mutating verb by a
  guard rather than by a role check ([ADR-0020](adr/0020-read-only-demo-access-for-a-public-deployment.md)).
- **The application connects as an unprivileged, `NOINHERIT` role** with no
  `BYPASSRLS` and no superuser bit. It asserts this at startup and refuses to
  boot otherwise, because a privileged role silently disables tenant isolation
  while every test still passes.
- **Only 22, 80 and 443 are open**, and this stack publishes no host port at
  all — the shared edge Caddy is the only process on the box the internet can
  reach.
- **The client address cannot be forged.** The demo rate limiter keys on it, and
  Caddy sets `X-Forwarded-For` from the real peer and discards whatever the
  caller sent, rather than appending to it.
- **Secrets live in one root-owned file** at `/etc/aliquot/aliquot.env`, mode
  600, never in the repository and never in an image layer.
- **Images carry an SBOM and a build provenance attestation.** A service whose
  argument is that you can tell where things came from should be able to say it
  about itself.

### Rotating the JWT secret

Invalidates every issued session, which is the point:

```bash
sudo $EDITOR /etc/aliquot/aliquot.env      # new AUTH_JWT_SECRET
cd /opt/aliquot
docker compose -f docker-compose.prod.yml --env-file /etc/aliquot/aliquot.env up -d api worker
```

---

## Troubleshooting

**502 from the edge**
The API container is down, or it is up but not attached to the `edge` network —
which happens when the stack came up before that network existed.
`docker network inspect edge` lists what is actually on it.

**Caddy will not get a certificate**
Not this repository's Caddy any more. DNS for `aliquot.youneskaouani.dev` must
resolve to the box *before* the edge Caddy tries, and port 80 must be reachable
for HTTP-01. `docker compose logs caddy` in the edge directory. Let's Encrypt
rate-limits failures — fix DNS, then wait rather than retrying in a loop.

**`refusing to start: row-level security would not be enforced`**
`DATABASE_URL` points at a superuser or a `BYPASSRLS` role. Use `APP_DB_USER`,
which `migrate` creates. Working as designed.

**Uploads fail with a signature error**
`STORAGE_ENDPOINT` is not the hostname the browser used. Both sides must agree —
see [Object storage](#object-storage).

**Uploads fail in the browser but the same presigned URL works with `curl`**
CORS on the bucket. `curl` does not send an `Origin` header and does not enforce
the response, so it is the one client that cannot see this problem.

**`/readyz` is 503 but `/healthz` is 200**
Readiness includes object storage. The API is up and R2 is not reachable, or the
credentials are wrong. A service that accepts registrations it cannot fulfil is
worse than one that refuses them.

**The deploy succeeded and the site is unchanged**
Check the deployed digest: `docker inspect --format '{{.Config.Image}}'
aliquot-api-1`. `deploy.sh` pins by SHA tag; if it says `:latest`, something
invoked it by hand without `ALIQUOT_IMAGE`.

**Migrations failed mid-deploy**
Nothing was switched over — `deploy.sh` aborts before touching `api`. Migrations
are one transaction per file and PostgreSQL has transactional DDL, so a failed
file left no trace. Read `docker compose logs migrate`, fix forward, redeploy.

---

## What this deployment is not

Stated plainly, because a deployment document that only lists strengths is a
sales sheet.

- **Single point of failure at every layer.** One box, one Postgres, no
  replication. A disk failure loses everything since the last nightly dump.
  Objects survive it — they are in R2 — but the database rows that name them may
  not, and the two are only useful together.
- **The box is shared.** Three projects, one kernel, one disk, one edge. A
  runaway container starves the other two, and a `docker compose down` in the
  wrong directory is a live outage for someone else's site.
- **No zero-downtime deploy.** `up -d` restarts the API; requests in flight
  fail. At this traffic that is a second of 502 nobody sees, and it is still
  true.
- **The in-memory rate limiter is per-instance.** Correct for one container and
  wrong the moment there are two.
- **No metrics or alerting.** Logs go to the local Docker journal and rotate.
  The application exposes the numbers worth alerting on — idempotency hit rate,
  verification failure rate, dead-letter depth, oldest unclaimed job — and
  nothing scrapes them yet.
- **Chain checkpoints are not externally anchored.** `audit_checkpoint` records
  heads in the same database it audits, so it does not yet close the
  full-rewrite gap described in
  [ADR-0005](adr/0005-hash-chained-audit-log-in-postgresql-not-an-external-ledger.md).
  Mirroring `external_ref` to append-only storage off the box is the fix, and it
  needs no schema change.
