# Jsyxi Shipping — §15 Acceptance Matrix

Maintained per A1-13. Status legend: **AUTO** = proven by an automated test (file cited) · **CODE** = implemented, needs live-DB/integration run · **EXT** = blocked on an external dependency (week-0 items) · **MANUAL** = human verification.

Last updated: weeks 16–18 hardening. Suite: 1,700+ tests green (`npm run test`), `npm run typecheck`, `npm run migrate:verify`, `npm run build`.

## §15.1 Courier contract suite

| Item | Status | Evidence |
|---|---|---|
| Fake adapter + contract suite before any real adapter | AUTO | `test/courier-framework/contract-suite.spec.ts` (26 tests) |
| Each launch adapter passes the suite | AUTO | `test/{delhivery,xpressbees,bluedart,dtdc,amazon_shipping,shadowfax,shiprocket}/*contract-suite.spec.ts` (13 each) |
| Ambiguous create timeout → lookupByReference resolution | AUTO | inside each contract-suite run |
| Shiprocket nested service identities | AUTO | `test/shiprocket/` — `serviceId` threaded from the snapshot at booking |
| Amazon Shipping OAuth refresh | AUTO (mock) / EXT (sandbox) | `test/amazon_shipping/`; live refresh evidence pending |
| Sandbox + limited-production smoke evidence | EXT | needs owner courier sandboxes (week 0) |

## §15.2 Platform & Shopify

| Item | Status | Evidence |
|---|---|---|
| Install / reinstall / uninstall | AUTO | `test/shopify/oauth.spec.ts`, `test/shopify/webhooks.spec.ts` |
| Access revocation mid-session | AUTO | entry service tests (`test/shopify/entry.spec.ts`) |
| Split order consolidation + unmergeable fallback → siblings | AUTO | `test/order-sync/allocation.spec.ts` |
| `ships_via_jsyxi = false` → EXCLUDED with reason | AUTO | same file |
| Partial fulfillment, edits, cancellation per stage | AUTO | order-sync + booking suites |
| Webhook retry + 24h sweep | AUTO | `test/order-sync/sweep.spec.ts` |
| Sync throttling under cost budget | AUTO | `test/sync-back/sync-back.worker.spec.ts` |
| GDPR redact/data_request with deletion evidence | AUTO | `test/order-derivation/privacy-redaction.spec.ts`, `test/health/full-redaction.spec.ts` |
| Protected Customer Data Level 2 approved | EXT | owner-side request (week 0) — gates launch |
| TLS 1.2+ enforced, plaintext refused | EXT | terminated at the platform edge — deployment check |
| No buyer PII in logs (log-scraping check) | CODE | salted-hash discipline throughout; scrape script not built |
| Test/live credentials survive mode switch both ways | AUTO | `test/courier-framework/vault.spec.ts` (RW-20) |

## §15.3 Money & trust

| Item | Status | Evidence |
|---|---|---|
| Trial → upgrade → downgrade; cap rejection; pre-pickup reversal; billing idempotency | AUTO | `test/billing/` (46 tests) |
| §4.2 weight fixtures A and B exactly | AUTO | `test/order-derivation/` weight specs |
| §4.4 pricing worked example to the paise (₹158.59) | AUTO | `test/rate-engine/` |
| §4.8 recon example (weight-dispute-without-amount, ₹211.50; control total ₹1,500 → MISMATCH) | AUTO | `test/recon-freight/` |
| ADJUSTMENT compared against the row it adjusts (RW-24) | AUTO | `test/recon-freight/` |
| Partial COD remittance across two files | AUTO | `test/recon-cod/` |
| Shopify-split COD order → two shipments, INV-9 holds, buyer charged once | AUTO | booking + order-derivation suites (INV-9 trigger + §4.7 derivation) |
| Collectible-bearing cancellation → COD_UNASSIGNED | AUTO | `test/booking/cancellation.spec.ts` + derivation specs |
| Chain booking with failed quote → PRIORITY_CHAIN doesn't exclude; basis recorded | AUTO | `test/rules/evaluate-elimination` + booking suites |
| FASTEST excludes stale EDD, not failed price | AUTO | `test/rules/evaluate-elimination` |
| Cross-tenant isolation on lists, exports, signed URLs | AUTO (unit) / CODE (live) | shop-scoping asserted per module; a live end-to-end pass pending DB |
| Full §10.2 matrix role by role; no role reads a credential | AUTO | `test/team/permissions.spec.ts` (matrix re-transcribed + cross-checked) |
| INV-23 audit: no margin, no balance, no payout anywhere | AUTO | `test/billing/invariants.spec.ts` + `test/recon-cod/` surface scans |
| Track-Order abuse: throttle, CAPTCHA, generic failure, no PII leak | AUTO | `test/track-page/` |

## §15.4 Test-mode isolation (RV-08)

| Item | Status | Evidence |
|---|---|---|
| Wizard test booking exercises the real path, contributes nothing to figures/Shopify/GST, is marked + filterable + bulk-deletable with audit | AUTO (unit) | booking worker (no debit for test), rollup INV-19 sides, `test/maintenance/` purge; **wizard UI itself is frontend scope — not built** |

## §15.5 Resilience & scale

| Item | Status | Evidence |
|---|---|---|
| §5.1 envelope, bursts, outage catch-up, 250 dashboard readers, 20×1,000 bulk | CODE | `scripts/loadtest/` harness (unit-tested); **live run pending local stack** |
| Courier outage doesn't block another courier | AUTO | `test/courier-framework/transport-policy.spec.ts` (per-account breaker) |
| Shopify outage / queue outage / 2h catch-up | CODE | harness `outage` scenario; 2h exceeds BullMQ's retry window — documented in `scripts/loadtest/run.ts` |
| DLQ replay with audit | AUTO | `test/admin/dlq-admin.spec.ts` |
| Restore testing | MANUAL | ops procedure |

## §15.6 The launch story

| Item | Status | Evidence |
|---|---|---|
| The full merchant journey (install → connect Delhivery test → rate card → 500-order bulk → labels → tracking → NDR → recon dispute → ticket → reports) | CODE | every step has module-level tests; the end-to-end run needs the live stack + Delhivery sandbox (EXT) |

## Carried gaps (honest list)

- ~~Migrations have never run against a live PostgreSQL~~ **RESOLVED**: all 19 migrations applied on PostgreSQL 18 (throwaway local cluster), seeds ran, and 31/31 SQL-level invariant smoke checks pass as the least-privilege `jsyxi_app` role (`npm run smoke:db`). Two real bugs were found and fixed by this pass: DB encoding must be UTF8 (migrations contain Unicode comments) and the partition helpers needed SECURITY DEFINER (migration 0019).
- Every courier adapter awaits sandbox evidence; each isolates unverified shapes in its `*-api.map.ts` with `TODO(sandbox-verify)`.
- Frontend/dashboard UI is not in this build (API-first; thin HTML shells exist for the public track page).
- `document_kind` has no REPORT value — report exports are served from the object store by convention key (`reports.types.ts` documents this).
- XLSX report output deferred (CSV now; renderer interface ready).
- Bulk label PDF cannot embed courier-fetched PDFs without a PDF library (reported as skips per INV-20).
