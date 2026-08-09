/**
 * §9.10 Dashboard + §5.7/§2.8 rollups — shared types and the exact F-16
 * derivations (§4.10). Every figure the dashboard shows is read back from
 * `rollup_hourly_stats`; this file is the single authority on what the
 * dimension sets and metric shapes are, so the writer (rollup.service.ts)
 * and the reader (dashboard.service.ts) can never drift apart.
 *
 * dimension_json always carries:
 *   kind  — the dimension-set discriminator (below)
 *   test  — INV-19/§9.23: false = live figures (the default everywhere),
 *           true  = the test-side mirror, stored separately so live figures
 *           never mix test shipments in and the §9.23 test filter can still
 *           show the test side explicitly.
 * jsonb normalizes key order, so the (shop_id, hour_start_utc,
 * dimension_json) unique key (migration 0014) is stable regardless of JS
 * object key order.
 */

export type DimensionKind =
  /** A §9.10 action card count — every card's condition is a stored column (RV-03). */
  | 'card'
  /** Snapshot: non-test shipment counts by §3.4 MOVEMENT_STATE. */
  | 'by_movement'
  /** Snapshot: shipment counts by §3.2 BOOKING_STATE. */
  | 'by_booking'
  /** Snapshot: booked-shipment volumes by §3.5 PAYMENT_MODE (COD vs Prepaid). */
  | 'by_payment'
  /** Snapshot: booked-shipment counts by Service. */
  | 'by_service'
  /** Snapshot: Service × movement-state counts — the §9.10 matrix. */
  | 'service_movement'
  /** F-16.a/c booked cohort, attributed to the booked hour (§5.2). Restated. */
  | 'f16_cohort'
  /** F-16.b numerator: shipments with ≥1 NDR, attributed to first-NDR hour (§5.2). */
  | 'f16_ndr'
  /** F-16.b denominator: picked-up shipments, attributed to first PICKED_UP hour. */
  | 'f16_pickup'
  /** F-16.d TAT + delivered counts, attributed to DELIVERED occurred-at hour (§5.2). */
  | 'f16_delivery';

/** The §9.10 action cards, each reading one stored condition (RV-03). */
export type DashboardCardKey =
  /** Orders READY with DRAFT shipments (§3.1/§3.2 stored states). */
  | 'new_to_book'
  /** ndr_case.state ≠ CLOSED (§3.10). */
  | 'ndr_open'
  /** custody_state = PICKUP_PENDING (§3.3). */
  | 'pickup_pending'
  /** S-47: EDD exceeded by >24h (RW-06), via the tracking module. */
  | 'delayed'
  /** booking_state = NEEDS_MANUAL_ASSIGNMENT (§3.2, RV-03). */
  | 'manual_assignment'
  /** courier_account.health_state = DISCONNECTED (§3.21). */
  | 'courier_disconnected'
  /** §3.14 open-dispute counting rule + §3.28 control-total MISMATCH batches. */
  | 'recon_disputes_open'
  /** order.cod_assignment_state = UNASSIGNED (§3.24). */
  | 'cod_unassigned'
  /** gst_invoice.state = ISSUE_PENDING (§3.12). */
  | 'invoice_issue_pending';

export const DASHBOARD_CARD_KEYS: readonly DashboardCardKey[] = [
  'new_to_book',
  'ndr_open',
  'pickup_pending',
  'delayed',
  'manual_assignment',
  'courier_disconnected',
  'recon_disputes_open',
  'cod_unassigned',
  'invoice_issue_pending',
];

