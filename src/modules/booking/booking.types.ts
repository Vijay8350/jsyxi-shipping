import type { payment_mode } from '../courier-framework/adapter.enum-types';
import type { QuoteComponent, RtoRule } from '../courier-framework/adapter.types';
import type { EligibilityCheck } from '../order-derivation/eligibility';
import type { DeadWeightLineResult } from '../order-derivation/weight';

/**
 * Booking core types (§3.2 machine B, §3.3 machine C, §2.9 snapshot).
 * PG enum mirrors kept as string unions, matching the courier-framework and
 * order-derivation convention.
 */

export type BookingState =
  | 'DRAFT'
  | 'NEEDS_MANUAL_ASSIGNMENT'
  | 'QUEUED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FAILED'
  | 'OUTCOME_UNKNOWN'
  | 'VOID';

export type CustodyState =
  | 'NOT_APPLICABLE'
  | 'PICKUP_PENDING'
  | 'PICKUP_SCHEDULED'
  | 'IN_CUSTODY'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'CANCEL_REJECTED';

/** §3.23. */
export type BookingIntentOutcome =
  | 'IN_FLIGHT'
  | 'CONFIRMED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'RESOLVED_CONFIRMED'
  | 'RESOLVED_FAILED';

/** §3.25. */
export type ExpectedCostBasis = 'SNAPSHOT_QUOTE' | 'PROVIDER_CONFIRMED_CHARGE' | 'NONE';

export type CostSource = 'RATE_CARD' | 'LIVE_QUOTE' | 'NONE';

export type CourierAccountMode = 'TEST' | 'LIVE';

/* ---------------------------------------------------------------------------
 * §2.9 booking snapshot — the full content list, frozen at DRAFT → QUEUED.
 * ------------------------------------------------------------------------- */

export interface SnapshotRecipient {
  name: string | null;
  addressLines: string[];
  city: string | null;
  state: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
}

/** §2.9: "allocation line IDs and quantities with SKU, title, variant, tags,
 *  unit price and HSN". */
export interface SnapshotLine {
  orderLineId: string;
  shopifyLineGid: string | null;
  sku: string | null;
  title: string | null;
  variant: string | null;
  quantity: number;
  unitPrice: string | null;
  tags: string[];
  hsnCode: string | null;
}

export interface SnapshotPickupLocation {
  pickupLocationId: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  addressLines: string[];
  city: string | null;
  state: string | null;
  pincode: string | null;
  gstin: string | null;
}

export interface SnapshotPackageProfile {
  packageProfileId: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  tareKg: string;
  /** F-20 source; 'MEMBER_OVERRIDE' when the §9.5.1 ship-modal override chose it. */
  source: string;
}

export interface SnapshotWeights {
  /** F-24, 3dp kg — WITH its per-line derivation (§2.9). */
  deadWeightKg: string;
  lineWeightTotalKg: string;
  usedDefaultParcelWeight: boolean;
  tareKg: string;
  perLine: DeadWeightLineResult[];
  /** F-1 / F-2 / F-3 (§4.2); null when the service version has no divisor
   *  (§4.1 zero/null guard). */
  volumetricWeightKg: string | null;
  rawChargeableKg: string | null;
  billableWeightKg: string | null;
}

export interface SnapshotService {
  serviceId: string;
  serviceVersionId: string | null;
  code: string;
  name: string;
  costSource: CostSource;
  volumetricDivisor: string | null;
  minBillableKg: string | null;
  billableIncrementKg: string | null;
}

/** §4.5 / §8.3 — the full itemized expected quote. */
export interface SnapshotQuote {
  costSource: CostSource;
  components: QuoteComponent[];
  total: string;
  currency: 'INR';
  rtoRule: RtoRule | null;
  eddFrom: string | null;
  eddTo: string | null;
  eddSource: 'PROVIDER' | 'RATE_CARD_SLA' | null;
  providerQuoteRef: string | null;
  fetchedAt: string;
}

/** Every formula input from §4 the quote/weights were computed with (§2.9). */
export interface SnapshotFormulaInputs {
  shipDate: string;
  /** INV-4: fixed 1 at v1. */
  pieces: 1;
  originPincode: string;
  destinationPincode: string;
  deadWeightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  paymentMode: payment_mode;
  collectible: string;
  declaredValue: string;
  /** F-4 lane zone (null for LIVE_QUOTE / unmatched). */
  zone: string | null;
  billableWeightKg: string | null;
}

