import { describe, expect, it } from 'vitest';
import { computeRtoExpectation } from '../../src/modules/rate-engine/pricing';

/**
 * §4.4 F-12 — the RTO charge from the booking snapshot, all three cases:
 * SAME_AS_FORWARD, PERCENT_OF_FORWARD, and no rto_rule → a typed "no
 * expectation" (flag_review semantics, §4.4/§4.8 — never a false mismatch).
 */
const TARIFF = {
  fuelPct: '0.180000',
  gstPct: '0.180000',
  taxableComponents: ['F-5', 'F-6', 'F-7', 'F-8'],
  components: [],
};

const SNAPSHOT = {
  f5BaseFreight: '80.00', // the §4.4 worked example's F-5
  billableWeightKg: '1.000',
  declaredValue: '2000.00',
};

describe('F-12 · SAME_AS_FORWARD', () => {
  it('RTO base is the snapshot F-5, with fuel and GST on forward terms', () => {
    const r = computeRtoExpectation({
      rtoRule: { basis: 'SAME_AS_FORWARD', pct: null },
      snapshot: SNAPSHOT,
      tariff: TARIFF,
    });
    if (r.kind !== 'EXPECTED') throw new Error('expected EXPECTED');
    expect(r.rtoBase).toBe('80.00');
    expect(r.breakdown.f6Fuel).toBe('14.40'); // 0.18 × 80.00
    expect(r.breakdown.f7Cod).toBe('0.00'); // no COD component on a return leg
    expect(r.breakdown.f9PreTaxSubtotal).toBe('94.40');
    expect(r.breakdown.f10Gst).toBe('16.99'); // 0.18 × 94.40 = 16.992 → half-up
    expect(r.breakdown.f11Total).toBe('111.39');
  });
});

describe('F-12 · PERCENT_OF_FORWARD', () => {
  it('RTO base is rto_pct × snapshot F-5', () => {
    const r = computeRtoExpectation({
      rtoRule: { basis: 'PERCENT_OF_FORWARD', pct: '0.500000' },
      snapshot: SNAPSHOT,
      tariff: TARIFF,
    });
    if (r.kind !== 'EXPECTED') throw new Error('expected EXPECTED');
    expect(r.rtoBase).toBe('40.00'); // 0.5 × 80.00
    expect(r.breakdown.f6Fuel).toBe('7.20');
    expect(r.breakdown.f9PreTaxSubtotal).toBe('47.20');
    expect(r.breakdown.f10Gst).toBe('8.50'); // 0.18 × 47.20 = 8.496 → half-up
    expect(r.breakdown.f11Total).toBe('55.70');
  });

  it('PERCENT_OF_FORWARD without a pct → no expectation (§4.1 guard)', () => {
    const r = computeRtoExpectation({
      rtoRule: { basis: 'PERCENT_OF_FORWARD', pct: null },
      snapshot: SNAPSHOT,
      tariff: TARIFF,
    });
    expect(r).toEqual({ kind: 'NO_EXPECTATION', reason: 'RTO_PCT_MISSING' });
  });
});

describe('F-12 · no rto_rule → no expectation', () => {
  it('returns the typed NO_EXPECTATION result (flag_review, §4.4/§4.8)', () => {
    const r = computeRtoExpectation({
      rtoRule: null, // a LIVE_QUOTE snapshot whose provider returned no rto_rule
      snapshot: SNAPSHOT,
      tariff: TARIFF,
    });
    expect(r).toEqual({ kind: 'NO_EXPECTATION', reason: 'NO_RTO_RULE' });
  });
});
