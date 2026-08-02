#!/usr/bin/env bash
#
# One-time VPS preparation, run as root on a fresh Debian or Ubuntu box:
#
#   curl -fsSL https://raw.githubusercontent.com/younesKAOUANI/Aliquot/main/deploy/bootstrap.sh | bash
#
# or, preferably, read it first and then run it. It is short on purpose.
#
# What it does NOT do: install secrets, or start anything. It prepares the host
# and stops, because the next step needs decisions a script should not make for
# you.

set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-aliquot}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/aliquot}"
ENV_DIR="/etc/aliquot"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/aliquot}"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
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
# Everything except SSH and TLS stays shut. Postgres and MinIO publish no host
# port in the production compose file, so this is belt to that braces: a
# mistakenly published port still does not reach the internet.
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
cat > /etc/cron.d/aliquot-backup <<CRON
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
20 3 * * * ${DEPLOY_USER} ${DEPLOY_DIR}/backup.sh >> /var/log/aliquot-backup.log 2>&1
CRON
chmod 0644 /etc/cron.d/aliquot-backup

cat <<DONE

Host prepared. Remaining steps, in order:

  1. Add the CI deploy key
       sudo -u ${DEPLOY_USER} mkdir -p /home/${DEPLOY_USER}/.ssh
       # paste the PUBLIC half of the key whose private half is in the
       # GitHub environment secret DEPLOY_SSH_KEY
       sudo -u ${DEPLOY_USER} tee -a /home/${DEPLOY_USER}/.ssh/authorized_keys
       sudo -u ${DEPLOY_USER} chmod 700 /home/${DEPLOY_USER}/.ssh
       sudo -u ${DEPLOY_USER} chmod 600 /home/${DEPLOY_USER}/.ssh/authorized_keys

  2. Secrets
       sudo cp ${DEPLOY_DIR}/aliquot.env.example ${ENV_DIR}/aliquot.env
       sudo chmod 600 ${ENV_DIR}/aliquot.env
       sudo \$EDITOR ${ENV_DIR}/aliquot.env
     Generate, do not invent:
       openssl rand -hex 32      # AUTH_JWT_SECRET
       openssl rand -base64 24   # POSTGRES_PASSWORD, APP_DB_PASSWORD, storage keys

  3. DNS, before the first deploy — Caddy needs the names to resolve to get
     certificates, and Let's Encrypt rate-limits failures
       A  aliquot.youneskaouani.dev          -> $(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<this host>')
       A  storage.aliquot.youneskaouani.dev  -> the same address
     The second record is only needed while BUNDLED_STORAGE=true.

  4. Host key for CI. Run locally, then paste into the GitHub environment
     secret DEPLOY_KNOWN_HOSTS
       ssh-keyscan -t ed25519 <this host>

  5. First deploy, from your laptop
       gh workflow run deploy.yml

Full runbook: docs/DEPLOYMENT.md
DONE
