#!/usr/bin/env bash
# Jsyxi Shipping — release deploy.
#
# Ships the working tree to the server, builds it there, runs migrations, then
# atomically flips the `current` symlink and restarts the service. The previous
# release stays on disk so a rollback is a symlink flip.
#
# Usage (from the repo root, e.g. Git Bash on Windows):
#   SSH_USER=ubuntu SSH_KEY=./my-app-key.pem ./deploy/deploy.sh
#
# Optional:
#   ENV_FILE=./.env.production   upload this as the server's shared/.env
#   SKIP_MIGRATE=1               deploy code without running migrations
#   HOST=3.110.185.60

set -euo pipefail

HOST="${HOST:-3.110.185.60}"
SSH_USER="${SSH_USER:?set SSH_USER (the server login, e.g. ubuntu)}"
SSH_KEY="${SSH_KEY:?set SSH_KEY (path to the .pem)}"
ENV_FILE="${ENV_FILE:-}"
APP_ROOT=/srv/jsyxi-shipping
APP_USER=jsyxi

RELEASE="$(date -u +%Y%m%d%H%M%S)"
TARGET="$APP_ROOT/releases/$RELEASE"
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$HOST")

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

log "Local checks"
npm run typecheck
npm test

if [[ -n "$ENV_FILE" ]]; then
  log "Uploading environment file"
  [[ -f "$ENV_FILE" ]] || { echo "ENV_FILE $ENV_FILE not found" >&2; exit 1; }
  # A '<PLACEHOLDER>' that reaches the server produces a confusing runtime
  # failure much later (bad DSN, or a Shopify HMAC that never verifies), so
  # refuse here where the cause is obvious.
  # `^[^#]*` keeps this to real assignments — comments may mention placeholders.
  if grep -nE '^[^#]*<[A-Z_]+>' "$ENV_FILE"; then
    echo "" >&2
    echo "^^ $ENV_FILE still has unfilled placeholders. Fill them and re-run." >&2
    exit 1
  fi
  scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$ENV_FILE" "$SSH_USER@$HOST:/tmp/jsyxi.env"
  "${SSH[@]}" "sudo install -o $APP_USER -g $APP_USER -m 600 /tmp/jsyxi.env $APP_ROOT/shared/.env && rm -f /tmp/jsyxi.env"
fi

log "Uploading source to release $RELEASE"
"${SSH[@]}" "sudo mkdir -p $TARGET && sudo chown $SSH_USER:$SSH_USER $TARGET"

# Each release is a fresh empty directory, so there is nothing to delta against
# and nothing to --delete. rsync is nicer when present, but Git Bash on Windows
# ships tar and not rsync, so fall back to streaming a tarball over the same SSH
# connection. Excludes are identical in both paths — keep them in sync, and note
# that .env / *.pem / keys must never leave the workstation.
EXCLUDES=(
  --exclude='.git' --exclude='node_modules' --exclude='dist'
  --exclude='var' --exclude='.env' --exclude='.env.production'
  --exclude='*.pem' --exclude='*.log'
  --exclude='jsyxi-deploy-key' --exclude='jsyxi-deploy-key.pub'
  --exclude='.shopify'
)
if command -v rsync >/dev/null 2>&1; then
  rsync -az --delete -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new" \
    "${EXCLUDES[@]}" ./ "$SSH_USER@$HOST:$TARGET/"
else
  echo "  rsync unavailable — streaming tar over ssh"
  tar czf - "${EXCLUDES[@]}" . | "${SSH[@]}" "tar xzf - -C $TARGET"
fi

# The secrets live only in shared/.env; prove none rode along in the payload.
if "${SSH[@]}" "test -e $TARGET/.env -o -e $TARGET/.env.production -o -n \"\$(find $TARGET -maxdepth 1 -name '*.pem' -print -quit)\""; then
  echo "ABORT: a secret file reached the release directory" >&2
  "${SSH[@]}" "sudo rm -rf $TARGET"
  exit 1
fi

log "Installing dependencies and building"
"${SSH[@]}" "cd $TARGET && npm ci --no-audit --no-fund && npm run build"

# Hand the release to the service account BEFORE migrating: the migration step
# runs as $APP_USER so it can read shared/.env (mode 600, jsyxi-owned) directly
# rather than the deploying user echoing secrets through its own shell.
log "Transferring release ownership to $APP_USER"
"${SSH[@]}" "sudo chown -R $APP_USER:$APP_USER $TARGET"

if [[ "${SKIP_MIGRATE:-0}" != "1" ]]; then
  log "Running migrations (DATABASE_URL = migration owner role)"
  # node-pg-migrate reads DATABASE_URL; the app itself connects as the
  # least-privilege DATABASE_APP_URL role at runtime. Sourcing the env file
  # inside the jsyxi shell keeps the password out of the process list.
  "${SSH[@]}" "sudo -u $APP_USER bash -c 'cd $TARGET && set -a && . $APP_ROOT/shared/.env && set +a && npx node-pg-migrate up'"
fi

log "Activating release"
"${SSH[@]}" "sudo ln -sfn $TARGET $APP_ROOT/current && \
  sudo systemctl restart jsyxi-shipping"

log "Waiting for readiness"
for i in $(seq 1 30); do
  if "${SSH[@]}" "curl -fsS --max-time 3 http://127.0.0.1:3000/readyz" >/dev/null 2>&1; then
    "${SSH[@]}" "curl -fsS http://127.0.0.1:3000/readyz"; echo
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "Service did not become ready. Recent logs:" >&2
    "${SSH[@]}" "sudo journalctl -u jsyxi-shipping -n 60 --no-pager" >&2
    exit 1
  fi
  sleep 2
done

log "Pruning old releases (keeping 5)"
"${SSH[@]}" "cd $APP_ROOT/releases && ls -1dt */ | tail -n +6 | xargs -r sudo rm -rf"

log "Verifying public endpoint"
# Informational only: until the security group opens 80/443 and certbot has run,
# there is nothing to answer publicly. The release is already proven healthy by
# the /readyz gate above, so a failure here must not fail the deploy.
if curl -fsS --max-time 10 "https://app.jsyxi.com/healthz" 2>/dev/null; then
  echo " — public HTTPS OK"
elif curl -fsS --max-time 10 "http://app.jsyxi.com/healthz" 2>/dev/null; then
  echo " — public HTTP OK (TLS not issued yet)"
else
  echo "  not publicly reachable yet — open 80/443 in the security group, then run certbot"
fi

log "Deployed release $RELEASE"
