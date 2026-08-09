import { describe, expect, it } from 'vitest';
import {
  auditedQuote,
  computeFreight,
  type TariffInput,
} from '../../src/modules/rate-engine/pricing';

/**
 * §4.4 worked example (spec.md §4.4, continues example A) and the §4.8 F-23
 * audited-quote example — reproduced to the paise. Zone C slab: first 0.5 kg
 * ₹42.00, each additional 0.5 kg ₹38.00; fuel 18%; COD max(₹35, 2%) on a
 * ₹2,000 Collectible; no component rows; GST 18%, all components taxable.
 */
const WORKED_EXAMPLE_TARIFF: TariffInput = {
  fuelPct: '0.180000',
  codFlat: '35.00',
  codPct: '0.020000',
  gstPct: '0.180000',
  taxableComponents: ['F-5', 'F-6', 'F-7', 'F-8'],
  slabs: [
    {
      zone: 'C',
      baseWeightKg: '0.500',
      baseRate: '42.00',
      additionalStepKg: '0.500',
      additionalRate: '38.00',
    },
  ],
  components: [],
};

const COD_INPUT = {
  zone: 'C' as const,
  paymentMode: 'COD' as const,
  collectible: '2000.00',
  declaredValue: '2000.00',
};

describe('§4.4 worked example — to the paise', () => {
  it('F-5…F-11 at F-3 = 1.000 kg', () => {
    const result = computeFreight(WORKED_EXAMPLE_TARIFF, {
      ...COD_INPUT,
      billableWeightKg: '1.000',
    });
    if (!result.priceable) throw new Error('expected priceable');
    const b = result.breakdown;
    expect(b.f5BaseFreight).toBe('80.00'); // 42.00 + 1 × 38.00
    expect(b.f6Fuel).toBe('14.40'); // 0.18 × 80.00
    expect(b.f7Cod).toBe('40.00'); // max(35.00, 0.02 × 2000)
    expect(b.f8Other).toBe('0.00'); // RW-19: no component rows
    expect(b.f9PreTaxSubtotal).toBe('134.40');
    expect(b.f10Gst).toBe('24.19'); // 0.18 × 134.40 = 24.192 → half-up (INV-15)
    expect(b.f11Total).toBe('158.59'); // sum of rounded components (INV-15)

    // §8.3 line shape: F-5, F-6, F-7, GST with per-component taxable flags.
    expect(b.components).toEqual([
      { code: 'F-5', label: 'Base freight', amount: '80.00', taxable: true },
      { code: 'F-6', label: 'Fuel surcharge', amount: '14.40', taxable: true },
      { code: 'F-7', label: 'COD charge', amount: '40.00', taxable: true },
      { code: 'F-10', label: 'GST', amount: '24.19', taxable: false },
    ]);
  });
});

describe('§4.8 F-23 — audited quote at the invoiced weight', () => {
  it('same card at invoiced 1.500 kg → F-11 ₹211.50 (A1-06 outcome)', () => {
    const result = auditedQuote(WORKED_EXAMPLE_TARIFF, {
      ...COD_INPUT,
      billableWeightKg: '1.500', // the invoiced billable weight
    });
    if (!result.priceable) throw new Error('expected priceable');
    const b = result.breakdown;
    expect(b.f5BaseFreight).toBe('118.00'); // 42.00 + 2 × 38.00
    expect(b.f6Fuel).toBe('21.24');
    expect(b.f7Cod).toBe('40.00');
    expect(b.f9PreTaxSubtotal).toBe('179.24');
    expect(b.f10Gst).toBe('32.26'); // 0.18 × 179.24 = 32.2632 → half-up
    expect(b.f11Total).toBe('211.50');
  });
});

