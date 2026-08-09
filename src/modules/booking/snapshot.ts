import { createHash } from 'node:crypto';
import { kgToGrams, gramsToKg } from '../order-derivation/weight';
import type { payment_mode } from '../courier-framework/adapter.enum-types';
import type { QuoteResponse } from '../courier-framework/adapter.types';
import type {
  BookingSnapshot,
  CostSource,
  CourierAccountMode,
  SnapshotFormulaInputs,
  SnapshotLine,
  SnapshotPackageProfile,
  SnapshotPickupLocation,
  SnapshotQuote,
  SnapshotRecipient,
  SnapshotWeights,
} from './booking.types';
import type { ShipmentWorkingValuesWeek4 } from '../order-derivation/working-values-week4.types';

/**
 * §2.9 booking snapshot assembly — pure functions. The snapshot is written
 * ONCE per booking attempt, inside the DRAFT → QUEUED transition (INV-10);
 * the DB trigger (migration 0003) rejects any other snapshot write path, so a
 * bad caller fails loudly.
 */

/** F-19 (§4.9): trim → strip all whitespace and hyphens → upper-case. */
export function normalizeAwb(raw: string): string {
  return raw.trim().replace(/[\s-]+/g, '').toUpperCase();
}

/**
 * §13.5 booking merchant reference: `{shop_short_id}-{shipment_id}` where
 * shop_short_id is the first 8 of the shop uuid. Stable across every retry of
 * ONE booking intent. A retry after FAILED / rebook after cancellation is a
 * NEW intent (§9.5.4) and booking_intent.merchant_reference is UNIQUE, so
 * attempts after the first carry a `-{attempt}` suffix — the base format is
 * preserved and the reference stays globally unique and stable per attempt.
 */
export function buildMerchantReference(shopId: string, shipmentId: string, attemptNumber: number): string {
  const base = `${shopId.slice(0, 8)}-${shipmentId}`;
  return attemptNumber <= 1 ? base : `${base}-${attemptNumber}`;
}

/**
 * §9.5.4 / §8.2: the request digest — a stable hash of the attempt-invariant
 * request fields. Transport retries of one attempt reuse the same intent and
 * digest; a field that changes between attempts (a new snapshot) changes it.
 */
