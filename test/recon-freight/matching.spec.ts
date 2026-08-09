import { describe, expect, it } from 'vitest';
import { rupeesToPaise } from '../../src/common/money';
import { amountMismatch, controlTotal, matchGroup } from '../../src/modules/recon-freight/recon-matching';
import {
  MatchGroupInput,
  ShipmentReconView,
  weightMismatch,
} from '../../src/modules/recon-freight/recon-freight.types';
import { TariffInput } from '../../src/modules/rate-engine/pricing';
import { EXAMPLE_TARIFF, exampleSnapshot } from './helpers';

/**
 * §4.8 reconciliation arithmetic — the exhaustive expected_for_charge_type
 * table, the three independent flags, same-type summing, RW-24 adjustment
 * math, and the F-14 control total with the S-19/S-20 thresholds.
 */

const ONE_RUPEE = 100n; // S-27 default ₹1.00
const TEN_GRAMS = 10n; // S-28 default 0.010 kg

function group(overrides: Partial<Parameters<typeof matchGroup>[0]> = {}) {
  const shipment: ShipmentReconView = {
    shipmentId: 'sh-1',
    awbNormalized: 'DL0087412391',
    expectedCostBasis: 'SNAPSHOT_QUOTE',
    providerConfirmedCharge: null,
    snapshot: exampleSnapshot(),
  };
  const base: Parameters<typeof matchGroup>[0] = {
    awbNormalized: 'DL0087412391',
    chargeType: 'FORWARD',
    chargeTypeUnmapped: false,
    invoicedAmountTotal: rupeesToPaise('211.50'),
    adjustmentTotal: 0n,
    shipment,
    freightTolerance: ONE_RUPEE,
    weightToleranceGrams: TEN_GRAMS,
    tariff: EXAMPLE_TARIFF,
    invoicedWeightKg: '1.500',
  };
  return matchGroup({ ...base, ...overrides });
}

describe('§4.8 worked example — the pure weight dispute (A1-06)', () => {
  it('F-23 at the invoiced 1.500 kg is ₹211.50: weight flag true, amount flag false', () => {
    const result = group();
    expect(result.auditedAmount).toBe('211.50'); // F-23 = F-11 at invoiced weight
    expect(result.expectedAmount).toBe('211.50');
    expect(result.flagAmountMismatch).toBe(false); // |211.50 − 211.50| ≤ ₹1.00
    expect(result.flagReview).toBe(false);
    expect(result.flagAwbNotFound).toBe(false);
    // weight flag is per-row: |1.500 − 1.000| = 0.500 > 0.010 → true
    expect(weightMismatch('1.500', '1.000', TEN_GRAMS)).toBe(true);
  });

  it('tolerance boundary: |diff| == ₹1.00 is NOT a mismatch; ₹1.01 is (S-27)', () => {
    expect(group({ invoicedAmountTotal: rupeesToPaise('212.50') }).flagAmountMismatch).toBe(false);
    expect(group({ invoicedAmountTotal: rupeesToPaise('212.51') }).flagAmountMismatch).toBe(true);
  });

  it('weight tolerance boundary: exactly 0.010 kg is NOT a mismatch (S-28)', () => {
    expect(weightMismatch('1.010', '1.000', TEN_GRAMS)).toBe(false);
    expect(weightMismatch('1.011', '1.000', TEN_GRAMS)).toBe(true);
  });
});

