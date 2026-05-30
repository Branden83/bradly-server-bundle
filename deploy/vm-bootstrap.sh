#!/bin/bash
# First-boot / redeploy bootstrap for Bradley API VM (Debian 12).
# GCP instance may still be named bradly-api (Compute Engine names are immutable).
set -euo pipefail
exec > /var/log/bradley-bootstrap.log 2>&1
echo "[bradley] bootstrap $(date -Is)"

BUNDLE_URL="${BRADLEY_BUNDLE_URL:-https://raw.githubusercontent.com/Branden83/bradly-server-bundle/main/bradley-server.tgz}"
JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 32)}"

# Migrate legacy /opt/bradly layout and systemd unit
if [[ -d /opt/bradly && ! -d /opt/bradley ]]; then
  mv /opt/bradly /opt/bradley
fi
if systemctl is-enabled bradly-api >/dev/null 2>&1; then
  systemctl disable bradly-api || true
  systemctl stop bradly-api || true
fi

apt-get update -qq
apt-get install -y -qq curl rsync build-essential python3 ca-certificates

if ! command -v node >/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

mkdir -p /opt/bradley/data /opt/bradley/server /opt/bradley/deploy
if [[ -n "$BUNDLE_URL" ]]; then
  curl -fsSL "$BUNDLE_URL" -o /tmp/bradley-server.tgz
  tar -xzf /tmp/bradley-server.tgz -C /tmp
  rsync -a /tmp/server/ /opt/bradley/server/
  rsync -a /tmp/deploy/ /opt/bradley/deploy/
fi

cd /opt/bradley/server
npm install --omit=dev
node seed.js || true

sed "s/CHANGE_ME_ON_DEPLOY/${JWT_SECRET}/" /opt/bradley/deploy/bradley-api.service > /etc/systemd/system/bradley-api.service
systemctl daemon-reload
systemctl enable bradley-api
systemctl restart bradley-api

if ! command -v caddy >/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

cp /opt/bradley/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy

curl -sf https://34-134-19-51.sslip.io/health && echo " bradley-api ready"
