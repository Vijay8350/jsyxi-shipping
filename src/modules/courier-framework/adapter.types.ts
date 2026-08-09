/**
 * The courier adapter interface (§8.2) and the canonical quote contract
 * (§8.3). Every Courier — direct or aggregator — implements this interface;
 * the deterministic fake adapter (§15.1) and the rate-card engine's
 * synthesized quote (§4.5) speak the same shapes.
 *
 * Boundaries:
 * - Money is 2dp NUMERIC text (paise at the boundary, INV-15); weights are
 *   3dp kg NUMERIC text; dimensions 2dp cm. No floats cross this interface.
 * - No field of the quote contract may be marked up before it is shown,
 *   compared or stored (INV-23).
 * - A capability a Courier lacks is declared `supported = false` in
 *   courier_capability and the adapter throws UnsupportedCapabilityError —
 *   a silent no-op is never permitted (A1-03).
 * - There is NO reverse-pickup or customer-return method (RV-15).
 */

import type { payment_mode } from './adapter.enum-types';

/** §8.2 method names, reused as the courier_capability.capability values. */
export const ADAPTER_METHODS = [
  'getQuote',
  'createShipment',
  'lookupByReference',
  'cancelShipment',
  'track',
  'getLabel',
  'schedulePickup',
  'ndrAction',
] as const;
export type AdapterMethod = (typeof ADAPTER_METHODS)[number];

export class UnsupportedCapabilityError extends Error {
  constructor(
    public readonly courierCode: string,
    public readonly method: AdapterMethod,
    public readonly manualFallbackNote: string | null,
  ) {
    super(`${courierCode} does not support ${method}`);
    this.name = 'UnsupportedCapabilityError';
  }
}

/** §8.3 request — every field required unless marked optional. */
export interface QuoteRequest {
  courierAccountId: string;
  serviceId: string;
  originPincode: string;
  destinationPincode: string;
  /** ISO date. */
  shipDate: string;
  /** INV-4: fixed 1 at v1. */
  pieces: 1;
  /** F-24, 3dp kg text. */
  deadWeightKg: string;
  /** 2dp cm text, from the F-20 package profile. */
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  paymentMode: payment_mode;
  /** 2dp text; '0.00' for prepaid. */
  collectible: string;
  /** 2dp text; the insurance basis for ADD-41. */
  declaredValue: string;
  pickupLocationId: string;
}

/** §8.3 response component. */
export interface QuoteComponent {
  code: string;
  label: string;
  /** 2dp text, already rounded half-up (INV-15). */
  amount: string;
  taxable: boolean;
}

export interface RtoRule {
  basis: 'SAME_AS_FORWARD' | 'PERCENT_OF_FORWARD';
  pct: string | null;
}

/** §8.3 response. `RATE_CARD` Services synthesize this same shape from
 *  F-5…F-11 (§4.5), so both cost sources compare directly. */
export interface QuoteResponse {
  serviceable: boolean;
  /** Structured codes, not free text; required when serviceable = false. */
  failureReasons: string[];
  rateAvailable: boolean;
  components: QuoteComponent[];
  /** Sum of the stored rounded components (INV-15), 2dp text. */
  total: string;
  currency: 'INR';
  /** Aggregator return-charge term consumed by F-12; null = no RTO
   *  expectation (§4.4). */
  rtoRule: RtoRule | null;
  /** ISO dates; nullable. */
  eddFrom: string | null;
  eddTo: string | null;
  eddSource: 'PROVIDER' | 'RATE_CARD_SLA' | null;
  fetchedAt: string;
  providerQuoteRef: string | null;
  capabilityFlags: string[];
}

/** A1-04: one immutable booking intent per booking ATTEMPT, reused across
 *  every transport retry of that attempt. */
export interface BookingIntent {
  bookingIntentId: string;
  requestDigest: string;
  /** §13.5: {shop_short_id}-{shipment_id}; stable across retries. */
  merchantReference: string;
}

export interface CreateShipmentRequest {
  intent: BookingIntent;
  /** The booked Jsyxi Service — aggregators map this to their nested
   *  courier identity (§9.3.4, §15.1 nested service identities). */
  serviceId: string;
  /** §8.3 quote-request parcel fields, from the frozen snapshot (INV-8). */
  originPincode: string;
  destinationPincode: string;
  deadWeightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  paymentMode: payment_mode;
  collectible: string;
  declaredValue: string;
  /** RV-13 protected fields, passed to the provider at booking only. */
  recipient: {
    name: string;
    addressLines: string[];
    city: string;
    state: string;
    pincode: string;
    phone: string;
    email: string | null;
  };
  pickupLocationId: string;
}

export interface CreateShipmentResult {
  kind: 'CONFIRMED' | 'FAILED' | 'OUTCOME_UNKNOWN';
  awb: string | null;
  /** Becomes EXPECTED_COST_BASIS = PROVIDER_CONFIRMED_CHARGE when no quote
   *  was frozen (§3.25). */
  confirmedCharge: string | null;
  /** Structured failure codes when kind = FAILED. */
  failureReasons: string[];
}

export interface LookupByReferenceResult {
  found: boolean;
  awb: string | null;
}

export interface CancelShipmentResult {
  kind: 'CANCELLED' | 'REJECTED' | 'OUTCOME_UNKNOWN';
  reason: string | null;
}

export interface TrackEvent {
  /** The courier's raw status text; normalization happens against
   *  courier_status_map (§3.6), not in the adapter. */
  rawStatus: string;
  occurredAt: string;
  locationText: string | null;
  reasonText: string | null;
  providerEventId: string | null;
}

export interface LabelResult {
  contentType: 'application/pdf';
  bytes: Buffer;
}

export interface PickupRequest {
  awbs: string[];
  pickupLocationId: string;
  /** ISO date. */
  pickupDate: string;
}

export interface PickupResult {
  acknowledged: boolean;
  providerPickupId: string | null;
}

export type NdrActionType = 'REATTEMPT' | 'UPDATE_ADDRESS_AND_REATTEMPT' | 'INITIATE_RTO';

export interface NdrActionRequest {
  awb: string;
  action: NdrActionType;
  payload: Record<string, unknown>;
}

export interface NdrActionResult {
  accepted: boolean;
  providerAck: string | null;
}

/** §8.2: the interface every Courier implements. */
export interface CourierAdapter {
  readonly courierCode: string;
  getQuote(request: QuoteRequest): Promise<QuoteResponse>;
  createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResult>;
  lookupByReference(merchantReference: string): Promise<LookupByReferenceResult>;
  cancelShipment(awb: string): Promise<CancelShipmentResult>;
  track(awb: string): Promise<TrackEvent[]>;
  getLabel(awb: string, format: 'PDF'): Promise<LabelResult>;
  schedulePickup(request: PickupRequest): Promise<PickupResult>;
  ndrAction(request: NdrActionRequest): Promise<NdrActionResult>;
}
