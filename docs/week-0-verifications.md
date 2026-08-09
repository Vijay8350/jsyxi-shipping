# Week-0 Verifications — External API Facts

Researched 2026-08-08 against official Shopify dev docs and courier documentation.
Verdicts: CONFIRMED (official doc states it), PARTIAL (some evidence / caveats),
UNRESOLVED (docs silent or conflicting).

## Summary table

| # | Question | Verdict | Key consequence |
|---|----------|---------|-----------------|
| Q1 | Per-staff identity in non-embedded app | PARTIAL | `associated_user` + `grant_options[]=per-user` confirmed; staff listing (`read_users`) is Plus/Advanced-only — do NOT depend on it; no staff-removal webhook exists |
| Q2 | FulfillmentOrder move/merge | PARTIAL | `fulfillmentOrderMove` + new `fulfillmentOrdersReroute` confirmed; **no merge mutation exists** |
| Q3 | Fulfillment event status enum | CONFIRMED | All 6 required enum names exist verbatim; new `CARRIER_PICKED_UP` added in 2025-10 |
| Q4 | Courier push webhooks (India) | PARTIAL | Yes: Delhivery, Shiprocket, Amazon Shipping. Unclear/undocumented: Xpressbees, Blue Dart, DTDC, Shadowfax — polling fallback stays mandatory |

---

## Q1 — Per-staff identity for a non-embedded app — PARTIAL

### (a) Online access tokens and `associated_user` — CONFIRMED

The current authorization-code-grant guide (shopify.dev, live as of 2026-08) documents
`grant_options[]` = `per-user` on the `/admin/oauth/authorize` URL and shows the online
token response containing `associated_user` with `id`, `first_name`, `last_name`, `email`,
`email_verified`, `account_owner`, `locale`, `collaborator`, plus `associated_user_scope`
and `expires_in` (≈ 24h: `86399` s in the example).
- https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant

Caveat on the same page: *"Apps rendered in the Shopify admin should use token exchange…
This guide is only relevant to standalone apps and legacy apps that aren't using Shopify
managed installation."* For a non-embedded app on its own domain (app.jsyxi.com),
authorization code grant with online tokens remains the documented flow.

### (b) Listing staff / detecting removal — CONFIRMED restricted; no webhook

- `StaffMember` object / `staffMembers` connection on `Shop` exist in the current GraphQL
  Admin API, but require the `read_users` scope, and per the object doc:
  *"The app must be a finance embedded app or installed on a Shopify Plus or Advanced store.
  Contact Shopify Support to enable this scope for your app."*
  - https://shopify.dev/docs/api/admin-graphql/latest/objects/StaffMember
  - Access-scope table marks `read_users` → `StaffMember` as "shopify plus":
    https://shopify.dev/docs/api/usage/access-scopes
- There is **no webhook topic for staff/user add/remove** in Shopify's webhook
  documentation (no `staff_members/*` or `users/*` topic exists). Community threads
  confirm apps have no push signal for staff removal:
  https://community.shopify.com/t/shopify-staff-api-webhook/130945

### Recommended pattern (current docs)

For standalone/non-embedded apps: per-user OAuth (online tokens), use
`associated_user.id` (+ `email_verified` before trusting `email`) as the identity, and let
the ~24-hour token expiry force re-OAuth — a removed staff member can no longer complete
OAuth for the shop, which is the only documented "revocation" signal. There is no
documented API to poll staff status on non-Plus stores.

### Consequence for the codebase

- `src/modules/shopify/oauth.service.ts` (`grant_options[]=per-user`, reads
  `associated_user`): matches the current documented flow. Keep it.
- `entry.service.ts` "re-validates staff on each entry": **this cannot use
  `staffMembers`/`staffMember` queries** — `read_users` is unavailable to a public app
  installed on regular (non-Plus) Indian merchant stores, and requesting it requires
  Shopify Support approval. Re-validation must rely on online-token expiry + re-OAuth.
  The 15-min fail-open cache is therefore not a nicety but a hard requirement; size the
  revocation window around the 24h token lifetime, not the cache TTL.

---

## Q2 — FulfillmentOrder move/merge — PARTIAL

### Move — CONFIRMED

`fulfillmentOrderMove` (current GraphQL Admin API) changes the location assigned to
unfulfilled FO line items. Requires `write_merchant_managed_fulfillment_orders` or
`write_third_party_fulfillment_orders`, and the user must have the
`fulfill_and_ship_orders` permission.
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentOrderMove

Documented failure modes:
- FO is closed.
- FO has manually reported progress (must first be re-opened, resolving the progress state).
- Destination location doesn't stock the requested inventory item.
- API client lacks permissions.
- Request status is `SUBMITTED`, `ACCEPTED`, `CANCELLATION_REQUESTED`, or
  `CANCELLATION_REJECTED` (awaiting fulfillment-service action; must cancel first).
- Already-fulfilled line items can never be re-assigned.

Behavior note: moving all line items updates `assignedLocation`; moving a subset — or
moving to a location that already has an active FO on the same order — **closes the
original FO and creates a new one** at the destination (i.e., line items are re-created,
not merged into the existing FO).

Also new: `fulfillmentOrdersReroute` (changelog 2025-10) moves FOs to the "next best
location" per the shop's delivery strategies, with optional `excludedLocationIds`.
- https://shopify.dev/changelog/rerouting-fulfillment-orders-via-api

### Merge — CONFIRMED ABSENT

No `fulfillmentOrderMerge` (or equivalent) mutation exists in the GraphQL Admin API.
Consolidation can only be approximated by moving FOs to a common location; even then
Shopify may create a new FO rather than combine them.

