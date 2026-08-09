# Jsyxi Shipping

Shopify shipping app for the Indian market. Build authority: `spec.md` (FINAL SPEC) + `spec-addendum-A.md` (Addendum A, rank 1.5). Phase-1 plan: see the approved plan (§14 weeks 0–4 scope).

## Stack (§5.7, author-locked)

NestJS 11 + TypeScript · PostgreSQL 15+ · Redis + BullMQ · S3-compatible object storage · Docker.

## Layout

- `migrations/` — node-pg-migrate SQL migrations. DB-level enforcement of the spec's invariants lives here (append-only guards, unique partial indexes, snapshot write-once trigger, INV-3/INV-24 single-row indexes, INV-9 collectible trigger, INV-11 seal guards).
- `src/common/` — money (paise integers, INV-15), crypto (HMAC, salted PII hashes), envelope encryption (§5.7 control 1).
- `src/auth/` — server-side sessions bound to `(shop_id, member_id)` (INV-1, RW-04, OVR-1).
- `src/audit/` — the only writer to `audit_log` (§12).
- `src/modules/` — one directory per spec module: `shopify` (OAuth, entry, §8.1 ingest, uninstall) · `team` (§10.2 RBAC matrix) · `native-auth` (OVR-1) · `platform` (settings, i18n, entitlement ledger, API keys) · `order-sync` (§9.2) · `order-derivation` (F-24/F-15/F-17, §3.5, INV-7/9, F-22, phase-1 GDPR) · `courier-framework` (§8.2/§15.1, vault, transport policy) · `rate-engine` (F-1…F-12/F-23, §9.15) · the seven adapters (`delhivery`, `xpressbees`, `bluedart`, `dtdc`, `amazon_shipping`, `shadowfax`, `shiprocket`) · `booking` (§3.2, §2.9, §9.5.4) · `booking-ops` (§9.5.2/§9.5.3/§9.5.5) · `sync-back` (§8.4) · `tracking` (§8.5/§9.7, the §3.4 reducer) · `track-page` (§9.16) · `rules` (§9.4 + ADD-01…17) · `labels` (§9.9.1) · `gst` (§9.9.2) · `ndr` (§9.8) · `dashboard` (§9.10) · `reports` (§11) · `notifications` (§9.21 + ADD-25…28) · `recon-freight` / `recon-cod` (§9.17) · `support` (§9.18/§9.19) · `admin` (§9.13/§10.3 + ADD-31/32/33) · `billing` (§9.14, INV-23's only charge path) · `health` (ADD-29/30 + §5.5 completion) · `maintenance` (§5.3/§5.4 retention, §9.5.7 purge, partitions).
- `scripts/` — seeds (`seed:couriers`, `seed:admin`), migration parser-check, `loadtest/` (§5.1 harness).
- `docs/acceptance-matrix.md` — the §15 matrix with per-item evidence (A1-13).
- `test/` — vitest unit suites mirroring the modules.

## Dev setup

1. PostgreSQL 15+ running locally (a throwaway cluster works: `initdb -D var/pgtest/data -U postgres --auth=trust && pg_ctl -D var/pgtest/data -o "-p 5433" start`). Create the DB **with UTF8 encoding** (migrations contain Unicode) and the least-privilege app role:
   ```sql
   CREATE DATABASE jsyxi TEMPLATE template0 ENCODING 'UTF8';
   CREATE ROLE jsyxi_app LOGIN PASSWORD 'change-me';
   ```
   The migration owner (e.g. `postgres`) runs migrations; the app connects as `jsyxi_app`, which has no UPDATE/DELETE on append-only tables.
2. Redis on `localhost:6379` (sessions, BullMQ queues).
3. `cp .env.example .env` and fill in: `DATABASE_URL`, `DATABASE_APP_URL`, `SHOPIFY_API_KEY/SECRET`, `MASTER_KEY_HEX` (64 hex chars — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), `PII_HASH_SALT`, `JSYXI_INTERNAL_TOKEN`.
4. `npm install`
5. `npm run migrate` — applies `migrations/`.
6. `npm run seed:couriers && ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run seed:admin`
7. `npm run smoke:db` — proves the §6 guards fire (31 checks, run as jsyxi_app).
8. `npm run start:dev`

## Checks

- `npm run test` — vitest suites (282 tests; includes the §4.2 weight fixtures A/B and the full §10.2 matrix).
- `npm run typecheck`
- `npm run migrate:verify` — parses all migration SQL with the real PostgreSQL parser (no server needed).

## Non-negotiables (spec §6, Addendum A working rules)

- INV-23: no margin, no wallet, no balance, no payout — anywhere.
- `shop_id` scopes every row, query, cache key, queue key, object path and signed URL (INV-1).
- Money is INR, integer paise internally, rounded half-up per component (INV-15). No floats for money.
- Immutable/append-only/sealed is enforced at the database level, not just in application code.
- No merchant parcel split (RV-06); no customer returns (RV-15); one shipment = one parcel (INV-4).

## Week-0 external items (owner-side, not code)

Per `spec.md` §14 week 0 + Addendum A Part E: Protected Customer Data Level 2 request (gates launch); three Shopify verifications (per-staff identity for non-embedded apps, fulfillment-order move/merge, fulfillment-event status values); DLT entity/sender-ID/template registration; WhatsApp BSP + template approval; payment-link provider for ADD-27 (must settle buyer→merchant directly — INV-23); per-courier webhook capability confirmation; India PIN-code dataset for `postal_pincode` seeding.
