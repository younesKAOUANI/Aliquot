#!/usr/bin/env bash
#
# One-time VPS preparation, run as root on a FRESH Debian or Ubuntu box:
#
#   DEPLOY_USER=deploy bash bootstrap.sh
#
# Read it first. It is short on purpose.
#
# This box is shared: it also serves the portfolio and the triage engine. This
# script prepares the host for all three, so run it FIRST and ONCE. It resets
# the firewall wholesale, which on an already-serving machine takes three sites
# down for as long as it takes to notice. The guard below refuses to run when
# containers are already present; override it only if you know why.
#
# What it does NOT do: install secrets, create the `edge` docker network, or
# start anything. It prepares the host and stops, because the next step needs
# decisions a script should not make for you.

set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-aliquot}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/aliquot}"
ENV_DIR="/etc/aliquot"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/aliquot}"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi

# `ufw --force reset` below is not survivable by a live host. If anything is
# already running here, this is a re-run against a serving box rather than the
# first-boot it is written for.
if [ "${FORCE:-}" != "1" ] && command -v docker > /dev/null \
  && [ -n "$(docker ps -q 2> /dev/null)" ]; then
  echo "refusing to run: containers are already running on this host." >&2
  echo "This script resets the firewall and is meant for a fresh box." >&2
  echo "If you are certain, re-run with FORCE=1." >&2
  exit 1
fi

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg ufw fail2ban unattended-upgrades

echo "==> docker"
if ! command -v docker > /dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc 2>/dev/null \
    || curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

echo "==> deploy user"
# The deploy user is in the docker group, which is functionally root on this
# box. That is a real and deliberate trade: rootless Docker would be tighter and
# the operational cost is not worth it for a single-service host. Said out loud
# so it is a decision rather than an oversight.
if ! id -u "$DEPLOY_USER" > /dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"

echo "==> directories"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0755 "$DEPLOY_DIR"
install -d -o root -g "$DEPLOY_USER" -m 0750 "$ENV_DIR"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 "$BACKUP_DIR"

echo "==> firewall"
# Everything except SSH and TLS stays shut. None of the three stacks publishes a
# host port other than the edge Caddy's 80/443, so this is belt to that braces:
# a mistakenly published port still does not reach the internet.
ufw --force reset > /dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'ssh'
ufw allow 80/tcp comment 'http, for acme challenges and the redirect'
ufw allow 443/tcp comment 'https'
ufw allow 443/udp comment 'http/3'
ufw --force enable

echo "==> ssh hardening"
cat > /etc/ssh/sshd_config.d/99-aliquot.conf <<'SSHD'
PasswordAuthentication no
PermitRootLogin prohibit-password
KbdInteractiveAuthentication no
SSHD
systemctl reload ssh 2>/dev/null || systemctl reload sshd

echo "==> unattended security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT
systemctl enable --now unattended-upgrades > /dev/null 2>&1 || true
systemctl enable --now fail2ban > /dev/null 2>&1 || true

echo "==> nightly backup at 03:20 UTC"
# The log file must exist and belong to the cron user BEFORE the job first runs.
# cron's shell opens the >> redirect before it execs backup.sh, so against a
# root-owned (or absent, in a root-owned directory) /var/log path it fails with
# EACCES and the script never starts. With no MTA on the box the mail goes
# nowhere, /var/backups fills from deploy-time dumps instead, and the nightly
# backup silently never runs -- which you discover on the day you need it.
install -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0640 /dev/null /var/log/aliquot-backup.log

cat > /etc/cron.d/aliquot-backup <<CRON
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
20 3 * * * ${DEPLOY_USER} ${DEPLOY_DIR}/backup.sh >> /var/log/aliquot-backup.log 2>&1
CRON
chmod 0644 /etc/cron.d/aliquot-backup

# Two other projects share this disk; an unrotated log grows until it is a
# problem for all three.
cat > /etc/logrotate.d/aliquot-backup <<ROTATE
/var/log/aliquot-backup.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  create 0640 ${DEPLOY_USER} ${DEPLOY_USER}
}
ROTATE
chmod 0644 /etc/logrotate.d/aliquot-backup

echo "==> shared docker network"
# The edge Caddy and all three application stacks meet here. Created now so no
# stack has to own it, and none is a startup dependency of the others.
docker network inspect edge > /dev/null 2>&1 || docker network create edge > /dev/null

cat <<DONE

Host prepared, for all three projects on this box. Remaining steps, in order:

  1. Add the CI deploy key
       sudo -u ${DEPLOY_USER} mkdir -p /home/${DEPLOY_USER}/.ssh
       # paste the PUBLIC half of the key whose private half is in the
       # GitHub environment secret DEPLOY_SSH_KEY
       sudo -u ${DEPLOY_USER} tee -a /home/${DEPLOY_USER}/.ssh/authorized_keys
       sudo -u ${DEPLOY_USER} chmod 700 /home/${DEPLOY_USER}/.ssh
       sudo -u ${DEPLOY_USER} chmod 600 /home/${DEPLOY_USER}/.ssh/authorized_keys

  2. Secrets
       sudo cp ${DEPLOY_DIR}/aliquot.env.example ${ENV_DIR}/aliquot.env
       sudo chown root:${DEPLOY_USER} ${ENV_DIR}/aliquot.env
       sudo chmod 640 ${ENV_DIR}/aliquot.env
       sudo \$EDITOR ${ENV_DIR}/aliquot.env
     Generate, do not invent — hex, so the database passwords stay safe inside
     the connection URL they are interpolated into:
       openssl rand -hex 32      # AUTH_JWT_SECRET, POSTGRES_PASSWORD, APP_DB_PASSWORD

  3. DNS for all four names, before the edge Caddy first starts — it needs them
     to resolve to get certificates, and Let's Encrypt rate-limits failures
       A  youneskaouani.dev                -> $(curl -fsS --max-time 5 https://api.ipify.org 2> /dev/null || echo '<this host>')
       A  www.youneskaouani.dev            -> the same address
       A  aliquot.youneskaouani.dev        -> the same address
       A  triage-engine.youneskaouani.dev  -> the same address

  4. Host key for CI. Run locally, then paste into the GitHub environment
     secret DEPLOY_KNOWN_HOSTS — in all three repositories
       ssh-keyscan -t ed25519 <this host>

  5. Bring up the edge, then the three stacks
       gh workflow run deploy.yml     # in younesKAOUANI/portfolio, ships the edge
       gh workflow run deploy.yml     # here
       # and push to main in younesKAOUANI/triage-engine

Runbooks: docs/DEPLOYMENT.md here, and deploy/edge/README.md in the portfolio
repository for the host as a whole.
DONE
