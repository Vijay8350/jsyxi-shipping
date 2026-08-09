import { describe, expect, it } from 'vitest';
import { buildCreateShipmentBody as bluedartBody } from '../../src/modules/bluedart/bluedart-api.map';
import { buildCreateShipmentBody as dtdcBody } from '../../src/modules/dtdc/dtdc-api.map';
import { DELHIVERY_SEED } from '../../src/modules/delhivery/delhivery.seed';
import { BLUEDART_SEED } from '../../src/modules/bluedart/bluedart.seed';
import { DTDC_SEED } from '../../src/modules/dtdc/dtdc.seed';
import { XPRESSBEES_SEED } from '../../src/modules/xpressbees/xpressbees.seed';
import { SHADOWFAX_SEED } from '../../src/modules/shadowfax/shadowfax.seed';
import { SHIPROCKET_SEED } from '../../src/modules/shiprocket/shiprocket.seed';
import { AMAZON_SHIPPING_SEED } from '../../src/modules/amazon_shipping/amazon_shipping.seed';

/**
 * Couriers key a booking to the merchant's own registered pickup/customer code.
 * Every adapter used to send our internal pickup_location_id (a UUID) in that
 * field — each api.map flagged it as an "integration gap". The merchant now
 * supplies the real code as a credential, and the mapper must prefer it.
 */

const SEEDS = [
  ['DELHIVERY', DELHIVERY_SEED],
  ['BLUEDART', BLUEDART_SEED],
  ['DTDC', DTDC_SEED],
  ['XPRESSBEES', XPRESSBEES_SEED],
  ['SHADOWFAX', SHADOWFAX_SEED],
  ['SHIPROCKET', SHIPROCKET_SEED],
  ['AMAZON_SHIPPING', AMAZON_SHIPPING_SEED],
] as const;

describe('registered pickup code — credential schema', () => {
  it.each(SEEDS)('%s offers a pickup_code field', (_code, seed) => {
    const f = (seed.credentialFields as ReadonlyArray<Record<string, unknown>>)
      .find((x) => x.key === 'pickup_code');
    expect(f, 'every courier must collect the merchant registered code').toBeDefined();
  });

  it.each(SEEDS)('%s pickup_code is NOT a secret', (_code, seed) => {
    const f = (seed.credentialFields as ReadonlyArray<Record<string, unknown>>)
      .find((x) => x.key === 'pickup_code')!;
    // It is an account reference, not a credential. Masking it would only stop
    // the merchant checking what they typed.
    expect(f.isSecret).toBe(false);
  });

  it.each(SEEDS)('%s pickup_code is optional', (_code, seed) => {
    const f = (seed.credentialFields as ReadonlyArray<Record<string, unknown>>)
      .find((x) => x.key === 'pickup_code')!;
    // Required would lock out every already-connected account on deploy.
    expect(f.isRequired).toBe(false);
  });
});

const RECIPIENT = {
  name: 'A Buyer',
  addressLines: ['12 Residency Rd'],
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
  phone: '9000000000',
  email: null,
};

function bluedartInput(extra: Record<string, unknown>) {
  return {
    recipient: RECIPIENT,
    pickupLocationId: 'a3f1c0de-0000-4000-8000-000000000001',
    merchantReference: 'REF-1',
    deadWeightKg: '1.000',
    lengthCm: '10.00',
    widthCm: '10.00',
    heightCm: '10.00',
    paymentMode: 'PREPAID',
    collectible: '0.00',
    declaredValue: '100.00',
    serviceCode: 'BD-SURFACE',
    ...extra,
  } as never;
}

describe('registered pickup code — payload mapping', () => {
  it('Blue Dart sends the merchant code as CustomerCode, not our UUID', () => {
    const body = JSON.parse(bluedartBody(bluedartInput({ registeredPickupCode: 'BLR00123' })));
    expect(body.Request.Shipper.CustomerCode).toBe('BLR00123');
    expect(body.Request.Shipper.OriginArea).toBe('BLR00123');
    expect(JSON.stringify(body)).not.toContain('a3f1c0de');
  });

  it('Blue Dart falls back to the internal id when no code is set', () => {
    // Pre-existing behaviour: wrong for the courier, but not a NEW failure for
    // accounts connected before this field existed.
    const body = JSON.parse(bluedartBody(bluedartInput({})));
    expect(body.Request.Shipper.CustomerCode).toBe('a3f1c0de-0000-4000-8000-000000000001');
  });

  it('DTDC sends the merchant code as customer_code', () => {
    const body = JSON.parse(
      dtdcBody(
        bluedartInput({ registeredPickupCode: 'DTDC-CUST-77' }) as never,
      ),
    );
    const consignment = Array.isArray(body.consignments) ? body.consignments[0] : body;
    expect(JSON.stringify(consignment)).toContain('DTDC-CUST-77');
    expect(JSON.stringify(body)).not.toContain('a3f1c0de');
  });
});
