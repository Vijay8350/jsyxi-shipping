# Jsyxi Shipping — ADDENDUM A (additions to FINAL SPEC)

**Owner:** Mahesh Rojasara
**Relationship to `spec.md`:** This document is **additive only**. It does not edit, reword or reopen anything in `spec.md`. Where it changes a settled decision, it says so explicitly and names the decision ID being overridden.
**Authority:** Rank 1.5 — above §9 behaviour sections, below §1–§8/§10 of `spec.md`, **except** for the three explicit overrides in §C0 below, which win outright.

---

## PART A — How to hand this to Claude Code

Paste this text as your opening message, and attach both `spec.md` and this file:

> I'm building "Jsyxi Shipping", a Shopify shipping app for the Indian market. Two documents are attached:
>
> 1. `spec.md` — the FINAL SPEC and build authority. Treat it as binding. Do not re-derive, simplify or "improve" anything in it. If you think something in it is wrong, say so and stop — do not silently change it.
> 2. `spec-addendum-A.md` — additions I want on top of the spec. It is additive only, except for three named overrides.
>
> Before writing any code:
>
> - Read `spec.md` §0 (authority order), §6 (invariants) and §13 (decision register) first. §6 and §13.1 are non-negotiable. In particular **INV-23** — there is no margin field, no wallet, no balance, no payout anywhere in this product — and **RV-06** (no merchant parcel split) and **RV-15** (no customer returns), unless Addendum A overrides them.
> - Read Addendum A §C0 to see which spec decisions I am overriding.
> - Then give me a build plan for phase 1 only, mapped to `spec.md` §14 weeks 0–4, listing (a) the database schema you'll create, (b) which §6 invariants each table enforces and how, (c) anything in either document you think is ambiguous. Do not start coding until I approve the plan.
>
> Working rules for the whole project:
> - Every entity, enum, formula (F-n), invariant (INV-n) and setting (S-n) is already named in `spec.md` §1–§8. Use those exact names. Never invent a parallel name for a concept that already has one.
> - Anything the spec marks immutable, append-only or sealed must be enforced at the database level, not just in application code.
> - `shop_id` scopes every row, query, cache key, queue key, object path and signed URL (INV-1). No exceptions.
> - Money is INR, integer paise internally, rounded half-up per component (INV-15). No floats for money, ever.
> - Every external call and every state transition is testable against a deterministic fake adapter before any real courier is wired (§15.1).
> - When you are unsure, ask. Do not guess and do not fill gaps by reflex — the spec's closing notes list exactly the gaps an implementer tends to invent.

**Then, per work session**, open with: *"Working on §X of spec.md plus ADD-nn of Addendum A. Restate what those sections require before you write code."* This single habit prevents most drift.

---

## PART B — Already in the spec. Do not re-request these.

Asking for these again will make Claude Code re-derive things that are already settled, which is how a spec gets quietly rewritten.

| Feature | Already at |
|---|---|
| Rules on weight, order amount, payment mode (COD/prepaid), pincode include **and** exclude, saved zone, pincode CSV upload, SKU, tag | §3.9 |
| Manual override of the rule's chosen courier at booking time | §9.5.1 |
| Rule priority ordering, first-match-wins, fallback chain, simulator, full evaluation trace | §9.4 |
| Admin-uploaded guide video + step doc + PDF per courier, shown in-app, live instantly | §9.13, §9.12, §9.1.3 |
| Per-Shop per-courier webhook URL with signing secret for status updates | §8.5, §9.12 |
| App runs on your own domain (`app.jsyxi.com`), non-embedded | §9.1.1 |
| NDR module with inbox, reasons, reattempt, address update, initiate RTO, aging, digests, analytics | §9.8 |
| Pickup address missing blocks booking with a visible reason | INV-7, §9.2.4 |
| Test/live courier credentials kept as two separate encrypted blobs | §2.2, RW-20 |
| Bulk booking up to 1,000 orders with per-order success/failure and retry | §9.5.2 |
| Auto-ship on a scheduled sweep with hold window and cutoff | §9.5.3 |
| Rate cards per service, versioned, CSV upload with validation preview | §9.15 |
| Freight + COD reconciliation with tolerances and dispute export | §9.17 |
| Branded track-order page with generate-code snippet | §9.16 |

