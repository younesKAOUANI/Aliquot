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

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

# The bundled MinIO only runs when the deployment is using it. Pointing
# STORAGE_ENDPOINT at R2 or S3 and leaving BUNDLED_STORAGE unset means the
# profile stays off and no object store container is started.
PROFILES=()
if [ "${BUNDLED_STORAGE:-true}" = "true" ]; then
  PROFILES+=(--profile bundled-storage)
fi

echo "==> logging in to ghcr"
if [ -n "${GHCR_TOKEN:-}" ]; then
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-x}" --password-stdin
fi

echo "==> pulling ${ALIQUOT_IMAGE}"
export ALIQUOT_IMAGE
compose "${PROFILES[@]}" pull --quiet postgres caddy || true
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
compose "${PROFILES[@]}" up -d postgres
if [ "${BUNDLED_STORAGE:-true}" = "true" ]; then
  compose "${PROFILES[@]}" up -d minio
fi

echo "==> applying migrations"
if ! compose "${PROFILES[@]}" run --rm migrate; then
  echo "error: migrations failed; nothing has been switched over" >&2
  exit 1
fi

echo "==> rolling the application"
compose "${PROFILES[@]}" up -d --remove-orphans api worker caddy

echo "==> waiting for readiness"
for _ in $(seq 1 40); do
  if compose "${PROFILES[@]}" exec -T api node -e \
      "fetch('http://localhost:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "==> ready"
    break
  fi
  sleep 3
done

if ! compose "${PROFILES[@]}" exec -T api node -e \
    "fetch('http://localhost:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
  echo "error: the api did not become ready. Recent logs:" >&2
  compose "${PROFILES[@]}" logs --tail 60 api >&2
  echo >&2
  echo "roll back with: ALIQUOT_IMAGE=${PREVIOUS} bash ${DEPLOY_DIR}/deploy.sh" >&2
  exit 1
fi

echo "==> pruning images older than a week"
# Keeps the last few releases available for a rollback while stopping the disk
# filling with every image ever deployed.
docker image prune -af --filter 'until=168h' > /dev/null || true

echo "==> deployed ${ALIQUOT_IMAGE}"
compose "${PROFILES[@]}" ps