describe('§4.8 FORWARD expectation by expected_cost_basis (§3.25)', () => {
  it('PROVIDER_CONFIRMED_CHARGE → the confirmed charge is the expectation', () => {
    const result = group({
      shipment: {
        shipmentId: 'sh-2',
        awbNormalized: 'DL0087412391',
        expectedCostBasis: 'PROVIDER_CONFIRMED_CHARGE',
        providerConfirmedCharge: '95.00',
        snapshot: null,
      },
      invoicedAmountTotal: rupeesToPaise('95.00'),
      tariff: null,
    });
    expect(result.expectedAmount).toBe('95.00');
    expect(result.flagAmountMismatch).toBe(false);
    expect(result.flagReview).toBe(false);
    expect(result.auditedAmount).toBeNull();
  });

  it('PROVIDER_CONFIRMED_CHARGE without a persisted charge → flag_review (INV-20)', () => {
    const result = group({
      shipment: {
        shipmentId: 'sh-2',
        awbNormalized: 'DL0087412391',
        expectedCostBasis: 'PROVIDER_CONFIRMED_CHARGE',
        providerConfirmedCharge: null,
        snapshot: null,
      },
      tariff: null,
    });
    expect(result.expectedAmount).toBeNull();
    expect(result.flagAmountMismatch).toBe(false); // never a false mismatch
    expect(result.flagReview).toBe(true);
  });

  it('NONE → no expectation (expected null, §4.5) + flag_review', () => {
    const result = group({
      shipment: {
        shipmentId: 'sh-3',
        awbNormalized: 'DL0087412391',
        expectedCostBasis: 'NONE',
        providerConfirmedCharge: null,
        snapshot: exampleSnapshot(),
      },
    });
    expect(result.expectedAmount).toBeNull();
    expect(result.flagReview).toBe(true);
    expect(result.flagAmountMismatch).toBe(false);
  });

  it('LIVE_QUOTE snapshot → the frozen quote total (no weight recompute exists)', () => {
    const liveSnapshot = exampleSnapshot({
      rateCardVersionId: null,
      zoneMapId: null,
      expectedQuote: { ...exampleSnapshot().expectedQuote!, costSource: 'LIVE_QUOTE', total: '158.59' },
    });
    const result = group({
      shipment: {
        shipmentId: 'sh-4',
        awbNormalized: 'DL0087412391',
        expectedCostBasis: 'SNAPSHOT_QUOTE',
        providerConfirmedCharge: null,
        snapshot: liveSnapshot,
      },
      invoicedAmountTotal: rupeesToPaise('158.59'),
      tariff: null,
    });
    expect(result.expectedAmount).toBe('158.59');
    expect(result.auditedAmount).toBeNull();
    expect(result.flagAmountMismatch).toBe(false);
  });

  it('an unpriceable sealed card (missing slab) → flag_review, never ₹0 (§4.1)', () => {
    const result = group({ tariff: { ...EXAMPLE_TARIFF, slabs: [] } as TariffInput });
    expect(result.expectedAmount).toBeNull();
    expect(result.flagReview).toBe(true);
  });
});

describe('§4.8 RTO — F-12 recomputed on the invoiced weight', () => {
  const rtoGroup = (overrides: Partial<Parameters<typeof matchGroup>[0]> = {}) =>
    group({ chargeType: 'RTO', invoicedAmountTotal: rupeesToPaise('111.39'), ...overrides });

  it('SAME_AS_FORWARD over snapshot F-5 with fuel + GST (A2-10)', () => {
    // rtoBase = F-5 80.00; fuel 14.40; GST 18% × 94.40 = 16.99 → 111.39.
    const result = rtoGroup();
    expect(result.expectedAmount).toBe('111.39');
    expect(result.flagAmountMismatch).toBe(false);
    expect(result.flagReview).toBe(false);
  });

  it('no rto_rule on the snapshot → no expectation + flag_review (§4.4)', () => {
    const snapshot = exampleSnapshot();
    const result = rtoGroup({
      shipment: {
        shipmentId: 'sh-5',
        awbNormalized: 'DL0087412391',
        expectedCostBasis: 'SNAPSHOT_QUOTE',
        providerConfirmedCharge: null,
        snapshot: { ...snapshot, expectedQuote: { ...snapshot.expectedQuote!, rtoRule: null } },
      },
    });
    expect(result.expectedAmount).toBeNull();
    expect(result.flagReview).toBe(true);
    expect(result.flagAmountMismatch).toBe(false); // never a false mismatch
  });

  it('LIVE_QUOTE PERCENT_OF_FORWARD → pct × frozen quote total', () => {
    const snapshot = exampleSnapshot({ rateCardVersionId: null });
    const result = rtoGroup({
      shipment: {
        shipmentId: 'sh-6',
        awbNormalized: 'DL0087412391',
        expectedCostBasis: 'SNAPSHOT_QUOTE',
        providerConfirmedCharge: null,
        snapshot: {
          ...snapshot,
          expectedQuote: {
            ...snapshot.expectedQuote!,
            costSource: 'LIVE_QUOTE',
            total: '200.00',
            rtoRule: { basis: 'PERCENT_OF_FORWARD', pct: '0.500000' },
          },
        },
      },
      invoicedAmountTotal: rupeesToPaise('100.00'),
      tariff: null,
    });
    expect(result.expectedAmount).toBe('100.00');
    expect(result.flagAmountMismatch).toBe(false);
  });
});