---

## PART C — Addendum requirements

### C0. Overrides — the only three places this document changes a settled decision

**OVR-1 · Direct login at your own domain.**
`spec.md` §9.1.1 requires every entry to begin in the Shopify admin and states "There is no separate Jsyxi password." That is **overridden**. The app MUST support two entry paths:

1. **Shopify entry** — exactly as §9.1.1 describes, unchanged.
2. **Direct login** at `app.jsyxi.com/login` — email + password with mandatory 2FA (TOTP), or magic link. A Member created this way is a **Jsyxi-native member**, not a Shopify staff user.

Consequences that MUST be handled, not discovered later:
- `member` gains `auth_source` = `SHOPIFY_STAFF` | `NATIVE`, and native members are invited by the Owner by email rather than discovered from Shopify.
- §9.1.2's rule "a staff user removed in Shopify loses access at next entry" applies only to `SHOPIFY_STAFF` members. Native members are revoked in Team & Roles only.
- The Owner MUST remain tied to a Shopify identity (billing and OAuth depend on it). A native member can never become Owner.
- Password reset, lockout after failed attempts, session TTL (12h per RW-04) and full audit of every native login apply.
- INV-1 is unchanged — sessions still bind to `(shop_id, member_id)`.
- This **removes** the §9.1.2 external dependency risk on per-staff identity for non-embedded apps for native members, but that week-0 verification is still required for Shopify-staff members.

**OVR-2 · RTO becomes its own module.** See C3. Adds §9.8b to the spec's module list.

**OVR-3 · Buyer messaging beyond email.** `spec.md` §9.21 assumes one transactional email provider. See C5 — WhatsApp and SMS are added as first-class channels. INV-21 (notifications never gate a business action) still holds for all of them, with one stated exception in ADD-24.

Everything else below is additive. **RV-06 (no merchant parcel split), RV-15 (no customer returns) and INV-23 (no margin, no wallet, no payout) are NOT overridden** unless you separately decide otherwise in Part D.

---

### C1. Shipping rules — additional condition fields

These extend `spec.md` §3.9. Same table, same operator model, same "missing data = no match, shown in trace" behaviour.

| ID | Field | Operators | Notes |
|---|---|---|---|
| **ADD-01** | `DEST_STATE` | `IN_LIST`, `NOT_IN_LIST` | Resolved from the postal zone master, not from the Shopify address string. This is the single most-used routing condition in Indian ops (NE states, J&K, Kerala) and its absence is the biggest gap in §3.9. |
| **ADD-02** | `DEST_CITY` | `IN_LIST`, `NOT_IN_LIST` | Same source. Normalized and case-folded before comparison. |
| **ADD-03** | `ZONE` | `IN_LIST`, `NOT_IN_LIST` | Zone A–E per §4.3. Lets a merchant write "Zone E → only Service X" in one rule instead of a 2,000-pincode list. |
| **ADD-04** | `COD_AMOUNT` | `EQUALS`, `BETWEEN`, `GTE`, `LTE` | **F-15 order COD outstanding**, explicitly distinct from `ORDER_AMOUNT` (F-17). "COD above ₹5,000 → only Blue Dart" is a common risk rule and today is unwritable. |
| **ADD-05** | `ESTIMATED_FREIGHT` | `BETWEEN`, `GTE`, `LTE` | The candidate Service's own F-11 / quote total. **Evaluation-order warning:** this condition is per-candidate, not per-order, so it MUST be evaluated during candidate elimination (§4.5), not during condition matching (§9.4.4). Specify it as an additional elimination filter on the chosen action, and record it in the trace like any other elimination reason. Do not let it force a quote call on every rule evaluation — reuse the §4.5 cache. |
| **ADD-06** | `CHECKOUT_SHIPPING_TITLE` | `IN_LIST`, `NOT_IN_LIST`, `CONTAINS` | The Shopify shipping line title the buyer selected ("Express", "Free Shipping", "Same Day"). Mirrored into `order.checkout_shipping_title` at sync (§8.1 field mapping gains this field). This is how a merchant honours the speed the buyer paid for. |
| **ADD-07** | `CHECKOUT_SHIPPING_AMOUNT` | `EQUALS`, `BETWEEN`, `GTE`, `LTE` | Shop money, from the same shipping line. |
| **ADD-08** | `ITEM_COUNT` | `EQUALS`, `BETWEEN`, `GTE`, `LTE` | Sum of allocated line quantities on the Shipment. |
| **ADD-09** | `PRODUCT` / `VENDOR` / `COLLECTION` | `IN_LIST`, `NOT_IN_LIST` | Same any/none semantics as `SKU` in §3.9. Needed for fragile / oversized / restricted goods routing. |
| **ADD-10** | `VOLUMETRIC_WEIGHT` | `BETWEEN`, `GTE`, `LTE` | Per-Service, so like ADD-05 it is a candidate-level filter, not an order-level condition. Computed by F-1. |
| **ADD-11** | `RISK_FLAG` | `IS_HIGH`, `IS_NOT_HIGH` | Shopify's risk flag, already mirrored per §8.1. |
| **ADD-12** | `WEEKDAY` / `TIME_OF_DAY` | `IN_LIST` / `BETWEEN` | Evaluated in shop-local time (§5.2). Enables "after 4pm → surface courier only". |

