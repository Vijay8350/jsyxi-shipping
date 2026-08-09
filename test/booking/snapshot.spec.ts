import { describe, expect, it } from 'vitest';
import {
  buildBookingSnapshot,
  buildMerchantReference,
  buildRequestDigest,
  deadWeightWithTare,
  normalizeAwb,
} from '../../src/modules/booking/snapshot';
import { workingValues, validRecipient } from './helpers';

/**
 * §2.9 snapshot assembler: full-content assertion, plus F-19, the §13.5
 * merchant reference and the §9.5.4 digest.
 */

function fullInput() {
  return {
    working: workingValues() as never,
    pickupLocation: {
      pickupLocationId: 'pl',
      name: 'Main warehouse',
      contactName: 'Ops',
      phone: '9800000000',
      addressLines: ['Plot 7'],
      city: 'Ahmedabad',
      state: 'Gujarat',
      pincode: '380015',
      gstin: '24AAAAA0000A1Z5',
    },
    packageProfile: {
      packageProfileId: 'pp',
      lengthCm: '25.00',
      widthCm: '20.00',
      heightCm: '10.00',
      tareKg: '0.040',
      source: 'DEFAULT',
    },
    deadWeightKg: '0.540',
    paymentMode: 'COD' as const,
    collectible: '1250.50',
    declaredValue: '1250.50',
    originPincode: '380015',
    destinationPincode: '560001',
    shipDate: '2026-07-31',
    service: {
      serviceId: 'svc',
      serviceVersionId: 'sv',
      code: 'EXP',
      name: 'Express',
      costSource: 'RATE_CARD' as const,
      volumetricDivisor: '5000',
      minBillableKg: '0.5',
      billableIncrementKg: '0.5',
    },
    courierAccount: { courierAccountId: 'ca', mode: 'LIVE' as const },
    weights: {
      volumetricWeightKg: '1.000',
      rawChargeableKg: '1.000',
      billableWeightKg: '1.000',
    },
    rateCardVersionId: 'rcv',
    zoneMapId: 'zm',
    zone: 'C',
    quote: {
      serviceable: true,
      failureReasons: [],
      rateAvailable: true,
      components: [{ code: 'F-5', label: 'Base freight', amount: '80.00', taxable: true }],
      total: '80.00',
      currency: 'INR' as const,
      rtoRule: { basis: 'SAME_AS_FORWARD' as const, pct: null },
      eddFrom: '2026-08-02',
      eddTo: '2026-08-04',
      eddSource: 'PROVIDER' as const,
      fetchedAt: '2026-07-31T10:00:00.000Z',
      providerQuoteRef: 'qref-1',
      capabilityFlags: [],
    },
    shopifyOrderGid: 'gid://shopify/Order/1',
    frozenAt: '2026-07-31T10:05:00.000Z',
  };
}

