import { describe, expect, it } from 'vitest';
import { ADAPTER_METHODS } from '../../src/modules/courier-framework/adapter.types';
import { BLUEDART_SEED, CARRIER_EVENT_STATUSES } from '../../src/modules/bluedart/bluedart.seed';

/**
 * Seed-data invariants (§9.3.4): the Blue Dart seed must be internally
 * consistent with migration 0006's enums and the §8.2 method list. The DB
 * round-trip (runBluedartSeed idempotency) is covered where a database is
 * available; these assertions hold everywhere.
 */
describe('Blue Dart seed data', () => {
  it('declares the courier as DIRECT / KEY_PASTE with two secret credential fields', () => {
    expect(BLUEDART_SEED.courier).toMatchObject({
      code: 'BLUEDART',
      kind: 'DIRECT',
      authPattern: 'KEY_PASTE',
    });
    expect(BLUEDART_SEED.credentialFields).toHaveLength(2);
    for (const f of BLUEDART_SEED.credentialFields) {
      expect(f.isSecret).toBe(true);
      expect(f.isRequired).toBe(true);
    }
    expect(BLUEDART_SEED.credentialFields.map((f) => f.key)).toEqual([
      'client_id',
      'client_secret',
    ]);
  });

  it('carries an explicit capability row for every §8.2 method, with ndrAction unsupported + fallback (A1-03)', () => {
    expect(BLUEDART_SEED.capabilities.map((c) => c.capability).sort()).toEqual(
      [...ADAPTER_METHODS].sort(),
    );
    for (const c of BLUEDART_SEED.capabilities) {
      if (!c.supported) expect(c.manualFallbackNote).toBeTruthy();
    }
    const ndr = BLUEDART_SEED.capabilities.find((c) => c.capability === 'ndrAction');
    expect(ndr?.supported).toBe(false);
    expect(ndr?.manualFallbackNote).toBeTruthy();
    for (const c of BLUEDART_SEED.capabilities.filter((c) => c.capability !== 'ndrAction')) {
      expect(c.supported).toBe(true);
      expect(c.manualFallbackNote).toBeNull();
    }
  });

  it('seeds COURIER_PDF_REQUIRED / RATE_CARD services with the starter volumetric version (§9.9.1, §4.2)', () => {
    for (const s of BLUEDART_SEED.services) {
      expect(s.labelMode).toBe('COURIER_PDF_REQUIRED');
      expect(s.costSource).toBe('RATE_CARD');
    }
    expect(BLUEDART_SEED.services.map((s) => s.code)).toContain('BLUEDART_APEX');
    expect(BLUEDART_SEED.serviceVersion).toMatchObject({
      volumetricDivisor: '5000',
      minBillableKg: '0.500',
      billableIncrementKg: '0.500',
    });
  });

  it('maps only valid §3.6 statuses, with raw statuses normalized case-folded', () => {
    expect(BLUEDART_SEED.statusMap.length).toBeGreaterThan(0);
    for (const row of BLUEDART_SEED.statusMap) {
      expect(row.rawStatus).toBe(row.rawStatus.toLowerCase());
      expect(CARRIER_EVENT_STATUSES).toContain(row.carrierEventStatus);
    }
    // Blue Dart's known raw vocabulary is all present.
    const raws = BLUEDART_SEED.statusMap.map((r) => r.rawStatus);
    for (const expected of [
      'shipment booked',
      'pickup scheduled',
      'pickup done',
      'picked up',
      'in transit',
      'out for delivery',
      'delivered',
      'undelivered',
      'rto',
      'rto in transit',
      'rto delivered',
      'lost',
      'damaged',
      'shipment cancelled',
    ]) {
      expect(raws).toContain(expected);
    }
  });
});