### Consequence for the codebase

- `src/modules/order-sync/allocation.service.ts` `canMergeFulfillmentOrders` defaulting to
  `true` (allocation.service.ts:39) is optimistic: there is no true merge. The seam should
  attempt `fulfillmentOrderMove` to a common location and treat the documented failure
  modes (closed FO, non-UNSUBMITTED request status, unstocked destination, progress
  reported) as the fallback trigger to one-shipment-per-FO (spec §9.2.3). Also gate on the
  FO's `supportedActions` containing `MOVE` before attempting.

---

## Q3 — Fulfillment event status values — CONFIRMED

Current `FulfillmentEventStatus` enum for the GraphQL Admin API (used by
`fulfillmentEventCreate`'s `FulfillmentEventInput.status`), exact values:
- https://shopify.dev/docs/api/admin-graphql/latest/enums/FulfillmentEventStatus
- https://shopify.dev/docs/api/admin-graphql/latest/input-objects/FulfillmentEventInput

```
ATTEMPTED_DELIVERY   CARRIER_PICKED_UP (new in 2025-10)   CONFIRMED
DELAYED              DELIVERED                            FAILURE
IN_TRANSIT           LABEL_PRINTED                        LABEL_PURCHASED
OUT_FOR_DELIVERY     READY_FOR_PICKUP
```

Each required name verified verbatim: `CONFIRMED` ✔, `IN_TRANSIT` ✔,
`OUT_FOR_DELIVERY` ✔, `DELIVERED` ✔, `ATTEMPTED_DELIVERY` ✔, `FAILURE` ✔.
`FAILURE` is documented as "The fulfillment request failed." New in 2025-10:
`CARRIER_PICKED_UP` ("picked up by the carrier") — worth using for the manifest/pickup
internal status if the app targets API ≥ 2025-10.
- https://shopify.dev/changelog/new-carrier-picked-up-fulfillment-status

Note: the Customer API's `FulfillmentEventStatus` differs (`PICKED_UP` instead of
`CARRIER_PICKED_UP`) — do not cross-use enums.

### Consequence for the codebase

- `src/modules/sync-back/fulfillment-event.map.ts`: the 12→6-status mapping, including
  collapsing RTO/lost/cancelled onto `FAILURE`, is valid as-is against the current Admin
  API enum. Optional: map the pickup/manifest status to `CARRIER_PICKED_UP` on
  API ≥ 2025-10 instead of `CONFIRMED`.

---

## Q4 — Courier webhook capability (India) — PARTIAL

| Courier | Push webhook? | Evidence | Auth/signature mechanism |
|---------|---------------|----------|--------------------------|
| Delhivery | YES (CONFIRMED) | Official docs: "Tracking via PUSH API — Web hook", Delhivery pushes scans to a client endpoint. Manual onboarding, ~5-6 working days. https://delhivery-express-api-doc.readme.io/reference/tracking-via-push-api-webhook-1 | Client shares "extra details… such as authorization header" during setup — i.e. a static auth header you define; no documented HMAC signature |
| Shiprocket | YES (CONFIRMED) | Official API docs: "You can set up a webhook with Shiprocket to get tracking updates. We will proactively notify your system whenever there is a new tracking event." Configured at Settings → API → Webhook. https://apidocs.shiprocket.in/ | No documented HMAC signature; single webhook URL per account (panel-configured) |
| Amazon Shipping (IN) | YES (CONFIRMED) | Official push-notification docs (Shipping V2 API); manual onboarding via account manager (~5 business days); HTTPS mandatory; location data confirmed available for IN marketplace. https://developer-docs-amazon-shipping.readme.io/apis/docs/track-a-shipment-push-notifications | Merchant's choice of 4 mechanisms: API key header, query param, Basic auth, or OAuth 2.0 client-credentials bearer. No HMAC signing |
| Xpressbees | UNCLEAR | No official public doc found confirming merchant-facing push webhooks; official B2B API docs cover polling. Only third-party aggregators (AfterShip etc.) offer Xpressbees webhooks | n/a |
| Blue Dart | UNCLEAR (leaning NO) | Official/DHL developer portal documents pull-only tracking APIs (TrackDart, Shipment Tracking API). No official push-webhook doc found. https://developer.dhl.com/api-reference/shipment-tracking-dhl-ecommerce-india-blue-dart | n/a |
| DTDC | UNCLEAR | Official customer API docs cover polling by AWB/reference. "Webhook-based status push" claims come from integrator (ClickPost) pages describing their own layer, not confirmed DTDC-native | n/a |
| Shadowfax | UNCLEAR | ClickPost mentions two tracking methods (polling + push) for Shadowfax; no official public Shadowfax webhook doc found. Push appears to be enterprise/onboarding-gated if it exists | n/a |

### Consequence for the codebase

- `src/modules/courier-framework/courier-webhook.controller.ts` (per-account HMAC URL):
  directly usable for Delhivery, Shiprocket, Amazon Shipping — but note **none of the
  three documented couriers sign payloads with HMAC**. They use static auth
  headers / API keys / Basic / OAuth, or nothing (Shiprocket). The controller must
  support per-courier auth schemes (static secret header + source validation), not
  assume HMAC verification.
- Onboarding for Delhivery and Amazon Shipping is **manual and account-manager-driven**
  (days of lead time) — bake this into the courier-onboarding flow; do not expect
  self-serve webhook registration.
- The §8.5 polling fallback (2h/4h cadence) remains **mandatory**: Xpressbees, Blue Dart,
  DTDC, Shadowfax have no confirmed push channel, and even for confirmed couriers the
  webhook setup may not be completed by every merchant account.
