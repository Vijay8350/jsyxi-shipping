import { describe, expect, it } from 'vitest';
import { deriveDeadWeight, gramsToKg, kgToGrams } from '../../src/modules/order-derivation/weight';

/**
 * F-24 dead weight (§4.2, RV-02). The two §15.3 acceptance cases are the
 * worked examples A and B, reproduced EXACTLY: the multi-quantity line and
 * the tare-added-once are the point.
 */
describe('deriveDeadWeight (F-24, §4.2)', () => {
  it('§4.2 worked example A — single line, single unit → 0.420 kg', () => {
    const result = deriveDeadWeight(
      [
        {
          orderLineId: 'l1',
          sku: null,
          quantity: 1,
          shopifyWeightKg: '0.380',
        },
      ],
      '0.040', // "Small box" tare
      '0.500', // S-7 (must NOT be used: the line yielded weight)
    );
    expect(result.lineWeightTotalKg).toBe('0.380');
    expect(result.usedDefaultParcelWeight).toBe(false);
    expect(result.deadWeightKg).toBe('0.420'); // (1 × 0.380) + 0.040 tare, once
    expect(result.lines[0]?.noWeight).toBe(false);
    expect(result.lines[0]?.source).toBe('SHOPIFY');
  });

  it('§4.2 worked example B — multi-line, multi-quantity (RV-02) → 1.630 kg', () => {
    const result = deriveDeadWeight(
      [
        { orderLineId: 'l1', sku: 'TSHIRT-M', quantity: 3, skuOverrideWeightKg: '0.250' },
        { orderLineId: 'l2', sku: 'MUG-01', quantity: 2, shopifyWeightKg: '0.400' },
        { orderLineId: 'l3', sku: 'STICKER', quantity: 1 },
      ],
      '0.080', // "Medium box" tare
      '0.500', // S-7 (must NOT be used: line_weight_total > 0)
    );
    // Per line: 3 × 0.250 = 0.750 · 2 × 0.400 = 0.800 · 1 × 0.000 (flagged).
    expect(result.lines[0]?.lineWeightKg).toBe('0.750');
    expect(result.lines[1]?.lineWeightKg).toBe('0.800');
    expect(result.lines[2]?.lineWeightKg).toBe('0.000');
    expect(result.lineWeightTotalKg).toBe('1.550');
    expect(result.usedDefaultParcelWeight).toBe(false);
    // F-24 = 1.550 + 0.080 tare ONCE — not 3 × tare (the error the example
    // exists to prevent).
    expect(result.deadWeightKg).toBe('1.630');
    // INV-20: the weightless line is flagged, never guessed.
    expect(result.lines[2]?.noWeight).toBe(true);
    expect(result.lines[2]?.source).toBe('NONE');
    expect(result.lines[0]?.noWeight).toBe(false);
  });

  it('S-7 fallback applies ONLY when every line yields zero — once, per parcel (§4.2 step 3)', () => {
    const allZero = deriveDeadWeight(
      [
        { orderLineId: 'l1', sku: 'A', quantity: 2 },
        { orderLineId: 'l2', sku: 'B', quantity: 3 },
      ],
      '0.040',
      '0.500',
    );
    // S-7 substituted ONCE (not per line): 0.500 + 0.040, never 0.500 × lines.
    expect(allZero.usedDefaultParcelWeight).toBe(true);
    expect(allZero.lineWeightTotalKg).toBe('0.000');
    expect(allZero.deadWeightKg).toBe('0.540');
    expect(allZero.lines.every((l) => l.noWeight)).toBe(true);

    // One weighted line anywhere suppresses the fallback entirely.
    const oneWeighted = deriveDeadWeight(
      [
        { orderLineId: 'l1', sku: 'A', quantity: 2 },
        { orderLineId: 'l2', sku: 'B', quantity: 1, shopifyWeightKg: '0.100' },
      ],
      '0.040',
      '0.500',
    );
    expect(oneWeighted.usedDefaultParcelWeight).toBe(false);
    expect(oneWeighted.deadWeightKg).toBe('0.140'); // 0.100 + 0.040
  });

  it('per-unit ladder: sku_override → order_line override → Shopify weight (§4.2 step 1)', () => {
    const result = deriveDeadWeight(
      [
        {
          orderLineId: 'l1',
          sku: 'X',
          quantity: 1,
          skuOverrideWeightKg: '0.111',
          lineOverrideWeightKg: '0.222',
          shopifyWeightKg: '0.333',
        },
        { orderLineId: 'l2', sku: 'Y', quantity: 1, lineOverrideWeightKg: '0.222', shopifyWeightKg: '0.333' },
        { orderLineId: 'l3', sku: 'Z', quantity: 1, shopifyWeightKg: '0.333' },
      ],
      '0.000',
      '0.500',
    );
    expect(result.lines[0]?.perUnitWeightKg).toBe('0.111');
    expect(result.lines[0]?.source).toBe('SKU_OVERRIDE');
    expect(result.lines[1]?.perUnitWeightKg).toBe('0.222');
    expect(result.lines[1]?.source).toBe('LINE_OVERRIDE');
    expect(result.lines[2]?.perUnitWeightKg).toBe('0.333');
    expect(result.lines[2]?.source).toBe('SHOPIFY');
  });

  it('integer-gram math: no binary-float artifacts in stored strings', () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004 — here it must be exact.
    const result = deriveDeadWeight(
      [
        { orderLineId: 'l1', sku: null, quantity: 1, shopifyWeightKg: '0.100' },
        { orderLineId: 'l2', sku: null, quantity: 1, shopifyWeightKg: '0.200' },
      ],
      '0.000',
      '0.500',
    );
    expect(result.deadWeightKg).toBe('0.300');
  });
});

describe('kg/gram conversion (§4.1 NUMERIC(10,3))', () => {
  it('round-trips 3dp kg strings', () => {
    expect(kgToGrams('1.630')).toBe(1630n);
    expect(kgToGrams('0.040')).toBe(40n);
    expect(kgToGrams('2')).toBe(2000n);
    expect(gramsToKg(1630n)).toBe('1.630');
    expect(gramsToKg(0n)).toBe('0.000');
  });

  it('rejects sub-3dp input rather than truncating silently', () => {
    expect(() => kgToGrams('0.0001')).toThrow();
    expect(() => kgToGrams('abc')).toThrow();
  });
});
