# Deploying Jsyxi Shipping to app.jsyxi.com

Target: `3.110.185.60` (EC2, ap-south-1) · Postgres on RDS · Redis local to the box
· nginx terminating TLS · app under systemd.

Everything that could be automated already is. Steps 1–4 need credentials that
only you hold; steps 5–7 are single commands.

---

## Status of prerequisites

| # | Item | State |
|---|------|-------|
| 1 | DNS `app.jsyxi.com` → `3.110.185.60` | ✅ verified |
| 2 | App builds, typechecks, 1761 tests pass | ✅ verified |
| 3 | Production secrets generated | ✅ in `.env.production` |
| 4 | Shopify app created + configured | ✅ done (see below) |
| 5 | SSH access | ❌ both local `.pem` files rejected |
| 6 | RDS credentials | ❌ not known |
| 7 | Security group ports 80/443 | ❌ closed |

**Shopify app (done):** "Jsyxi Shipping", org Glowfinch `185104460`, app id
`408326176769`, client id `9f2657d53aeeb33e0326f9e1c7239c83`. Both credentials
are already in `.env.production`. Config was pushed with `shopify app deploy` and
verified by pulling it back: `application_url`, `redirect_urls`, all six scopes,
`embedded = false` and `use_legacy_install_flow = true` are live.

**Webhooks.** Shopify refuses app-specific (declarative) subscriptions while
`use_legacy_install_flow = true`, so the six business topics —
`app/uninstalled`, `app/subscriptions_update`,
`orders/create|updated|cancelled|fulfilled` — are registered **per shop**
against the Admin API at the end of the OAuth callback, by
`src/modules/shopify/webhook-registration.service.ts`.

The topic list is derived from the dispatcher's registered handlers, so a
handler and its subscription cannot drift apart. The sync is idempotent
(reconciles observed against desired), so reinstalls do not duplicate and it can
be re-run as a repair. A failure never blocks the install, but is always audited
as `SHOPIFY_WEBHOOKS_SYNC_PARTIAL` / `SHOPIFY_WEBHOOKS_SYNC_FAILED` — grep those
in `audit_log` if a merchant reports orders not syncing. The GDPR compliance
webhooks are app-level and registered by `shopify app deploy`.

---

## Step 1 — Open ports 80 and 443

EC2 console → Instances → `3.110.185.60` → Security tab → the attached security
group → **Edit inbound rules** → add:

| Type | Protocol | Port | Source |
|------|----------|------|--------|
| HTTP | TCP | 80 | `0.0.0.0/0`, `::/0` |
| HTTPS | TCP | 443 | `0.0.0.0/0`, `::/0` |

Port 80 is not optional — Let's Encrypt's HTTP-01 challenge uses it, so TLS
issuance in step 5 fails without it.

Also confirm the **RDS** security group allows inbound `5432` from the EC2
instance's security group, or the app cannot reach the database.

## Step 2 — Find your SSH login

Both `my-app-key.pem` and `derik_6013.pem` were refused by the server
(`Permission denied (publickey)`), so either neither is this instance's key pair
or the username differs. In the EC2 console, check the instance's **Key pair
name** on the Details tab, then match it to your `.pem`. The username follows
the AMI: Ubuntu → `ubuntu`, Amazon Linux → `ec2-user`, Debian → `admin`.

Verify before going further:

```bash
ssh -i ./my-app-key.pem <USER>@3.110.185.60 "whoami && . /etc/os-release && echo \$PRETTY_NAME"
```

## Step 3 — Shopify app — ALREADY DONE

Created and configured via the CLI; nothing to do here unless you are changing
settings. `shopify.app.toml` in the repo root is the source of truth. To change
anything, edit that file and run:

```bash
shopify app deploy
```

> Two settings in that file are load-bearing, not style choices.
> `embedded = false` and `use_legacy_install_flow = true` exist because the app
> runs its own OAuth to obtain an **online** token carrying `associated_user`.
> Shopify's managed install issues an offline, shop-level token and skips the
> app's callback entirely, which silently destroys the per-staff identity model
> the whole §10.2 RBAC matrix rests on. If the dashboard ever disagrees with the
> TOML, re-run `shopify app deploy` — do not "fix" the TOML to match.

Webhook endpoint: `https://app.jsyxi.com/webhooks/shopify`

**Before onboarding a production store:** `read_orders`/`write_orders` are
Protected Customer Data scopes. Request approval in the app's API access tab —
development stores install without it, production stores do not, and approval
is not instant.

> The app requests `read_orders`/`write_orders`. Shopify gates order data behind
> **Protected Customer Data** approval — request it in the app's API access tab.
> Installs on a development store work without it; production stores do not.
> `docs/week-0-verifications.md` tracks this and the other launch-gating items.

