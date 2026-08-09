import { describe, expect, it } from 'vitest';
import { ADAPTER_METHODS } from '../../src/modules/courier-framework/adapter.types';
import {
  AMAZON_SHIPPING_SEED,
  CARRIER_EVENT_STATUSES,
} from '../../src/modules/amazon_shipping/amazon_shipping.seed';
import { foldRawStatus } from '../../src/modules/tracking/tracking.util';

/**
 * Seed-data invariants (§9.3.4): the Amazon Shipping seed must be internally
 * consistent with migration 0006's enums and the §8.2 method list. The DB
 * round-trip (runAmazonShippingSeed idempotency) is covered where a
 * database is available; these assertions hold everywhere.
 */
describe('Amazon Shipping seed data', () => {
  it('declares the courier as DIRECT / OAUTH with the LWA credential fields (§9.3.3)', () => {
    expect(AMAZON_SHIPPING_SEED.courier).toMatchObject({
      code: 'AMAZON_SHIPPING',
      kind: 'DIRECT',
      authPattern: 'OAUTH',
    });
    expect(AMAZON_SHIPPING_SEED.credentialFields).toHaveLength(3);
    expect(AMAZON_SHIPPING_SEED.credentialFields.map((f) => f.key)).toEqual([
      'refresh_token',
      'client_id',
      'client_secret',
    ]);
    for (const f of AMAZON_SHIPPING_SEED.credentialFields) {
      expect(f.isRequired).toBe(true);
    }
    // §5.7 control 3: refresh_token and client_secret are secrets;
    // client_id identifies the LWA app and is not a secret.
    const secretByKey = Object.fromEntries(
      AMAZON_SHIPPING_SEED.credentialFields.map((f) => [f.key, f.isSecret]),
    );
    expect(secretByKey).toEqual({
      refresh_token: true,
      client_id: false,
      client_secret: true,
    });
  });

  it('carries an explicit capability row for every §8.2 method (A1-03)', () => {
    expect(AMAZON_SHIPPING_SEED.capabilities.map((c) => c.capability).sort()).toEqual(
      [...ADAPTER_METHODS].sort(),
    );
    for (const c of AMAZON_SHIPPING_SEED.capabilities) {
      if (!c.supported) expect(c.manualFallbackNote).toBeTruthy();
      else expect(c.manualFallbackNote).toBeNull();
    }
  });

  it('declares getQuote, schedulePickup and ndrAction unsupported with fallback notes (A1-03)', () => {
    const byCapability = new Map(
      AMAZON_SHIPPING_SEED.capabilities.map((c) => [c.capability, c] as const),
    );
    for (const unsupported of ['getQuote', 'schedulePickup', 'ndrAction'] as const) {
      expect(byCapability.get(unsupported)?.supported).toBe(false);
      expect(byCapability.get(unsupported)?.manualFallbackNote).toBeTruthy();
    }
    for (const supported of [
      'createShipment',
      'lookupByReference',
      'cancelShipment',
      'track',
      'getLabel',
    ] as const) {
      expect(byCapability.get(supported)?.supported).toBe(true);
    }
  });

  it('seeds COURIER_PDF_REQUIRED / RATE_CARD services with the starter volumetric version (§9.9.1, §4.2)', () => {
    for (const s of AMAZON_SHIPPING_SEED.services) {
      expect(s.labelMode).toBe('COURIER_PDF_REQUIRED');
      expect(s.costSource).toBe('RATE_CARD');
    }
    expect(AMAZON_SHIPPING_SEED.services.map((s) => s.code)).toContain(
      'AMAZON_SHIPPING_STANDARD',
    );
    expect(AMAZON_SHIPPING_SEED.serviceVersion).toMatchObject({
      volumetricDivisor: '5000',
      minBillableKg: '0.500',
      billableIncrementKg: '0.500',
    });
  });

  it('maps only valid §3.6 statuses, with raw statuses already in folded form', () => {
    expect(AMAZON_SHIPPING_SEED.statusMap.length).toBeGreaterThan(0);
    for (const row of AMAZON_SHIPPING_SEED.statusMap) {
      // The stored form must be exactly what tracking.util foldRawStatus
      // produces for it (case-folded, whitespace-collapsed — migration 0006).
      expect(row.rawStatus).toBe(foldRawStatus(row.rawStatus));
      expect(CARRIER_EVENT_STATUSES).toContain(row.carrierEventStatus);
    }
    // Amazon Shipping's best-known event codes are all present.
    const raws = AMAZON_SHIPPING_SEED.statusMap.map((r) => r.rawStatus);
    for (const expected of [
      'readyforreceive',
      'pickupdone',
      'outfordelivery',
      'delivered',
      'deliveryattempted',
      'returninitiated',
      'returndelivered',
      'lost',
      'damaged',
      'cancelled',
    ]) {
      expect(raws).toContain(expected);
    }
  });
});
