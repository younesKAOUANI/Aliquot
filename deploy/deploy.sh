#!/usr/bin/env bash
#
# Runs on the VPS. Invoked by .github/workflows/deploy.yml over SSH, and safe to
# run by hand for a rollback:
#
#   ALIQUOT_IMAGE=ghcr.io/youneskaouani/aliquot:sha-<older> ./deploy.sh
#
# The ordering matters and is the whole reason this is a script rather than a
# one-liner in the workflow: migrations run to completion before any new
# container serves traffic, and the deploy aborts if they fail rather than
# leaving half the stack on a schema the rest does not have.

set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/aliquot}"
ENV_FILE="${ENV_FILE:-/etc/aliquot/aliquot.env}"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.prod.yml"

cd "$DEPLOY_DIR"

if [ ! -f "$ENV_FILE" ]; then
  echo "error: ${ENV_FILE} is missing. See docs/DEPLOYMENT.md." >&2
  exit 1
fi

if [ -z "${ALIQUOT_IMAGE:-}" ]; then
  echo "error: ALIQUOT_IMAGE is not set; a deploy must name exactly what it ships." >&2
  exit 1
fi

# The shared network the edge Caddy reaches this stack over. Declared external
# in the compose file, so its absence would otherwise surface as a compose error
# three steps from now, after the backup and the migrations have already run.
if ! docker network inspect edge > /dev/null 2>&1; then
  echo "error: the 'edge' docker network does not exist. Run 'docker network create edge'." >&2
  echo "       See the edge/ directory of the portfolio repository." >&2
  exit 1
fi

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

echo "==> logging in to ghcr"
if [ -n "${GHCR_TOKEN:-}" ]; then
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-x}" --password-stdin
fi

echo "==> pulling ${ALIQUOT_IMAGE}"
export ALIQUOT_IMAGE
compose pull --quiet postgres || true
docker pull "$ALIQUOT_IMAGE"

# Record what is running now, so a failed deploy can be reversed without
# going to look it up in a workflow log.
PREVIOUS=$(docker inspect --format '{{.Config.Image}}' aliquot-api-1 2>/dev/null || echo 'none')
echo "==> current image: ${PREVIOUS}"
echo "$PREVIOUS" > "${DEPLOY_DIR}/.previous-image"

echo "==> backing up the database before migrating"
# Migrations are forward-only and transactional per file, so a failure leaves
# no trace. This is for the case they succeed and the release is still wrong.
bash "${DEPLOY_DIR}/backup.sh" || {
  echo "error: pre-deploy backup failed; refusing to migrate" >&2
  exit 1
}

echo "==> bringing up dependencies"
compose up -d postgres

echo "==> applying migrations"
if ! compose run --rm migrate; then
  echo "error: migrations failed; nothing has been switched over" >&2
  exit 1
fi

echo "==> rolling the application"
# --remove-orphans is what retires the caddy and minio containers from the
# topology this deployment used to have. It is scoped to the `aliquot` compose
# project, so it cannot touch the other two stacks on the box.
compose up -d --remove-orphans api worker

echo "==> waiting for readiness"
for _ in $(seq 1 40); do
  if compose exec -T api node -e \
      "fetch('http://localhost:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "==> ready"
    break
  fi
  sleep 3
done

if ! compose exec -T api node -e \
    "fetch('http://localhost:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
  echo "error: the api did not become ready. Recent logs:" >&2
  compose logs --tail 60 api >&2
  echo >&2
  echo "roll back with: ALIQUOT_IMAGE=${PREVIOUS} bash ${DEPLOY_DIR}/deploy.sh" >&2
  exit 1
fi

echo "==> pruning old images"
# Scoped to this project by reference, and deliberately not `docker image prune
# -a`: that is daemon-wide, and this box also runs the portfolio and the triage
# engine, whose previous releases are exactly their rollback targets.
#
# `image ls` lists newest first, so this keeps the three most recent and drops
# the rest. The one currently running is among them; rmi refuses to remove an
# image in use anyway, which is the backstop rather than the mechanism.
docker image ls --filter 'reference=ghcr.io/youneskaouani/aliquot' --format '{{.ID}}' \
  | awk '!seen[$0]++' | tail -n +4 | xargs -r docker rmi > /dev/null 2>&1 || true
docker image prune -f > /dev/null || true

echo "==> deployed ${ALIQUOT_IMAGE}"
compose ps
