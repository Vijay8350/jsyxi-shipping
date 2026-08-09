import { describe, expect, it } from 'vitest';
import { ADAPTER_METHODS } from '../../src/modules/courier-framework/adapter.types';
import {
  CARRIER_EVENT_STATUSES,
  XPRESSBEES_SEED,
} from '../../src/modules/xpressbees/xpressbees.seed';

/**
 * Seed-data invariants (§9.3.4): the Xpressbees seed must be internally
 * consistent with migration 0006's enums and the §8.2 method list. The DB
 * round-trip (runXpressbeesSeed idempotency) is covered where a database is
 * available; these assertions hold everywhere.
 */
describe('Xpressbees seed data', () => {
  it('declares the courier as DIRECT / KEY_PASTE with secret email + password fields', () => {
    expect(XPRESSBEES_SEED.courier).toMatchObject({
      code: 'XPRESSBEES',
      kind: 'DIRECT',
      authPattern: 'KEY_PASTE',
    });
    // pickup_code is appended by the shared credential schema and asserted in
    // test/courier-framework/registered-pickup-code.spec.ts; these assertions
    // therefore scope themselves to the courier's own secret credentials.
    expect(XPRESSBEES_SEED.credentialFields.filter((f) => f.isSecret)).toHaveLength(2);
    expect(XPRESSBEES_SEED.credentialFields.map((f) => f.key)).toEqual([
      'email',
      'password',
      'pickup_code',
    ]);
    for (const f of XPRESSBEES_SEED.credentialFields.filter((x) => x.isSecret)) {
      expect(f.isRequired).toBe(true);
    }
  });

  it('carries an explicit capability row for every §8.2 method (A1-03)', () => {
    expect(XPRESSBEES_SEED.capabilities.map((c) => c.capability).sort()).toEqual(
      [...ADAPTER_METHODS].sort(),
    );
    for (const c of XPRESSBEES_SEED.capabilities) {
      if (!c.supported) expect(c.manualFallbackNote).toBeTruthy();
    }
  });

  it('declares getQuote unsupported with a manual fallback note (A1-03, RATE_CARD §3.7)', () => {
    const getQuote = XPRESSBEES_SEED.capabilities.find((c) => c.capability === 'getQuote');
    expect(getQuote?.supported).toBe(false);
    expect(getQuote?.manualFallbackNote).toBeTruthy();
    const rest = XPRESSBEES_SEED.capabilities.filter((c) => c.capability !== 'getQuote');
    for (const c of rest) {
      expect(c.supported).toBe(true);
      expect(c.manualFallbackNote).toBeNull();
    }
  });

  it('seeds CUSTOM_ALLOWED / RATE_CARD services with the starter volumetric version (§9.9.1, §4.2)', () => {
    for (const s of XPRESSBEES_SEED.services) {
      expect(s.labelMode).toBe('CUSTOM_ALLOWED');
      expect(s.costSource).toBe('RATE_CARD');
    }
    expect(XPRESSBEES_SEED.services.map((s) => s.code)).toContain('XPRESSBEES_SURFACE');
    expect(XPRESSBEES_SEED.serviceVersion).toMatchObject({
      volumetricDivisor: '5000',
      minBillableKg: '0.500',
      billableIncrementKg: '0.500',
    });
  });

  it('maps only valid §3.6 statuses, with raw statuses normalized case-folded', () => {
    expect(XPRESSBEES_SEED.statusMap.length).toBeGreaterThan(0);
    for (const row of XPRESSBEES_SEED.statusMap) {
      expect(row.rawStatus).toBe(row.rawStatus.toLowerCase());
      expect(CARRIER_EVENT_STATUSES).toContain(row.carrierEventStatus);
    }
    // Xpressbees' known raw vocabulary is all present.
    const raws = XPRESSBEES_SEED.statusMap.map((r) => r.rawStatus);
    for (const expected of [
      'pending',
      'pickup scheduled',
      'picked',
      'in transit',
      'out for delivery',
      'delivered',
      'undelivered',
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
