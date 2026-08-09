import { describe, expect, it } from 'vitest';
import { ADAPTER_METHODS } from '../../src/modules/courier-framework/adapter.types';
import {
  CARRIER_EVENT_STATUSES,
  DELHIVERY_SEED,
} from '../../src/modules/delhivery/delhivery.seed';

/**
 * Seed-data invariants (§9.3.4): the Delhivery seed must be internally
 * consistent with migration 0006's enums and the §8.2 method list. The DB
 * round-trip (runDelhiverySeed idempotency) is covered where a database is
 * available; these assertions hold everywhere.
 */
describe('Delhivery seed data', () => {
  it('declares the courier as DIRECT / KEY_PASTE with one secret api_token field', () => {
    expect(DELHIVERY_SEED.courier).toMatchObject({
      code: 'DELHIVERY',
      kind: 'DIRECT',
      authPattern: 'KEY_PASTE',
    });
        // pickup_code (the merchant's courier-registered pickup identity) is
    // appended by the shared credential schema and asserted in
    // test/courier-framework/registered-pickup-code.spec.ts.
    expect(DELHIVERY_SEED.credentialFields.filter((f) => f.isSecret)).toHaveLength(1);
    expect(DELHIVERY_SEED.credentialFields[0]).toMatchObject({
      key: 'api_token',
      isSecret: true,
      isRequired: true,
    });
  });

  it('carries an explicit capability row for every §8.2 method (A1-03)', () => {
    expect(DELHIVERY_SEED.capabilities.map((c) => c.capability).sort()).toEqual(
      [...ADAPTER_METHODS].sort(),
    );
    for (const c of DELHIVERY_SEED.capabilities) {
      if (!c.supported) expect(c.manualFallbackNote).toBeTruthy();
    }
  });

  it('seeds CUSTOM_ALLOWED / RATE_CARD services with the starter volumetric version (§9.9.1, §4.2)', () => {
    for (const s of DELHIVERY_SEED.services) {
      expect(s.labelMode).toBe('CUSTOM_ALLOWED');
      expect(s.costSource).toBe('RATE_CARD');
    }
    expect(DELHIVERY_SEED.services.map((s) => s.code)).toContain('DELHIVERY_SURFACE');
    expect(DELHIVERY_SEED.serviceVersion).toMatchObject({
      volumetricDivisor: '5000',
      minBillableKg: '0.500',
      billableIncrementKg: '0.500',
    });
  });

  it('maps only valid §3.6 statuses, with raw statuses normalized case-folded', () => {
    expect(DELHIVERY_SEED.statusMap.length).toBeGreaterThan(0);
    for (const row of DELHIVERY_SEED.statusMap) {
      expect(row.rawStatus).toBe(row.rawStatus.toLowerCase());
      expect(CARRIER_EVENT_STATUSES).toContain(row.carrierEventStatus);
    }
    // Delhivery's known raw vocabulary is all present.
    const raws = DELHIVERY_SEED.statusMap.map((r) => r.rawStatus);
    for (const expected of [
      'manifested',
      'pickup scheduled',
      'picked up',
      'in transit',
      'out for delivery',
      'delivered',
      'undelivered',
      'rto',
      'dto',
      'lost',
      'cancelled',
    ]) {
      expect(raws).toContain(expected);
    }
  });
});