**ADD-13 · Condition groups.** §9.4.1 allows only "Conditions (ALL must match)". Add one level of grouping: a Rule holds an ordered list of groups; **within** a group conditions are ANDed, **between** groups they are ORed. One level only — no arbitrary nesting. Without this, "(Zone E) OR (COD above ₹5,000)" needs two duplicate rules and the rule list becomes unmaintainable at scale.

**ADD-14 · New action `MANUAL_ONLY`.** A fourth `RULE_ACTION_TYPE` (§3.8) whose effect is: match, then send the Shipment straight to `BOOKING_STATE = NEEDS_MANUAL_ASSIGNMENT` with `manual_assignment_reason = HELD_BY_RULE` (a new §3.30 value). This is the "never auto-ship these, a human must look" rule — high-value COD, flagged pincodes, fragile SKUs. Today the only way to hold an order is to leave a gap in the rules, which is invisible and error-prone.

**ADD-15 · Service exclusion list per rule.** Alongside the action, a rule may carry `excluded_service_ids[]`. Applied as an elimination filter before the action's own rule in §4.5, with its own trace reason. Cheaper to maintain than enumerating every allowed service in a chain.

**ADD-16 · Rule scheduling.** Optional `active_from` / `active_to` datetimes on a rule, evaluated in shop-local time. A rule outside its window is skipped exactly like an inactive rule and appears in the trace as skipped-by-schedule. Needed for festival surges and courier suspensions.

**ADD-17 · Rule test-fire against real history.** Extend the §9.4.6 simulator: instead of only a hand-made sample order, allow selecting the last N real orders (default 100, test shipments excluded) and show, per order, which rule would match now versus which service was actually used. Read-only, books nothing. This is how a merchant safely changes routing.

---

### C2. Webhook & integration management