export function buildRequestDigest(fields: {
  merchantReference: string;
  shipmentId: string;
  serviceId: string;
  courierAccountId: string;
  originPincode: string;
  destinationPincode: string;
  deadWeightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  paymentMode: payment_mode;
  collectible: string;
  declaredValue: string;
}): string {
  const canonical = JSON.stringify(fields, Object.keys(fields).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * F-24 under a §9.5.1 package-profile override: the content weight (steps
 * 1–3 of §4.2 — the per-line ladder and the S-7 fallback) does not depend on
 * the profile, so an override re-adds only the new tare (step 4, once).
 * Integer-gram math (§4.1 — no floats).
 */
export function deadWeightWithTare(deadWeightKg: string, oldTareKg: string, newTareKg: string): string {
  const content = kgToGrams(deadWeightKg) - kgToGrams(oldTareKg);
  return gramsToKg(content + kgToGrams(newTareKg));
}

function toSnapshotQuote(costSource: CostSource, quote: QuoteResponse): SnapshotQuote {
  return {
    costSource,
    components: quote.components,
    total: quote.total,
    currency: quote.currency,
    rtoRule: quote.rtoRule,
    eddFrom: quote.eddFrom,
    eddTo: quote.eddTo,
    eddSource: quote.eddSource,
    providerQuoteRef: quote.providerQuoteRef,
    fetchedAt: quote.fetchedAt,
  };
}

export interface BuildSnapshotInput {
  working: ShipmentWorkingValuesWeek4;
  pickupLocation: SnapshotPickupLocation | null;
  packageProfile: SnapshotPackageProfile | null;
  /** F-24 after any package-override tare adjustment. */
  deadWeightKg: string | null;
  paymentMode: payment_mode;
  collectible: string;
  declaredValue: string;
  originPincode: string | null;
  destinationPincode: string | null;
  shipDate: string;
  service: {
    serviceId: string;
    serviceVersionId: string | null;
    code: string;
    name: string;
    costSource: CostSource;
    volumetricDivisor: string | null;
    minBillableKg: string | null;
    billableIncrementKg: string | null;
  };
  courierAccount: { courierAccountId: string; mode: CourierAccountMode };
  /** F-1/F-2/F-3 from computeWeights (nulls under the §4.1 guard). */
  weights: {
    volumetricWeightKg: string | null;
    rawChargeableKg: string | null;
    billableWeightKg: string | null;
  };
  rateCardVersionId: string | null;
  zoneMapId: string | null;
  zone: string | null;
  quote: QuoteResponse | null;
  shopifyOrderGid: string | null;
  frozenAt: string;
}

/** §2.9: the FULL snapshot content list. */
export function buildBookingSnapshot(input: BuildSnapshotInput): BookingSnapshot {
  const { working } = input;
  const recipient: SnapshotRecipient | null = working.recipient ?? null;
  const lines: SnapshotLine[] = (working.lines ?? []).map((l) => ({
    orderLineId: l.orderLineId,
    shopifyLineGid: l.shopifyLineGid,
    sku: l.sku,
    title: l.title,
    variant: l.variant,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    tags: l.tags ?? [],
    hsnCode: l.hsnCode,
  }));

  const weightBlock = working.weight ?? null;
  const weights: SnapshotWeights = {
    deadWeightKg: input.deadWeightKg ?? '0.000',
    lineWeightTotalKg: weightBlock?.lineWeightTotalKg ?? '0.000',
    usedDefaultParcelWeight: weightBlock?.usedDefaultParcelWeight ?? false,
    tareKg: input.packageProfile?.tareKg ?? weightBlock?.tareKg ?? '0.000',
    perLine: weightBlock?.lines ?? [],
    volumetricWeightKg: input.weights.volumetricWeightKg,
    rawChargeableKg: input.weights.rawChargeableKg,
    billableWeightKg: input.weights.billableWeightKg,
  };

  const formulaInputs: SnapshotFormulaInputs = {
    shipDate: input.shipDate,
    pieces: 1, // INV-4
    originPincode: input.originPincode ?? '',
    destinationPincode: input.destinationPincode ?? '',
    deadWeightKg: weights.deadWeightKg,
    lengthCm: input.packageProfile?.lengthCm ?? '0.00',
    widthCm: input.packageProfile?.widthCm ?? '0.00',
    heightCm: input.packageProfile?.heightCm ?? '0.00',
    paymentMode: input.paymentMode,
    collectible: input.collectible,
    declaredValue: input.declaredValue,
    zone: input.zone,
    billableWeightKg: input.weights.billableWeightKg,
  };

  return {
    schemaVersion: 1,
    frozenAt: input.frozenAt,
    recipient,
    lines,
    pickupLocation: input.pickupLocation,
    packageProfile: input.packageProfile,
    payment: { mode: input.paymentMode, collectible: input.collectible, currency: 'INR' },
    weights,
    service: { ...input.service },
    courierAccount: { ...input.courierAccount },
    rateCardVersionId: input.rateCardVersionId,
    zoneMapId: input.zoneMapId,
    zone: input.zone,
    formulaInputs,
    expectedQuote: input.quote ? toSnapshotQuote(input.service.costSource, input.quote) : null,
    shopify: {
      orderGid: input.shopifyOrderGid,
      lineGids: lines.map((l) => l.shopifyLineGid).filter((g): g is string => g !== null),
      fulfillmentOrderGids: working.fulfillment?.sourceFulfillmentOrderGids ?? [],
    },
    // §2.9: rule_id + rule_version when the Service came from a rule
    // (written into working values by the §9.4.4 routing path).
    rule:
      working.routing?.ruleId != null && working.routing.ruleVersion != null
        ? { ruleId: working.routing.ruleId, ruleVersion: working.routing.ruleVersion }
        : null,
  };
}
