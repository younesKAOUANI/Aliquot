#!/usr/bin/env bash
#
# Database backup. Run before every deploy and nightly from cron.
#
# A backup nobody has restored is a hypothesis, not a backup -- so this writes
# a custom-format dump that `restore.sh` consumes directly, and verifies the
# dump is readable before it counts as a success. A truncated pg_dump that
# nobody notices until the day it is needed is the standard way this fails.

set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/aliquot}"
ENV_FILE="${ENV_FILE:-/etc/aliquot/aliquot.env}"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.prod.yml"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"

# Every path below is absolute, but `docker compose` still stats the working
# directory, and this runs from wherever it was invoked -- deploy.sh has already
# cd'd here, cron starts in the user's home, and a hand-run from somewhere the
# deploy user cannot read fails with
#   error in parsing "compose-spec.json": stat .: permission denied
# which names neither the directory nor the backup. Anchor it.
cd "$DEPLOY_DIR"

# shellcheck disable=SC1090
set -a && . "$ENV_FILE" && set +a

BACKUP_DIR="${BACKUP_DIR:-/var/backups/aliquot}"
mkdir -p "$BACKUP_DIR"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
NAME="aliquot-${STAMP}.dump"

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

echo "==> dumping to ${BACKUP_DIR}/${NAME}"
# -Fc: custom format, compressed and selectively restorable.
# The dump is written inside the container to the bind-mounted /backups, so it
# lands on the host without streaming through the SSH session.
compose exec -T postgres pg_dump \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -Fc -f "/backups/${NAME}"

echo "==> verifying the dump is readable"
# pg_restore --list parses the archive's table of contents. It does not prove
# the data restores, but it does catch a truncated or corrupt file, which is the
# failure that otherwise goes unnoticed for months.
if ! compose exec -T postgres pg_restore --list "/backups/${NAME}" > /dev/null; then
  echo "error: the dump is not readable; removing it rather than keeping a broken backup" >&2
  compose exec -T postgres rm -f "/backups/${NAME}" || true
  exit 1
fi

SIZE=$(compose exec -T postgres stat -c %s "/backups/${NAME}" | tr -d '\r')
echo "==> ${NAME} (${SIZE} bytes) verified"

# A dump far smaller than the last one usually means the database was empty or
# the dump aborted early. Worth shouting about while somebody is still watching.
PREVIOUS=$(find "$BACKUP_DIR" -name 'aliquot-*.dump' -not -name "$NAME" -printf '%s\n' 2>/dev/null | sort -n | tail -1 || echo 0)
if [ "${PREVIOUS:-0}" -gt 0 ] && [ "$SIZE" -lt $((PREVIOUS / 2)) ]; then
  echo "warning: this dump is less than half the size of the previous one (${SIZE} vs ${PREVIOUS})" >&2
fi

echo "==> pruning dumps older than ${RETAIN_DAYS} days"
find "$BACKUP_DIR" -name 'aliquot-*.dump' -mtime "+${RETAIN_DAYS}" -delete

echo "==> backups on disk:"
ls -lh "$BACKUP_DIR" | tail -5