describe('§4.8 COD_FEE / REATTEMPT / OTHER', () => {
  it('COD_FEE → the snapshot F-7', () => {
    const result = group({ chargeType: 'COD_FEE', invoicedAmountTotal: rupeesToPaise('40.00') });
    expect(result.expectedAmount).toBe('40.00');
    expect(result.flagAmountMismatch).toBe(false);
    expect(result.flagReview).toBe(false);
  });

  it('COD_FEE on an unquoted snapshot → flag_review (§4.8)', () => {
    const result = group({
      chargeType: 'COD_FEE',
      shipment: {
        shipmentId: 'sh-7',
        awbNormalized: 'DL0087412391',
        expectedCostBasis: 'NONE',
        providerConfirmedCharge: null,
        snapshot: exampleSnapshot({ expectedQuote: null }),
      },
    });
    expect(result.expectedAmount).toBeNull();
    expect(result.flagReview).toBe(true);
  });

  it.each(['REATTEMPT', 'OTHER'] as const)(
    '%s → no expectation, flag_review, never a false amount mismatch (A2-05)',
    (chargeType) => {
      const result = group({ chargeType, invoicedAmountTotal: rupeesToPaise('999.00') });
      expect(result.expectedAmount).toBeNull();
      expect(result.flagReview).toBe(true);
      expect(result.flagAmountMismatch).toBe(false);
    },
  );

  it('an unmapped courier charge value (stored OTHER) is flag_review (INV-20)', () => {
    const result = group({ chargeType: 'OTHER', chargeTypeUnmapped: true });
    expect(result.flagReview).toBe(true);
    expect(result.flagAmountMismatch).toBe(false);
  });
});

describe('§4.8 group rules', () => {
  it('flag_awb_not_found: no shipment → nothing else computable (INV-20)', () => {
    const result = group({ shipment: null });
    expect(result.flagAwbNotFound).toBe(true);
    expect(result.expectedAmount).toBeNull();
    expect(result.flagAmountMismatch).toBe(false);
  });

  it('same-type rows summed before comparison: 100.00 + 111.50 = 211.50 matches', () => {
    const result = group({ invoicedAmountTotal: rupeesToPaise('100.00') + rupeesToPaise('111.50') });
    expect(result.flagAmountMismatch).toBe(false);
  });

  it('an unparseable (null) group amount → flag_review (INV-20)', () => {
    const result = group({ invoicedAmountTotal: null });
    expect(result.flagReview).toBe(true);
    expect(result.flagAmountMismatch).toBe(false);
  });

  it('a negative amount on a non-ADJUSTMENT row → flag_review (§4.1)', () => {
    const result = group({ invoicedAmountTotal: -5000n });
    expect(result.flagReview).toBe(true);
  });

  it('RW-24: the adjustment sum is added to the invoiced total before comparison', () => {
    // Invoiced 161.50 + adjustment 50.00 = 211.50 → matches the expectation.
    const result = group({
      invoicedAmountTotal: rupeesToPaise('161.50'),
      adjustmentTotal: rupeesToPaise('50.00'),
    });
    expect(result.flagAmountMismatch).toBe(false);
    expect(amountMismatch(rupeesToPaise('161.50'), rupeesToPaise('50.00'), rupeesToPaise('211.50'), ONE_RUPEE)).toBe(false);
    expect(amountMismatch(rupeesToPaise('161.50'), 0n, rupeesToPaise('211.50'), ONE_RUPEE)).toBe(true);
  });
});

describe('F-14 control total (§3.28, A3-05, S-19/S-20)', () => {
  it('§4.8 worked example: ₹1,500 residual vs the ₹1,250 threshold → MISMATCH', () => {
    const result = controlTotal(
      rupeesToPaise('250000.00'), // declared
      rupeesToPaise('247300.00'), // matched
      rupeesToPaise('1200.00'), // review
    );
    expect(result.residual).toBe(150000n); // ₹1,500.00
    expect(result.state).toBe('MISMATCH'); // 1500 > max(100, 1250)
  });

  it('exact boundary: |residual| == threshold is WITHIN_THRESHOLD', () => {
    const result = controlTotal(
      rupeesToPaise('250000.00'),
      rupeesToPaise('248750.00'),
      0n,
    );
    expect(result.residual).toBe(125000n); // ₹1,250.00 == 0.5% × 250000
    expect(result.state).toBe('WITHIN_THRESHOLD');
  });

  it('the ₹100 floor governs small invoices (S-19)', () => {
    // 0.5% × 10,000 = ₹50 < ₹100 floor.
    expect(controlTotal(rupeesToPaise('10000.00'), rupeesToPaise('9900.00'), 0n).state).toBe('WITHIN_THRESHOLD'); // exactly ₹100
    expect(controlTotal(rupeesToPaise('10000.00'), rupeesToPaise('9899.99'), 0n).state).toBe('MISMATCH'); // ₹100.01
  });

  it('a negative residual (invoiced above declared) compares by absolute value', () => {
    expect(controlTotal(rupeesToPaise('10000.00'), rupeesToPaise('10100.01'), 0n).state).toBe('MISMATCH');
  });
});