describe('buildBookingSnapshot (§2.9 full content list)', () => {
  it('contains every §2.9 element', () => {
    const snap = buildBookingSnapshot(fullInput());

    // recipient
    expect(snap.recipient).toEqual(validRecipient());
    // allocation line IDs + quantities with SKU/title/variant/tags/unit price/HSN
    expect(snap.lines).toHaveLength(1);
    expect(snap.lines[0]).toMatchObject({
      orderLineId: 'l1',
      sku: 'TEE-BLK-M',
      title: 'Cotton Tee',
      variant: 'Black / M',
      quantity: 2,
      unitPrice: '500.00',
      tags: ['summer'],
      hsnCode: '6109',
    });
    // pickup_location full address + GSTIN
    expect(snap.pickupLocation).toMatchObject({ pincode: '380015', gstin: '24AAAAA0000A1Z5' });
    // package profile with L×W×H + tare
    expect(snap.packageProfile).toMatchObject({
      lengthCm: '25.00',
      widthCm: '20.00',
      heightCm: '10.00',
      tareKg: '0.040',
    });
    // payment mode + collectible
    expect(snap.payment).toEqual({ mode: 'COD', collectible: '1250.50', currency: 'INR' });
    // F-24 WITH per-line derivation; volumetric/raw chargeable/billable
    expect(snap.weights.deadWeightKg).toBe('0.540');
    expect(snap.weights.perLine).toHaveLength(1);
    expect(snap.weights.perLine[0]).toMatchObject({
      orderLineId: 'l1',
      perUnitWeightKg: '0.250',
      lineWeightKg: '0.500',
    });
    expect(snap.weights.volumetricWeightKg).toBe('1.000');
    expect(snap.weights.rawChargeableKg).toBe('1.000');
    expect(snap.weights.billableWeightKg).toBe('1.000');
    // service_id + service_version_id with divisor/min/increment
    expect(snap.service).toMatchObject({
      serviceId: 'svc',
      serviceVersionId: 'sv',
      volumetricDivisor: '5000',
      minBillableKg: '0.5',
      billableIncrementKg: '0.5',
    });
    // courier_account_id + mode
    expect(snap.courierAccount).toEqual({ courierAccountId: 'ca', mode: 'LIVE' });
    // rate_card_version_id + zone_map_id; resolved zone
    expect(snap.rateCardVersionId).toBe('rcv');
    expect(snap.zoneMapId).toBe('zm');
    expect(snap.zone).toBe('C');
    // every formula input from §4
    expect(snap.formulaInputs).toMatchObject({
      pieces: 1,
      originPincode: '380015',
      destinationPincode: '560001',
      deadWeightKg: '0.540',
      paymentMode: 'COD',
      collectible: '1250.50',
      zone: 'C',
    });
    // the full itemized expected quote
    expect(snap.expectedQuote).toMatchObject({
      costSource: 'RATE_CARD',
      total: '80.00',
      currency: 'INR',
      providerQuoteRef: 'qref-1',
      fetchedAt: '2026-07-31T10:00:00.000Z',
      eddSource: 'PROVIDER',
    });
    expect(snap.expectedQuote?.components[0]).toMatchObject({ code: 'F-5', amount: '80.00' });
    // Shopify order GID + line GIDs + fulfillment order GIDs
    expect(snap.shopify).toEqual({
      orderGid: 'gid://shopify/Order/1',
      lineGids: ['gid://shopify/LineItem/1'],
      fulfillmentOrderGids: ['gid://shopify/FulfillmentOrder/1'],
    });
    // rule_id + rule_version — null until the rules engine lands (weeks 9–11)
    expect(snap.rule).toBeNull();
    expect(snap.frozenAt).toBe('2026-07-31T10:05:00.000Z');
  });

  it('nulls rate_card_version_id / zone_map_id for LIVE_QUOTE (§2.9)', () => {
    const snap = buildBookingSnapshot({
      ...fullInput(),
      service: { ...fullInput().service, costSource: 'LIVE_QUOTE' },
      rateCardVersionId: null,
      zoneMapId: null,
      zone: null,
    });
    expect(snap.rateCardVersionId).toBeNull();
    expect(snap.zoneMapId).toBeNull();
    expect(snap.zone).toBeNull();
  });
});

describe('normalizeAwb (F-19)', () => {
  it('trims, strips whitespace and hyphens, upper-cases', () => {
    expect(normalizeAwb(' dl 0087-412 391 ')).toBe('DL0087412391');
    expect(normalizeAwb('DL0087412391')).toBe('DL0087412391');
  });
});

describe('buildMerchantReference (§13.5)', () => {
  it('is {shop_short_id}-{shipment_id} with the first 8 of the shop uuid', () => {
    expect(
      buildMerchantReference('11111111-2222-3333-4444-555555555555', 'ship-1', 1),
    ).toBe('11111111-ship-1');
  });

  it('suffixes attempts after the first (UNIQUE column, §9.5.4 new intent)', () => {
    expect(buildMerchantReference('11111111-x', 'ship-1', 2)).toBe('11111111-ship-1-2');
  });
});

describe('buildRequestDigest (§9.5.4)', () => {
  const fields = {
    merchantReference: 'ref',
    shipmentId: 's',
    serviceId: 'svc',
    courierAccountId: 'ca',
    originPincode: '380015',
    destinationPincode: '560001',
    deadWeightKg: '0.540',
    lengthCm: '25.00',
    widthCm: '20.00',
    heightCm: '10.00',
    paymentMode: 'COD' as const,
    collectible: '1250.50',
    declaredValue: '1250.50',
  };

  it('is a stable sha256 of the attempt-invariant fields', () => {
    const a = buildRequestDigest(fields);
    const b = buildRequestDigest({ ...fields });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when an attempt-invariant field changes', () => {
    expect(buildRequestDigest({ ...fields, collectible: '0.00' })).not.toBe(
      buildRequestDigest(fields),
    );
  });
});

describe('deadWeightWithTare (§4.2 step 4, package override)', () => {
  it('re-adds only the new tare — content weight is unchanged', () => {
    expect(deadWeightWithTare('1.630', '0.080', '0.100')).toBe('1.650');
    expect(deadWeightWithTare('0.540', '0.040', '0.040')).toBe('0.540');
  });
});
