import type { payment_mode } from '../courier-framework/adapter.enum-types';
import type { QueueBookingFailureCode } from '../booking/booking.types';

/**
 * booking-ops types: §9.5.2 bulk booking, §9.5.3 auto-ship, §9.5.5 pickup
 * scheduling + manifests. PG enum mirrors kept as string unions, matching the
 * booking module convention.
 */

/** §3.27 JOB_STATE. */
export type JobState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';

/** §9.5.2: up to 1,000 Orders per bulk job (§5.1). */
export const BULK_BOOKING_MAX_ORDERS = 1000;

/** S-21 (§7.3): per-Shop concurrency quota — 2 concurrent bulk jobs. */
export const MAX_CONCURRENT_BULK_JOBS_PER_SHOP = 2;

/** §5.7: the bulk-booking queue name (separate from the `booking` queue). */
export const BOOKING_BULK_QUEUE = 'booking-bulk';

/**
 * §9.4.5 (A1-10): the enqueue-time version snapshot. Rules land later (§9.4),
 * so the `rules` slot is reserved as null; Services and rate-card versions
 * are captured today. `retryOf` links a retry batch to its source (the
 * retry-failed flow creates a NEW batch — see bulk-booking.service.ts).
 */
export interface BatchVersionSnapshot {
  capturedAt: string;
  rules: null;
  services: Array<{ serviceId: string; serviceVersionId: string | null }>;
  rateCardVersions: Array<{ rateCardId: string; rateCardVersionId: string }>;
  retryOf?: string;
}

/**
 * §9.5.2 per-Order result — ✓ queued-with-intent (the booking worker settles
 * the AWB asynchronously), or ✗ with the exact structured reason. A
 * NEEDS_MANUAL_ASSIGNMENT outcome is REPORTED with its §3.30 reason, never
 * silently skipped (INV-20).
 */
export interface BatchOrderResult {
  orderId: string;
  shipmentId: string | null;
  status: 'QUEUED' | 'FAILED';
  bookingIntentId?: string;
  merchantReference?: string;
  /** QueueBookingFailureCode, or 'ORDER_NOT_FOUND' / 'NO_BOOKABLE_SHIPMENT'. */
  code?: QueueBookingFailureCode | 'ORDER_NOT_FOUND' | 'NO_BOOKABLE_SHIPMENT';
  failures?: string[];
  manualAssignmentReason?: string;
  approvalNeeded?: boolean;
  /** The shipment's current booking_state, for the actor to refresh (INV-22). */
  currentState?: string;
}

export interface BookingBatchRow {
  batch_id: string;
  shop_id: string;
  requested_by: string | null;
  state: JobState;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  results: BatchOrderResult[];
  version_snapshot: BatchVersionSnapshot | null;
  version: number;
  created_at: string;
  updated_at: string;
}

/** §5.7 `booking-bulk` queue job payload. jobId = batch_id (exactly-once). */
export interface BulkBookingJobData {
  shopId: string;
  batchId: string;
  orderIds: string[];
  requestedBy: string | null;
}

/* ---------------------------------------------------------------------------
 * §9.5.3 auto-ship.
 * ------------------------------------------------------------------------- */

/** §9.5.3 / A3-03: the default sweep cadence — every 5 minutes. */
export const AUTO_SHIP_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** §5.7-style queue name for the auto-ship sweep. */
export const AUTO_SHIP_QUEUE = 'auto-ship';

/** The repeatable sweep job name — scheduled, NEVER webhook-triggered (§9.5.3). */
export const AUTO_SHIP_SWEEP_JOB = 'auto-ship:sweep';

/** Why an order stayed in the normal queue (§9.5.3 — the reason is visible). */
export type AutoShipSkipReason =
  | 'ACCOUNT_STATE_BLOCKED' // §3.11 — never while RESTRICTED
  | 'AFTER_CUTOFF' // S-12, shop-local (§5.2)
  | 'PAYMENT_MODE_UNRESOLVED' // neither paid (prepaid) nor confirmed COD
  | 'SHOPIFY_RISK_FLAG' // §8.1 risk flag present
  | 'ACTIVE_AWB' // never rebook an active AWB (§9.5.3)
  | 'WITHIN_HOLD_WINDOW' // S-11 (A3-03)
  | 'NO_ROUTE' // S-22 unset / no serviceable default-chain candidate
  | 'SWEEP_CAP_REACHED' // S-13 — waits for the next sweep
  | 'BOOKING_BLOCKED'; // queueBooking's structured failure code (see `detail`)

export interface AutoShipOrderOutcome {
  orderId: string;
  shipmentId: string;
  booked: boolean;
  bookingIntentId?: string;
  reason?: AutoShipSkipReason;
  detail?: string;
}

export interface AutoShipSweepSummary {
  shopId: string;
  sweptAt: string;
  booked: number;
  skipped: number;
  outcomes: AutoShipOrderOutcome[];
}

/* ---------------------------------------------------------------------------
 * §9.5.5 pickup scheduling + manifest (A4-02).
 * ------------------------------------------------------------------------- */

/** §5.4 retention: manifests live 90 days. */
export const MANIFEST_RETENTION_DAYS = 90;

/** S-26 (§7.4): signed-URL lifetime — 10 minutes, fixed. */
export const SIGNED_URL_TTL_SECONDS = 600;

export interface PickupScheduleGroupResult {
  serviceId: string;
  manifestNumber: string;
  documentId: string;
  /** App-relative signed URL (S-26); expires per SIGNED_URL_TTL_SECONDS. */
  downloadUrl: string;
  awbs: string[];
  scheduledShipmentIds: string[];
}

export interface PickupScheduleSkipped {
  shipmentId: string;
  reason: 'SHIPMENT_NOT_FOUND' | 'NOT_PICKUP_PENDING' | 'SCHEDULE_FAILED';
  bookingState?: string;
  custodyState?: string;
  detail?: string;
}

export interface PickupScheduleResult {
  groups: PickupScheduleGroupResult[];
  skipped: PickupScheduleSkipped[];
}

/** One manifest content line (§9.5.5): AWB, order, weight, payment, collectible. */
export interface ManifestLine {
  awb: string;
  orderNumber: string;
  weightKg: string;
  paymentMode: payment_mode;
  collectible: string;
}
