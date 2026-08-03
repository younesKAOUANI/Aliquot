# Deployment

Aliquot at <https://aliquot.youneskaouani.dev>: one VPS, Docker Compose, Caddy
for TLS, images from GHCR, deploys from GitHub Actions behind an approval gate.

This is the runbook. It assumes nothing about the reader except a shell.

---

## Topology

```
                        internet
                            │
                     :80 :443 (only open ports)
                            │
                     ┌──────▼──────┐
                     │    Caddy    │  TLS from Let's Encrypt, auto-renewed
                     └──┬───────┬──┘
        aliquot.…dev    │       │   storage.aliquot.…dev
                     ┌──▼──┐ ┌──▼────┐
                     │ api │ │ minio │
                     └──┬──┘ └───┬───┘
                        │        │
                   ┌────▼────┐   │
                   │ postgres│◀──┴── worker
                   └─────────┘
```

Nothing except Caddy publishes a host port. Postgres and MinIO are reachable
only on the internal Docker network, so the externally reachable surface is one
TLS listener rather than four services.

**Two processes from one image.** `SERVICE_ROLE` selects which entrypoint runs.
They share the composition root, so the worker exercises the code paths the API
was tested with rather than a parallel wiring that can drift.

---

## Prerequisites

| | |
|---|---|
| VPS | 2 vCPU / 4 GB / 40 GB is comfortable. Debian 12 or Ubuntu 24.04. |
| DNS | `A` records for `aliquot.youneskaouani.dev` and, while using bundled storage, `storage.aliquot.youneskaouani.dev` |
| GitHub | An environment named `production` holding the deploy secrets |

**Set DNS before the first deploy.** Caddy obtains certificates over HTTP-01,
which requires the names to resolve to the box. Let's Encrypt rate-limits
failures, so a deploy against unresolved DNS costs you an hour of waiting rather
than a retry.

---

## First-time setup

### 1. Prepare the host

```bash
ssh root@<host>
curl -fsSL https://raw.githubusercontent.com/younesKAOUANI/Aliquot/main/deploy/bootstrap.sh -o bootstrap.sh
less bootstrap.sh          # it is short; read it
bash bootstrap.sh
```

Installs Docker, creates the `aliquot` user, opens only 22/80/443, disables SSH
password authentication, enables unattended security updates and `fail2ban`, and
schedules a nightly backup. It installs no secrets and starts nothing.

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
ssh-copy-id -i ~/.ssh/aliquot-deploy.pub aliquot@<host>
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
| `DEPLOY_USER` | `aliquot` |
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
ssh aliquot@<host>
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
ssh aliquot@<host>
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

> The database is backed up. Object storage, when bundled, is **not** — MinIO's
> volume is one disk on one box. `docker run --rm -v aliquot_minio-data:/data
> -v /var/backups:/backup alpine tar czf /backup/minio-$(date -u +%F).tgz /data`
> is the crude version; moving to R2 or S3 is the real answer.

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

### The MinIO console

Deliberately 404 from the internet. Reach it over SSH:

```bash
ssh -L 9001:localhost:9001 aliquot@<host>
# then http://localhost:9001
```

---

## Object storage

The one deployment decision with a real constraint behind it.

**A presigned URL is signed for a specific hostname.** The browser performing an
upload and the worker reading the bytes back must resolve that hostname to the
same store, or every signature fails on one side of the fence. This is why
`storage.aliquot.youneskaouani.dev` exists as a public name rather than the API
handing out `http://minio:9000`.

### Bundled MinIO (default)

```
BUNDLED_STORAGE=true
STORAGE_ENDPOINT=https://storage.aliquot.youneskaouani.dev
STORAGE_FORCE_PATH_STYLE=true
```

No external account. You own durability, and single-node MinIO on one disk means
one disk is the whole story.

### Cloudflare R2 or S3

```
BUNDLED_STORAGE=false
STORAGE_ENDPOINT=https://<account>.r2.cloudflarestorage.com
STORAGE_REGION=auto
STORAGE_ACCESS_KEY_ID=<key>
STORAGE_SECRET_ACCESS_KEY=<secret>
```

Then comment out the `{$STORAGE_DOMAIN}` block in the `Caddyfile` and drop that
DNS record. Nothing else changes — the application talks S3 either way, and the
presigned-URL constraint disappears because their endpoint already resolves
identically from everywhere.

Switching later does **not** migrate existing objects. Copy them first
(`rclone sync`), or accept that older artifacts become unreadable while their
metadata and audit history remain — which the system will report honestly as a
storage error rather than pretending the data is fine.

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
- **Only 22, 80 and 443 are open**, and only Caddy publishes a host port.
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

**Caddy will not get a certificate**
DNS must resolve to the box *before* Caddy starts, and port 80 must be reachable
for HTTP-01. Check `docker compose logs caddy`. Let's Encrypt rate-limits
failures — fix DNS, then wait rather than retrying in a loop.

**`refusing to start: row-level security would not be enforced`**
`DATABASE_URL` points at a superuser or a `BYPASSRLS` role. Use `APP_DB_USER`,
which `migrate` creates. Working as designed.

**Uploads fail with a signature error**
`STORAGE_ENDPOINT` is not the hostname the browser used. Both sides must agree —
see [Object storage](#object-storage).

**`/readyz` is 503 but `/healthz` is 200**
Readiness includes object storage. The API is up and MinIO or R2 is not. A
service that accepts registrations it cannot fulfil is worse than one that
refuses them.

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

- **Single point of failure at every layer.** One box, one Postgres, one MinIO,
  no replication. A disk failure loses everything since the last nightly dump,
  and object storage is not in that dump.
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
