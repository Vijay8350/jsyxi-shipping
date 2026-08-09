import { describe, expect, it } from 'vitest';
import { ADAPTER_METHODS } from '../../src/modules/courier-framework/adapter.types';
import {
  CARRIER_EVENT_STATUSES,
  SHIPROCKET_SEED,
} from '../../src/modules/shiprocket/shiprocket.seed';

/**
 * Seed-data invariants (§9.3.4): the Shiprocket seed must be internally
 * consistent with migration 0006's enums and the §8.2 method list. The DB
 * round-trip (runShiprocketSeed idempotency) is covered where a database is
 * available; these assertions hold everywhere.
 */
describe('Shiprocket seed data', () => {
  it('declares the courier as AGGREGATOR / KEY_PASTE with secret email + password and a non-secret courier map', () => {
    expect(SHIPROCKET_SEED.courier).toMatchObject({
      code: 'SHIPROCKET',
      kind: 'AGGREGATOR', // §9.3.4, A2-02
      authPattern: 'KEY_PASTE',
    });
    expect(SHIPROCKET_SEED.credentialFields.map((f) => f.key)).toEqual([
      'email',
      'password',
      'shiprocket_courier_map',
    ]);
    const secrets = SHIPROCKET_SEED.credentialFields.filter((f) => f.isSecret);
    expect(secrets.map((f) => f.key)).toEqual(['email', 'password']);
    for (const f of secrets) expect(f.isRequired).toBe(true);
    // The nested-courier mapping is routing configuration, not a secret.
    const map = SHIPROCKET_SEED.credentialFields.find((f) => f.key === 'shiprocket_courier_map');
    expect(map).toMatchObject({ isSecret: false, isRequired: false });
  });

  it('carries an explicit capability row for every §8.2 method (A1-03)', () => {
    expect(SHIPROCKET_SEED.capabilities.map((c) => c.capability).sort()).toEqual(
      [...ADAPTER_METHODS].sort(),
    );
    for (const c of SHIPROCKET_SEED.capabilities) {
      if (!c.supported) expect(c.manualFallbackNote).toBeTruthy();
    }
  });

  it('declares ndrAction unsupported with a manual fallback note (A1-03)', () => {
    const ndr = SHIPROCKET_SEED.capabilities.find((c) => c.capability === 'ndrAction');
    expect(ndr?.supported).toBe(false);
    expect(ndr?.manualFallbackNote).toContain('Shiprocket panel');
    const rest = SHIPROCKET_SEED.capabilities.filter((c) => c.capability !== 'ndrAction');
    for (const c of rest) {
      expect(c.supported).toBe(true);
      expect(c.manualFallbackNote).toBeNull();
    }
  });

  it('seeds CUSTOM_ALLOWED / LIVE_QUOTE services whose codes carry the nested courier_id (A2-02, §9.9.1, §15.1)', () => {
    expect(SHIPROCKET_SEED.services.length).toBeGreaterThanOrEqual(2);
    expect(SHIPROCKET_SEED.services.length).toBeLessThanOrEqual(3);
    for (const s of SHIPROCKET_SEED.services) {
      expect(s.labelMode).toBe('CUSTOM_ALLOWED');
      expect(s.costSource).toBe('LIVE_QUOTE');
      // The documented code convention: SR-L<zero-padded Shiprocket courier_id>.
      expect(s.code).toMatch(/^SR-L\d{3}$/);
    }
    expect(SHIPROCKET_SEED.services.map((s) => s.code)).toContain('SR-L039');
    expect(SHIPROCKET_SEED.serviceVersion).toMatchObject({
      volumetricDivisor: '5000',
      minBillableKg: '0.500',
      billableIncrementKg: '0.500',
    });
  });

  it('maps only valid §3.6 statuses, with raw statuses normalized case-folded', () => {
    expect(SHIPROCKET_SEED.statusMap.length).toBeGreaterThan(0);
    for (const row of SHIPROCKET_SEED.statusMap) {
      expect(row.rawStatus).toBe(row.rawStatus.toLowerCase());
      expect(CARRIER_EVENT_STATUSES).toContain(row.carrierEventStatus);
    }
    // Shiprocket's known raw vocabulary is all present.
    const raws = SHIPROCKET_SEED.statusMap.map((r) => r.rawStatus);
    for (const expected of [
      'new',
      'pickup scheduled',
      'picked up',
      'shipped',
      'in transit',
      'out for delivery',
      'delivered',
      'undelivered',
      'rto initiated',
      'rto delivered',
      'lost',
      'damaged',
      'canceled',
    ]) {
      expect(raws).toContain(expected);
    }
  });
});