## Step 4 — Fill in `.env.production`

Replace the four `<ANGLE_BRACKET>` placeholders. `deploy.sh` refuses to run
while any remain.

**Back up `MASTER_KEY_HEX` offline before first launch.** Once real Shopify
tokens and courier credentials are encrypted under it, losing it means every
merchant must reinstall and every courier credential must be re-entered.

## Step 5 — Create the database role

The RDS instance resolves to a **private VPC address** (`172.31.48.52`) and is
not reachable from outside the VPC. Run this **on the EC2 box**, not from a
workstation — a local `psql` will simply time out:

```bash
ssh -i ./my-app-key.pem <USER>@3.110.185.60
sudo apt-get install -y postgresql-client
psql "postgres://<OWNER_USER>:<OWNER_PASSWORD>@my-app-postgres.ctiwq4cm6blm.ap-south-1.rds.amazonaws.com:5432/postgres?sslmode=require" \
  -f /tmp/deploy/create-app-role.sql
```

(`deploy/` is already on the box at `/tmp/deploy` after step 6's `scp`, so run
step 6 first if you have not.)

This must happen **before** the first deploy: the migrations `GRANT ... TO
jsyxi_app` by name and error if the role does not exist.

Confirm the RDS security group allows 5432 **from the EC2 instance's security
group**. Being VPC-private is not sufficient on its own.

## Step 6 — Provision the server

```bash
scp -i ./my-app-key.pem -r deploy <USER>@3.110.185.60:/tmp/
ssh -i ./my-app-key.pem <USER>@3.110.185.60 "sudo bash /tmp/deploy/provision.sh"
```

Installs Node 22, Redis (loopback, `noeviction` — BullMQ requires it), nginx,
certbot; creates the `jsyxi` service account and `/srv/jsyxi-shipping`; enables
the firewall; issues the TLS certificate; installs the systemd unit. Idempotent.

## Step 7 — Deploy

From the repo root (Git Bash on Windows):

```bash
ENV_FILE=./.env.production SSH_USER=<USER> SSH_KEY=./my-app-key.pem ./deploy/deploy.sh
```

Runs typecheck + tests locally, uploads `.env` (mode 600, `jsyxi`-owned),
rsyncs the source to a timestamped release, `npm ci` + build on the server, runs
migrations as the owner role, flips the `current` symlink, restarts, and blocks
until `/readyz` passes. Keeps the last 5 releases.

---

## Verify

```bash
curl https://app.jsyxi.com/healthz    # {"status":"ok","uptimeSeconds":N}
curl https://app.jsyxi.com/readyz     # {"status":"ready","database":true,"redis":true}
```

Then open `https://app.jsyxi.com` — you should get the install form. Enter a
development store domain and the full OAuth round trip should end on a
"Connected" page showing the store, account state and your role.

Seed the reference data once:

```bash
ssh -i ./my-app-key.pem <USER>@3.110.185.60 \
  "sudo -u jsyxi bash -c 'cd /srv/jsyxi-shipping/current && set -a && . ../shared/.env && set +a && npm run seed:couriers'"
```

## Operating

```bash
sudo systemctl status jsyxi-shipping
sudo journalctl -u jsyxi-shipping -f
sudo systemctl restart jsyxi-shipping
```

**Rollback** — releases are kept, so it is a symlink flip:

```bash
ls /srv/jsyxi-shipping/releases                       # pick the previous one
sudo ln -sfn /srv/jsyxi-shipping/releases/<TS> /srv/jsyxi-shipping/current
sudo systemctl restart jsyxi-shipping
```

Note this does **not** roll back migrations. If the bad release migrated the
schema, run `npm run migrate:down` deliberately rather than assuming the flip
undid it.

**Deploy without migrating**: `SKIP_MIGRATE=1 ENV_FILE=... ./deploy/deploy.sh`

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| `/readyz` → `"database":false` | RDS security group blocks 5432 from EC2, or bad DSN |
| `/readyz` → `"redis":false` | `systemctl status redis-server` |
| certbot fails in provision | port 80 closed in the security group (step 1) |
| Migrations fail on `GRANT ... jsyxi_app` | step 5 not run |
| OAuth ends in `BAD_HMAC` | `SHOPIFY_API_SECRET` mismatch |
| OAuth ends in `INVALID_SHOP_DOMAIN` | shop must be `*.myshopify.com` |
| Install blocked, `CURRENCY_NOT_INR` | working as designed — INR stores only (INV-2) |
| `STAFF_IDENTITY_UNAVAILABLE` | Shopify returned no `associated_user`; §9.1.2 escalation, not a bug to patch around |
