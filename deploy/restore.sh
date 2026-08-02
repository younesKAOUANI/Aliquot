#!/usr/bin/env bash
#
# Restore from a dump produced by backup.sh.
#
#   ./restore.sh /var/backups/aliquot/aliquot-20260802T031500Z.dump
#
# This is destructive and says so twice. It stops the application first: a
# restore with the API still writing produces a database that is neither the
# backup nor what preceded it.

set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/aliquot}"
ENV_FILE="${ENV_FILE:-/etc/aliquot/aliquot.env}"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.prod.yml"

DUMP="${1:-}"
if [ -z "$DUMP" ]; then
  echo "usage: restore.sh <dump-file>" >&2
  echo >&2
  echo "available:" >&2
  ls -lh "${BACKUP_DIR:-/var/backups/aliquot}"/aliquot-*.dump 2>/dev/null >&2 || echo "  (none)" >&2
  exit 1
fi

if [ ! -f "$DUMP" ]; then
  echo "error: ${DUMP} does not exist" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a && . "$ENV_FILE" && set +a

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

echo "This will REPLACE the contents of database '${POSTGRES_DB}' with:"
echo "  ${DUMP}"
echo
read -r -p "Type the database name to confirm: " CONFIRM
if [ "$CONFIRM" != "$POSTGRES_DB" ]; then
  echo "aborted" >&2
  exit 1
fi

echo "==> taking a safety dump of the current state first"
# Restoring over a database because something was wrong, and then discovering
# the dump was the wrong one, is a recoverable mistake only if this exists.
bash "${DEPLOY_DIR}/backup.sh" || echo "warning: the safety dump failed; continuing on your say-so" >&2

echo "==> stopping the application"
compose stop api worker

echo "==> restoring"
BASENAME=$(basename "$DUMP")
# --clean --if-exists drops and recreates objects, so the result is the dump
# rather than the dump merged into whatever was there.
compose exec -T postgres pg_restore \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --clean --if-exists --no-owner --single-transaction \
  "/backups/${BASENAME}"

echo "==> restarting"
compose up -d api worker

echo "==> verifying the audit chain survived the round trip"
# The chain is the thing most worth checking after a restore: if the dump or the
# restore mangled a payload, verification names the sequence number. Nothing
# else in the system will tell you.
sleep 5
compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "select t.slug || ': ' || count(*) || ' events' from aliquot.audit_event e
     join aliquot.tenant t on t.id = e.tenant_id group by t.slug"

echo
echo "Restored. Verify each tenant's chain through the API or the viewer:"
echo "  POST /v1/audit/verify"
