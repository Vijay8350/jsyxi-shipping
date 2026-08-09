import { describe, expect, it } from 'vitest';
import { ADAPTER_METHODS } from '../../src/modules/courier-framework/adapter.types';
import {
  CARRIER_EVENT_STATUSES,
  SHADOWFAX_SEED,
} from '../../src/modules/shadowfax/shadowfax.seed';

/**
 * Seed-data invariants (§9.3.4): the Shadowfax seed must be internally
 * consistent with migration 0006's enums and the §8.2 method list. The DB
 * round-trip (runShadowfaxSeed idempotency) is covered where a database is
 * available; these assertions hold everywhere.
 */
describe('Shadowfax seed data', () => {
  it('declares the courier as DIRECT / KEY_PASTE with one secret api_key field', () => {
    expect(SHADOWFAX_SEED.courier).toMatchObject({
      code: 'SHADOWFAX',
      kind: 'DIRECT',
      authPattern: 'KEY_PASTE',
    });
    expect(SHADOWFAX_SEED.credentialFields).toHaveLength(1);
    expect(SHADOWFAX_SEED.credentialFields[0]).toMatchObject({
      key: 'api_key',
      isSecret: true,
      isRequired: true,
    });
  });

  it('carries an explicit capability row for every §8.2 method (A1-03)', () => {
    expect(SHADOWFAX_SEED.capabilities.map((c) => c.capability).sort()).toEqual(
      [...ADAPTER_METHODS].sort(),
    );
    for (const c of SHADOWFAX_SEED.capabilities) {
      if (!c.supported) expect(c.manualFallbackNote).toBeTruthy();
    }
  });

  it('declares getQuote unsupported with the RATE_CARD fallback note (A1-03, §3.7)', () => {
    const getQuote = SHADOWFAX_SEED.capabilities.find((c) => c.capability === 'getQuote');
    expect(getQuote?.supported).toBe(false);
    expect(getQuote?.manualFallbackNote).toContain('RATE_CARD');
    for (const c of SHADOWFAX_SEED.capabilities) {
      if (c.capability !== 'getQuote') expect(c.supported).toBe(true);
    }
  });

  it('seeds CUSTOM_ALLOWED / RATE_CARD services with the starter volumetric version (§9.9.1, §4.2)', () => {
    for (const s of SHADOWFAX_SEED.services) {
      expect(s.labelMode).toBe('CUSTOM_ALLOWED');
      expect(s.costSource).toBe('RATE_CARD');
    }
    expect(SHADOWFAX_SEED.services.map((s) => s.code)).toContain('SHADOWFAX_SURFACE');
    expect(SHADOWFAX_SEED.serviceVersion).toMatchObject({
      volumetricDivisor: '5000',
      minBillableKg: '0.500',
      billableIncrementKg: '0.500',
    });
  });

  it('maps only valid §3.6 statuses, with raw statuses normalized case-folded', () => {
    expect(SHADOWFAX_SEED.statusMap.length).toBeGreaterThan(0);
    for (const row of SHADOWFAX_SEED.statusMap) {
      expect(row.rawStatus).toBe(row.rawStatus.toLowerCase());
      expect(CARRIER_EVENT_STATUSES).toContain(row.carrierEventStatus);
    }
    // Shadowfax's known raw vocabulary is all present.
    const raws = SHADOWFAX_SEED.statusMap.map((r) => r.rawStatus);
    for (const expected of [
      'created',
      'confirmed',
      'pickup scheduled',
      'picked up',
      'in transit',
      'out for delivery',
      'delivered',
      'undelivered',
      'rto initiated',
      'rto in transit',
      'rto delivered',
      'lost',
      'damaged',
      'cancelled',
    ]) {
      expect(raws).toContain(expected);
    }
  });
});