export type RollupDimension =
  | { kind: 'card'; card: DashboardCardKey; test: boolean }
  | { kind: 'by_movement'; state: string; test: boolean }
  | { kind: 'by_booking'; state: string; test: boolean }
  | { kind: 'by_payment'; mode: string; test: boolean }
  | { kind: 'by_service'; serviceId: string | null; test: boolean }
  | { kind: 'service_movement'; serviceId: string | null; state: string; test: boolean }
  | { kind: 'f16_cohort'; serviceId: string | null; test: boolean }
  | { kind: 'f16_ndr'; serviceId: string | null; test: boolean }
  | { kind: 'f16_pickup'; serviceId: string | null; test: boolean }
  | { kind: 'f16_delivery'; serviceId: string | null; test: boolean };

/** metrics_json for kind='card' and the by_* snapshot sets. */
export interface CountMetrics {
  count: number;
}

/** metrics_json for kind='f16_cohort' — one booked cohort hour. */
export interface CohortMetrics {
  booked: number;
  delivered: number;
  rto_delivered: number;
  lost_or_damaged: number;
  cancelled_by_courier: number;
  /** Cancelled pre-pickup (§3.2 VOID) — never shipped, not "open". */
  void: number;
  /** Booked, not VOID, and not in any terminal §3.4 state. */
  open: number;
}

export interface NdrMetrics {
  shipments_with_ndr: number;
}

export interface PickupMetrics {
  picked_up: number;
}

export interface DeliveryMetrics {
  delivered: number;
  /** Deliveries with a known first PICKED_UP occurred-at (TAT denominator). */
  tat_count: number;
  /** Sum of calendar hours PICKED_UP → DELIVERED occurred-at (F-16.d). */
  tat_hours_sum: number;
}

export type RollupMetrics =
  | CountMetrics
  | CohortMetrics
  | NdrMetrics
  | PickupMetrics
  | DeliveryMetrics;

/** One row to UPSERT into rollup_hourly_stats. */
export interface RollupRow {
  hourStartUtc: Date;
  dimension: RollupDimension;
  metrics: RollupMetrics;
}

/* ------------------------------------------------------------------ */
/* F-16 derivations (§4.10) — pure, exact, unit-tested. Rates are     */
/* null when the denominator is zero (nothing to rate, never a fake 0).*/
/* ------------------------------------------------------------------ */

/** F-16.a = Delivered ÷ (Delivered + RTO Delivered) over a booked cohort.
 *  Open shipments appear in NEITHER term — they are not a parameter here. */
export function deliveryRate(delivered: number, rtoDelivered: number): number | null {
  const denom = delivered + rtoDelivered;
  return denom === 0 ? null : delivered / denom;
}

/** F-16.b = Shipments with ≥1 NDR ÷ Picked-up shipments. */
export function ndrRate(shipmentsWithNdr: number, pickedUp: number): number | null {
  return pickedUp === 0 ? null : shipmentsWithNdr / pickedUp;
}

/** F-16.c = RTO Delivered ÷ Terminal shipments (all terminal §3.4 states). */
export function rtoRate(rtoDelivered: number, terminal: number): number | null {
  return terminal === 0 ? null : rtoDelivered / terminal;
}

/** F-16.d = mean calendar hours from PICKED_UP to DELIVERED occurred-at. */
export function avgTatHours(tatHoursSum: number, tatCount: number): number | null {
  return tatCount === 0 ? null : tatHoursSum / tatCount;
}

/** §5.2: dashboards may lag ≤75 minutes and MUST display an as-of time. */
export const DASHBOARD_FRESHNESS_MS = 75 * 60_000;

/** Test/live view selector (§9.23): default is the live side. */
export type TestView = 'live' | 'test';

export interface ServicePerformanceRow {
  serviceId: string | null;
  booked: number;
  open: number;
  delivered: number;
  rtoDelivered: number;
  terminal: number;
  pickedUp: number;
  shipmentsWithNdr: number;
  /** F-16.a — null when the cohort has no terminal delivery outcome yet. */
  deliveryRate: number | null;
  /** F-16.b. */
  ndrRate: number | null;
  /** F-16.c. */
  rtoRate: number | null;
  /** F-16.d average TAT in calendar hours. */
  avgTatHours: number | null;
}
