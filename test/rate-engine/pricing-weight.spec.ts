import { describe, expect, it } from 'vitest';
import {
  billableWeightKg,
  computeWeights,
  rawChargeableWeightKg,
  volumetricWeightKg,
} from '../../src/modules/rate-engine/pricing';

/**
 * §4.2 worked examples A and B (spec.md §4.2) — F-1 volumetric, F-2 raw
 * chargeable, F-3 billable, reproduced exactly.
 *
 * The F-24 dead weights (0.420 / 1.630 kg) are taken as given by the
 * examples; their per-line derivation lives in order-derivation/weight.ts.
 */
describe('§4.2 F-1/F-2/F-3 — worked examples A and B', () => {
  it('example A: F-1 = 1.000, F-2 = 1.000, F-3 = 1.000', () => {
    // 25 × 20 × 10 cm, divisor 5000, dead 0.420, min 0.5, increment 0.5.
    const f1 = volumetricWeightKg('25.00', '20.00', '10.00', '5000.0000');
    expect(f1).toBe('1.000');
    const f2 = rawChargeableWeightKg('0.420', f1!);
    expect(f2).toBe('1.000');
    const f3 = billableWeightKg(f2, '0.500', '0.500');
    expect(f3).toBe('1.000');
  });

  it('example B: F-1 = 1.728, F-2 = 1.728, F-3 = 2.000', () => {
    // 30 × 24 × 12 cm, divisor 5000, dead 1.630, min 0.5, increment 0.5.
    const f1 = volumetricWeightKg('30.00', '24.00', '12.00', '5000.0000');
    expect(f1).toBe('1.728');
    const f2 = rawChargeableWeightKg('1.630', f1!);
    expect(f2).toBe('1.728');
    const f3 = billableWeightKg(f2, '0.500', '0.500');
    expect(f3).toBe('2.000');
  });

  it('F-3 rounds UP to the next increment (1.001 → 1.500)', () => {
    expect(billableWeightKg('1.001', '0.500', '0.500')).toBe('1.500');
  });

  it('F-3 never goes below the service minimum', () => {
    expect(billableWeightKg('0.100', '0.500', '0.500')).toBe('0.500');
  });

  it('F-2 takes the larger of dead and volumetric', () => {
    expect(rawChargeableWeightKg('2.500', '1.000')).toBe('2.500');
  });
});

describe('§4.1 zero/null guards on weight terms', () => {
  it('null divisor → null volumetric (unpriceable, never zero)', () => {
    expect(volumetricWeightKg('25.00', '20.00', '10.00', null)).toBeNull();
  });

  it('null minimum / increment → null billable (unpriceable)', () => {
    expect(billableWeightKg('1.000', null, '0.500')).toBeNull();
    expect(billableWeightKg('1.000', '0.500', null)).toBeNull();
  });

  it('computeWeights propagates the null guard through the chain', () => {
    expect(
      computeWeights({
        deadWeightKg: '0.420',
        lengthCm: '25.00',
        widthCm: '20.00',
        heightCm: '10.00',
        divisor: null,
        minBillableKg: '0.500',
        incrementKg: '0.500',
      }),
    ).toBeNull();
  });
});