export interface BookingSnapshot {
  schemaVersion: 1;
  /** The freezing instant — the DRAFT → QUEUED transition (§2.9, RV-05). */
  frozenAt: string;
  recipient: SnapshotRecipient | null;
  lines: SnapshotLine[];
  pickupLocation: SnapshotPickupLocation | null;
  packageProfile: SnapshotPackageProfile | null;
  payment: { mode: payment_mode; collectible: string; currency: 'INR' };
  weights: SnapshotWeights;
  service: SnapshotService;
  courierAccount: { courierAccountId: string; mode: CourierAccountMode };
  /** Null for LIVE_QUOTE (§2.9). */
  rateCardVersionId: string | null;
  zoneMapId: string | null;
  zone: string | null;
  formulaInputs: SnapshotFormulaInputs;
  /** Null when unpriceable (§4.1 guard) or COST_SOURCE = NONE. */
  expectedQuote: SnapshotQuote | null;
  shopify: {
    orderGid: string | null;
    lineGids: string[];
    fulfillmentOrderGids: string[];
  };
  /** Rules land in weeks 9–11; null until then (§2.9). */
  rule: { ruleId: string; ruleVersion: number } | null;
}

/* ---------------------------------------------------------------------------
 * queueBooking (§3.2 DRAFT → QUEUED) — structured results, never silent.
 * ------------------------------------------------------------------------- */

export interface QueueBookingInput {
  shopId: string;
  shipmentId: string;
  /** The acting member; null for the (later) auto-ship system actor. */
  actorId: string | null;
  /** §9.5.1 manual override: an explicit Service selection. */
  serviceId?: string;
  /** §9.5.1 manual override: an explicit package profile. */
  packageProfileId?: string;
  /** INV-22: the shipment.version the actor read; mismatch rejects. */
  expectedVersion?: number;
}

export type QueueBookingFailureCode =
  | 'SHIPMENT_NOT_FOUND'
  | 'INVALID_STATE'
  | 'VERSION_CONFLICT'
  | 'ACCOUNT_STATE_BLOCKED'
  | 'NO_BOOKABLE_SERVICE'
  | 'INV_7_BLOCKS'
  | 'ENTITLEMENT_INSUFFICIENT';

export type QueueBookingResult =
  | {
      queued: true;
      bookingIntentId: string;
      merchantReference: string;
      attemptNumber: number;
      expectedCostBasis: ExpectedCostBasis | null;
      collectible: string;
    }
  | {
      queued: false;
      code: QueueBookingFailureCode;
      /** Present for INVALID_STATE / VERSION_CONFLICT — the current row state
       *  for the actor to refresh and reapply (INV-22). */
      currentState?: BookingState;
      currentVersion?: number;
      /** §3.30 — from rule routing (incl. ADD-14 HELD_BY_RULE) or the RW-22
       *  no-rule-no-chain path. */
      manualAssignmentReason?:
        | 'HELD_BY_RULE'
        | 'CHAIN_EXHAUSTED'
        | 'NO_SERVICEABLE_CANDIDATE'
        | 'NO_RULE_AND_NO_DEFAULT_CHAIN'
        | 'PAYMENT_MODE_UNRESOLVED';
      /** INV-7 failing checks + the two wired courier checks. */
      failures?: EligibilityCheck[];
      /** §8.3 structured codes from the provider / rate engine. */
      serviceFailureReasons?: string[];
      /** §9.5.6 — set when the block needs an overage approval or upgrade. */
      approvalNeeded?: boolean;
      allowance?: number;
      consumed?: number;
    };

/* ---------------------------------------------------------------------------
 * Worker (§3.2 QUEUED → SUBMITTED → …) and cancellation (§3.3).
 * ------------------------------------------------------------------------- */

/** §5.7: the `booking` queue job payload; the job NAME carries the Service. */
export interface BookingJobData {
  shopId: string;
  shipmentId: string;
  bookingIntentId: string;
  merchantReference: string;
  serviceId: string;
  courierAccountId: string;
}

export type CancelResult =
  | { cancelled: true }
  | {
      cancelled: false;
      code:
        | 'SHIPMENT_NOT_FOUND'
        | 'INVALID_BOOKING_STATE'
        | 'INVALID_CUSTODY_STATE'
        | 'CANCEL_REJECTED'
        | 'CANCEL_OUTCOME_UNKNOWN'
        | 'CANCEL_PICKUP_RACE';
      currentState?: BookingState;
      currentCustody?: CustodyState;
      /** §3.3: the race — flagged for review, NO entitlement reversal. */
      flaggedForReview?: boolean;
      reason?: string | null;
    };

export type ResolveOutcome =
  | { resolved: true; outcome: 'RESOLVED_CONFIRMED' | 'RESOLVED_FAILED'; awbNormalized?: string }
  | { resolved: false; code: 'SHIPMENT_NOT_FOUND' | 'INVALID_STATE'; currentState?: BookingState };