describe('§4.4 F-7 — COD charge guards', () => {
  it('is ₹0.00 for prepaid shipments', () => {
    const result = computeFreight(WORKED_EXAMPLE_TARIFF, {
      ...COD_INPUT,
      paymentMode: 'PREPAID',
      collectible: '0.00',
      billableWeightKg: '1.000',
    });
    if (!result.priceable) throw new Error('expected priceable');
    expect(result.breakdown.f7Cod).toBe('0.00');
  });

  it('is ₹0.00 for COD with a zero Collectible (prepaid docket, §4.7)', () => {
    const result = computeFreight(WORKED_EXAMPLE_TARIFF, {
      ...COD_INPUT,
      collectible: '0.00',
      billableWeightKg: '1.000',
    });
    if (!result.priceable) throw new Error('expected priceable');
    expect(result.breakdown.f7Cod).toBe('0.00');
  });

  it('takes the flat charge when it exceeds the percentage', () => {
    const result = computeFreight(WORKED_EXAMPLE_TARIFF, {
      ...COD_INPUT,
      collectible: '1000.00', // 0.02 × 1000 = 20 < 35 flat
      billableWeightKg: '1.000',
    });
    if (!result.priceable) throw new Error('expected priceable');
    expect(result.breakdown.f7Cod).toBe('35.00');
  });
});

describe('§4.4 F-8 — every basis, incl. PERCENT_OF_DECLARED_VALUE (ADD-41)', () => {
  const tariffWithComponents = (components: TariffInput['components']): TariffInput => ({
    ...WORKED_EXAMPLE_TARIFF,
    components,
  });

  const at1kg = { ...COD_INPUT, billableWeightKg: '1.000' };

  it('FLAT → the value itself', () => {
    const r = computeFreight(
      tariffWithComponents([
        { code: 'HANDLING', label: 'Handling', basis: 'FLAT', value: '10.00', isTaxable: true, position: 1 },
      ]),
      at1kg,
    );
    if (!r.priceable) throw new Error('expected priceable');
    expect(r.breakdown.f8Other).toBe('10.00');
  });

  it('PERCENT_OF_BASE_FREIGHT → value × F-5', () => {
    const r = computeFreight(
      tariffWithComponents([
        { code: 'GREEN', label: 'Green fee', basis: 'PERCENT_OF_BASE_FREIGHT', value: '0.050000', isTaxable: true, position: 1 },
      ]),
      at1kg,
    );
    if (!r.priceable) throw new Error('expected priceable');
    expect(r.breakdown.f8Other).toBe('4.00'); // 0.05 × 80.00
  });

  it('PERCENT_OF_PRE_TAX_SUBTOTAL → value × (F-5 + F-6 + F-7)', () => {
    const r = computeFreight(
      tariffWithComponents([
        { code: 'SUR', label: 'Surcharge', basis: 'PERCENT_OF_PRE_TAX_SUBTOTAL', value: '0.100000', isTaxable: true, position: 1 },
      ]),
      at1kg,
    );
    if (!r.priceable) throw new Error('expected priceable');
    expect(r.breakdown.f8Other).toBe('13.44'); // 0.10 × (80 + 14.40 + 40)
  });

  it('PER_KG_BILLABLE → value × F-3', () => {
    const r = computeFreight(
      tariffWithComponents([
        { code: 'WHT', label: 'Weight fee', basis: 'PER_KG_BILLABLE', value: '5.00', isTaxable: true, position: 1 },
      ]),
      { ...at1kg, billableWeightKg: '2.000' },
    );
    if (!r.priceable) throw new Error('expected priceable');
    expect(r.breakdown.f8Other).toBe('10.00'); // 5.00 × 2.000 kg
  });

  it('PERCENT_OF_DECLARED_VALUE → value × declared value (ADD-41)', () => {
    const r = computeFreight(
      tariffWithComponents([
        { code: 'INS', label: 'Insurance', basis: 'PERCENT_OF_DECLARED_VALUE', value: '0.010000', isTaxable: true, position: 1 },
      ]),
      at1kg,
    );
    if (!r.priceable) throw new Error('expected priceable');
    expect(r.breakdown.f8Other).toBe('20.00'); // 0.01 × 2000.00 declared
    // …and it appears as its own §8.3 component line, in position order.
    expect(r.breakdown.components[3]).toEqual({
      code: 'INS',
      label: 'Insurance',
      amount: '20.00',
      taxable: true,
    });
  });

  it('computes rows in position order regardless of input order', () => {
    const r = computeFreight(
      tariffWithComponents([
        { code: 'B', label: 'Second', basis: 'FLAT', value: '2.00', isTaxable: true, position: 2 },
        { code: 'A', label: 'First', basis: 'FLAT', value: '1.00', isTaxable: true, position: 1 },
      ]),
      at1kg,
    );
    if (!r.priceable) throw new Error('expected priceable');
    const codes = r.breakdown.components.map((c) => c.code);
    expect(codes).toEqual(['F-5', 'F-6', 'F-7', 'A', 'B', 'F-10']);
  });
});

