#!/bin/bash
# First-boot / redeploy bootstrap for bradly-api VM (Debian 12).
set -euo pipefail
exec > /var/log/bradly-bootstrap.log 2>&1
echo "[bradly] bootstrap $(date -Is)"

BUNDLE_URL="${BRADLY_BUNDLE_URL:-https://raw.githubusercontent.com/Branden83/bradly-server-bundle/main/bradly-server.tgz}"
JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 32)}"

apt-get update -qq
apt-get install -y -qq curl rsync build-essential python3 ca-certificates

if ! command -v node >/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

mkdir -p /opt/bradly/data /opt/bradly/server /opt/bradly/deploy
if [[ -n "$BUNDLE_URL" ]]; then
  curl -fsSL "$BUNDLE_URL" -o /tmp/bradly-server.tgz
  tar -xzf /tmp/bradly-server.tgz -C /tmp
  rsync -a /tmp/server/ /opt/bradly/server/
  rsync -a /tmp/deploy/ /opt/bradly/deploy/
fi

cd /opt/bradly/server
npm install --omit=dev
node seed.js || true

sed "s/CHANGE_ME_ON_DEPLOY/${JWT_SECRET}/" /opt/bradly/deploy/bradly-api.service > /etc/systemd/system/bradly-api.service
systemctl daemon-reload
systemctl enable bradly-api
systemctl restart bradly-api

if ! command -v caddy >/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

cp /opt/bradly/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy

curl -sf http://127.0.0.1:443/health && echo " bradly-api ready"
