#!/usr/bin/env bash
# Jsyxi Shipping — one-time server provisioning for the app host.
#
# Idempotent: safe to re-run. Installs Node 22, Redis, nginx and certbot,
# creates the service account and the release layout, then issues the
# app.jsyxi.com certificate.
#
# Run on the server as a sudo-capable user:
#   sudo bash provision.sh
#
# It does NOT write /srv/jsyxi-shipping/shared/.env — deploy.sh uploads that,
# so no secret is ever baked into this script or the repo.

set -euo pipefail

APP_USER=jsyxi
APP_ROOT=/srv/jsyxi-shipping
DOMAIN=app.jsyxi.com
NODE_MAJOR=22

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }

log "Base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg rsync ufw ca-certificates

log "Node ${NODE_MAJOR}"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v${NODE_MAJOR}.* ]]; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
node -v

log "Redis (sessions + BullMQ, loopback only)"
apt-get install -y -qq redis-server
sed -i 's/^# *maxmemory-policy .*/maxmemory-policy noeviction/' /etc/redis/redis.conf || true
# BullMQ requires noeviction; sessions must not be silently dropped either.
grep -q '^maxmemory-policy noeviction' /etc/redis/redis.conf \
  || echo 'maxmemory-policy noeviction' >> /etc/redis/redis.conf
grep -q '^bind 127.0.0.1' /etc/redis/redis.conf \
  || sed -i 's/^bind .*/bind 127.0.0.1 ::1/' /etc/redis/redis.conf
systemctl enable --now redis-server
systemctl restart redis-server

log "nginx + certbot"
apt-get install -y -qq nginx certbot python3-certbot-nginx
mkdir -p /var/www/certbot

log "Service account and release layout"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_ROOT"/{releases,shared/objects}
chown -R "$APP_USER":"$APP_USER" "$APP_ROOT"
# .env holds the master key and DB password — service account only.
touch "$APP_ROOT/shared/.env"
chown "$APP_USER":"$APP_USER" "$APP_ROOT/shared/.env"
chmod 600 "$APP_ROOT/shared/.env"

log "Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ufw status verbose

log "nginx site"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -m 644 "$SCRIPT_DIR/nginx-app.jsyxi.com.conf" "/etc/nginx/sites-available/$DOMAIN"
ln -sfn "../sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
rm -f /etc/nginx/sites-enabled/default

log "TLS certificate for $DOMAIN"
if [[ ! -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  # The site config references certs that do not exist yet, so issue standalone
  # against the webroot with nginx briefly serving :80 only.
  cat > "/etc/nginx/sites-available/$DOMAIN.bootstrap" <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 200 'provisioning'; add_header Content-Type text/plain; }
}
EOF
  ln -sfn "../sites-available/$DOMAIN.bootstrap" "/etc/nginx/sites-enabled/$DOMAIN.bootstrap"
  rm -f "/etc/nginx/sites-enabled/$DOMAIN"
  nginx -t && systemctl reload nginx
  certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" \
    --non-interactive --agree-tos --register-unsafely-without-email
  rm -f "/etc/nginx/sites-enabled/$DOMAIN.bootstrap"
  ln -sfn "../sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
fi
nginx -t && systemctl reload nginx
systemctl enable --now certbot.timer

log "systemd unit"
install -m 644 "$SCRIPT_DIR/jsyxi-shipping.service" /etc/systemd/system/jsyxi-shipping.service
systemctl daemon-reload
systemctl enable jsyxi-shipping

log "Provisioning complete"
echo "Next: run deploy.sh from your workstation to upload .env and the first release."