**ADD-18 · Webhook management screen** (extends §9.12's one-line "webhook URLs, secrets and health"). Per courier account:
- The generated inbound URL (§8.5) with a copy button, and **per-courier instructions** — where in that courier's own panel this URL is pasted — sourced from the same admin-managed guide content as the setup video (§9.13).
- **Regenerate secret** and **regenerate URL token** as separate, audited actions, each with a confirmation naming the consequence (old URL stops working immediately).
- **Health strip**: last event received, events in last 24h, signature failures in last 24h, current `COURIER_ACCOUNT_HEALTH` (§3.21).
- **Last 20 raw payloads** with parse result — accepted / duplicate / unmapped status / signature failure — masked per INV-18 and §5.7 control 4. This is the single most valuable debugging surface in a shipping product and the spec currently has no view onto it.
- **Replay one payload** — merchant-side, idempotent, audited. (Distinct from admin DLQ replay in §8.6.)
- **Send test event** — the adapter's fake event, proving the URL is live before the first real shipment.

**ADD-19 · Outbound webhooks to the merchant's own systems.** Jsyxi → merchant. Events: `shipment.booked`, `shipment.status_changed`, `ndr.created`, `ndr.resolved`, `rto.initiated`, `rto.delivered`, `cod.remitted`, `invoice.issued`. HMAC-signed, retried per S-48, with a delivery log and the same replay control as ADD-18. Test shipments emit these (they exercise the real path) but MUST carry `is_test: true` in the payload.

**ADD-20 · Merchant REST API + API keys.** Scoped keys (read-orders, book, track, reports), per-key rate limits, key rotation, last-used timestamp, full audit. Read endpoints minimum; booking endpoint optional. Without this, any merchant with an ERP or a second sales channel cannot integrate at all. If this is too much for v1, ship read-only endpoints in v1 and write endpoints in v1.1 — but design the key model now.

---

### C3. RTO as its own module (OVR-2)

Today RTO exists as tracking states, a report, and NDR's "initiate RTO" action. There is no screen where a merchant manages returning parcels, and no record of what happened when the box came back. Add **§9.8b RTO suite**, sibling to the NDR suite:

**ADD-21 · RTO inbox.** All shipments in any `RTO_*` state, with: AWB, order, courier, RTO reason (normalized, reusing the §3.10 reason vocabulary plus `NDR_EXHAUSTED`, `COURIER_INITIATED`, `ADDRESS_UNSERVICEABLE`), RTO-initiated-at, days in RTO, expected return date, whether the parcel carried the Collectible, and the RTO freight charge (F-12). Filters and bulk selection like the NDR inbox.

**ADD-22 · RTO receiving / QC.** A new state machine on the shipment's RTO leg, terminal-safe per INV-17: `RTO_IN_TRANSIT` → `RTO_DELIVERED` (courier says returned) → **`RTO_RECEIVED`** (warehouse confirms physical receipt) → **`RTO_QC_DONE`**. QC captures condition (`GOOD` | `DAMAGED` | `SHORT` | `EMPTY`), an optional photo, and a remark. `RTO_DELIVERED` without a matching `RTO_RECEIVED` after N days (setting, default 7) raises a "courier says returned, warehouse never got it" exception — this is a real and common loss, and today the system cannot see it.

**ADD-23 · Optional restock to Shopify.** On `RTO_QC_DONE` with condition `GOOD`, offer an inventory adjustment write back to Shopify for the returned quantities. Opt-in setting, off by default, idempotent through the existing `sync_outbox` (§8.4), never automatic, and **never for test shipments** (INV-19).

**ADD-24 · RTO analytics + repeat-offender flag.** Extends §9.8.3: RTO rate by service, state, pincode, SKU and reason, plus a buyer-level counter keyed on normalized phone — "this phone has 4 prior RTOs" — surfaced on the order before booking. Store the counter against a **salted hash** of the phone, never the raw value in any log (§5.7 control 4). Retention follows §5.4 and redaction per §5.5 clears it.

---

### C4. Customer communication (OVR-3) — the largest genuine gap

`spec.md` §9.21 sends email only, and only to merchant staff. Indian D2C shipping runs on WhatsApp. Nothing below changes INV-21: no booking, transition or job outcome ever depends on a message being delivered, with the single stated exception in ADD-27.

**ADD-25 · Channel abstraction.** A `message_channel` layer over EMAIL, SMS and WHATSAPP, with per-Shop provider credentials, per-event channel selection, and a delivery log (queued / sent / delivered / read / failed) per message. Same throttle and toggle model as S-45/S-46.

**ADD-26 · Buyer notifications.** Templated buyer-facing messages on: shipped (with AWB + track link), out for delivery, delivery attempted / NDR, delivered, RTO initiated. Per-event on/off, per-channel. Uses the **per-shipment track token** (§9.16) so the link opens that parcel directly.

> **India compliance, and it has lead time — put it in week 0 alongside the Protected Customer Data request:** SMS to Indian numbers requires **DLT registration** (entity + sender ID + every template pre-approved on the operator DLT portal). WhatsApp requires a **Meta-approved BSP account and pre-approved message templates**. Template approval is measured in days-to-weeks and cannot be compressed. Build the template model so every template stores its external approval ID and no message can send on an unapproved template.

**ADD-27 · NDR buyer self-serve.** The NDR message carries a tokenized link where the buyer can: confirm the address, correct the address, choose a reattempt date, or convert COD to prepaid via a payment link. The response creates the corresponding `NDR_ACTION` automatically (§3.10). This resolves NDRs without a phone call and is the highest-leverage feature in this entire addendum for a COD-heavy merchant.
*Stated exception to INV-21:* a buyer response **does** drive a business action here — but the action is created from a stored, audited buyer response record, not from message delivery success, so the invariant's intent holds. Make that distinction explicit in code.

**ADD-28 · COD order confirmation before booking.** Optional per-Shop flow: on a new COD order, message the buyer to confirm. Configurable window; on no response, either book anyway (default) or hold in `NEEDS_MANUAL_ASSIGNMENT` with reason `COD_UNCONFIRMED`. Directly attacks the RTO rate. Must respect the auto-ship hold window (S-11) rather than fighting it.

---

### C5. Configuration health & the admin view you asked for

**ADD-29 · Setup-health object.** A computed, stored per-Shop health record covering: pickup address present and complete · GSTIN present and valid · at least one courier account connected and `HEALTHY` · at least one enabled service · at least one rate card for each enabled `RATE_CARD` service · default chain S-22 set · webhook configured and receiving events · label template selected · package profile default present (INV-24) · plan active. Each item carries state (OK / MISSING / BROKEN), a deep link to the screen that fixes it, and a first-detected timestamp.

**ADD-30 · Merchant-side onboarding checklist.** The same object rendered as a persistent checklist on the dashboard until complete. Answers "why can't I ship?" before the merchant raises a ticket.

**ADD-31 · Admin-side merchant health board** — this is the specific thing you asked for. `admin.jsyxi.com` gains a merchant list column and a detail panel showing the ADD-29 object per merchant, sortable by "most broken", so support sees "pickup address missing" or "no rate card uploaded" **before** the merchant complains. Read-only, no PII, consistent with §10.3.

**ADD-32 · Booking failure monitor (admin).** §9.13 has a courier **API** error monitor. Extend it to a booking failure monitor covering config failures too, grouped by reason code across all merchants, so a spike in one reason on one courier is visible platform-wide within minutes.

**ADD-33 · Per-section help videos.** §9.13's guides manager is per-courier only. Extend it to per-screen: an admin can attach a video and a short doc to any named surface (rules, rate cards, reconciliation, NDR, labels, webhooks), shown as a help icon on that screen and updatable without a release.

---

### C6. Operational tools that are missing

**ADD-34 · Serviceability + rate checker.** A standalone screen: origin (fixed), destination pincode, weight, dimensions, payment mode, COD amount → every enabled service side by side with serviceable yes/no, price breakdown, and EDD. Reuses `getQuote` and the §4.5 cache. Merchants ask this question daily; today they must create an order to answer it.

**ADD-35 · Scan to pack / scan to print.** Mobile-friendly view: scan the order barcode or AWB → confirm contents → print label → mark packed. Reduces mis-ships and is the one screen warehouse staff actually use. Ties to the existing `PICKUP_SCHEDULED` flow; adds no new state.

**ADD-36 · Bulk actions parity.** The spec has bulk book and bulk label. Add bulk cancel (pre-pickup), bulk pickup schedule, bulk label reprint, bulk NDR action (§9.8.1 implies it — make it explicit), and bulk export of selection. Each as an async job per §3.27 with the same partial-result reporting as §9.5.2.

**ADD-37 · Saved views.** Per-member named filter sets on the order, shipment, NDR and RTO lists, including the test/live filter (§9.23). Pure UI state, no new invariants.

**ADD-38 · Internal notes and tags.** Free-text note (≤2,000 chars per RW-13) and merchant-defined tags on an Order and on a Shipment, visible in lists, filterable, and audited. Distinct from Shopify tags. Every ops team needs "customer called, deliver after 6pm."

**ADD-39 · Manual / CSV order creation.** Orders not originating in Shopify — phone orders, Instagram, marketplace overflow. Creates an Order with `source = MANUAL` that flows through the identical rule, booking, tracking, NDR and reconciliation path, with **no Shopify sync-back** (nothing to sync back to) and no GST invoice unless the required fields are supplied. Decide in Part D whether this is v1 — it is a meaningful scope increase, but a merchant with a second channel will otherwise keep a parallel spreadsheet.

**ADD-40 · Address quality helpers.** PIN → city + state auto-fill from the postal master on any address edit; a completeness score flagging missing landmark / short address / suspicious phone before booking; and normalization stored alongside the raw value (never replacing it, per INV-16's spirit).

---

### C7. Money & documents — smaller gaps

- **ADD-41 · Insurance / declared-value surcharge.** A per-shipment insurance opt-in and a matching `rate_card_component` basis, so an insured shipment's expected cost is right and reconciliation doesn't flag it. Today declared value is sent in the quote (§8.3) but no charge component corresponds to it.
- **ADD-42 · Weight-dispute evidence.** Attach the courier's reweigh image/scan to a `recon_freight_row` when disputing (§9.17.2). Couriers demand evidence with claims; without an attachment the dispute export is weaker than it needs to be.
- **ADD-43 · Courier escalation from a shipment.** One click from a stuck shipment to raise an escalation carrying AWB, timeline and last event — logged against the shipment with a follow-up date. Distinct from the internal support ticket in §9.18, which goes to Jsyxi, not to the courier.
- **ADD-44 · Credit note / partial refund awareness on COD.** When Shopify refunds part of a COD order after booking but before delivery, F-15 changes while the Collectible is already frozen in the snapshot. The spec's INV-9 covers conservation but not this drift. Specify: detect it, surface it as an exception on the order, never silently rewrite a booked Collectible.

---

## PART D — Five decisions only you can make

Answer these before Claude Code starts, because each one changes the data model rather than just adding a screen.

1. **Direct login (OVR-1) — yes or no?** If yes, the member model, invite flow and session model change in week 1–2, not later. My read: yes, since you were explicit about your own domain — but note the Owner must still be a Shopify identity for billing.
2. **Customer-initiated returns — v1 or not?** `spec.md` RV-15 bans them and warns implementers will assume they exist. RTO (C3) is *not* returns. If you want returns, it needs an adapter method, a data model, a permission row and a refund path — I'd put it at v1.1 and ship RTO properly first.
3. **WhatsApp/SMS (C4) — v1 or not?** Highest business value in this document, but DLT and BSP approval have external lead time. If yes, start the registrations in week 0 even if you build the feature in week 13.
4. **Manual/CSV orders (ADD-39) — v1 or not?** Touches order sync, GST invoicing and reporting. Cheap if designed in week 3, expensive if bolted on in week 15.
5. **Merchant API (ADD-20) — read-only in v1, or defer entirely?** Design the key model either way.

Also confirm you are **not** changing: INV-23 (no margin, no wallet, no payout), RV-06 (no merchant parcel split), INV-4 (one shipment = one parcel). These three shape the whole system, and a late reversal on any of them is a rewrite, not a change request.

**Approved planning assumptions (phase 1):** D-1 yes (OVR-1 built in weeks 1–2) · D-2 returns NOT in v1 · D-3 WhatsApp/SMS registrations in week 0, code in the notifications block · D-4 design-only (the `order.source` column is added in week 3–4, no manual-creation UI in phase 1) · D-5 key model designed now, read-only endpoints in v1.

---

## PART E — Additions to the §14 week-0 verification list

`spec.md` §14 already schedules three Shopify verifications and the Protected Customer Data Level 2 request. Add:

- **DLT entity + sender ID + template registration** (if ADD-25/26 are in scope) — external approval, days to weeks.
- **WhatsApp BSP account + template approval** (same).
- **Payment link provider** for ADD-27's COD→prepaid conversion, if that is in scope.
- **Confirm each launch courier's webhook capability** — some Indian couriers offer no push webhooks at all, only polling. §8.5 assumes both exist; find out per courier in week 0, because it changes the tracking freshness you can promise.