describe('§4.4 F-10 — taxable-set variants', () => {
  const withInsurance: TariffInput = {
    ...WORKED_EXAMPLE_TARIFF,
    components: [
      { code: 'INS', label: 'Insurance', basis: 'FLAT', value: '10.00', isTaxable: true, position: 1 },
    ],
  };
  const at1kg = { ...COD_INPUT, billableWeightKg: '1.000' };

  it('default (all taxable): F-10 = gst × F-9 (A2-10)', () => {
    const r = computeFreight(withInsurance, at1kg);
    if (!r.priceable) throw new Error('expected priceable');
    // F-9 = 144.40; 0.18 × 144.40 = 25.992 → 25.99
    expect(r.breakdown.f9PreTaxSubtotal).toBe('144.40');
    expect(r.breakdown.f10Gst).toBe('25.99');
  });

  it('only F-5 taxable: GST on base freight alone', () => {
    const r = computeFreight(
      { ...withInsurance, taxableComponents: ['F-5'] },
      at1kg,
    );
    if (!r.priceable) throw new Error('expected priceable');
    expect(r.breakdown.f10Gst).toBe('14.40'); // 0.18 × 80.00
    expect(r.breakdown.components.find((c) => c.code === 'F-7')?.taxable).toBe(false);
  });

  it('removing F-8 exempts surcharge rows even when is_taxable = true', () => {
    const r = computeFreight(
      { ...withInsurance, taxableComponents: ['F-5', 'F-6', 'F-7'] },
      at1kg,
    );
    if (!r.priceable) throw new Error('expected priceable');
    // taxable base = 134.40 (no INS); 0.18 × 134.40 = 24.19
    expect(r.breakdown.f10Gst).toBe('24.19');
    expect(r.breakdown.components.find((c) => c.code === 'INS')?.taxable).toBe(false);
  });

  it('is_taxable = false rows stay out of the GST base', () => {
    const r = computeFreight(
      {
        ...WORKED_EXAMPLE_TARIFF,
        components: [
          { code: 'INS', label: 'Insurance', basis: 'FLAT', value: '10.00', isTaxable: false, position: 1 },
        ],
      },
      at1kg,
    );
    if (!r.priceable) throw new Error('expected priceable');
    expect(r.breakdown.f10Gst).toBe('24.19'); // same as no-row example
    expect(r.breakdown.f11Total).toBe('168.59'); // 144.40 + 24.19
  });
});

describe('§4.1 zero/null guards — never a ₹0.00 price', () => {
  const at1kg = { ...COD_INPUT, billableWeightKg: '1.000' };

  it('null zone → ZONE_NOT_MATCHED, unpriceable', () => {
    const r = computeFreight(WORKED_EXAMPLE_TARIFF, { ...at1kg, zone: null });
    expect(r).toEqual({ priceable: false, reason: 'ZONE_NOT_MATCHED' });
  });

  it('missing slab for the resolved zone → SLAB_MISSING, unpriceable', () => {
    const r = computeFreight(WORKED_EXAMPLE_TARIFF, { ...at1kg, zone: 'E' });
    expect(r).toEqual({ priceable: false, reason: 'SLAB_MISSING' });
  });
});
