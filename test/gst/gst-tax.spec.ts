import { describe, expect, it } from 'vitest';
import {
  computeLineTax,
  computeTotals,
  DEFAULT_GST_RATE,
  financialYearAt,
  financialYearForShopLocal,
  formatInvoiceNumber,
  lineTotalPaise,
  millionthsToRateString,
  taxableValuePaise,
  taxComponentsJson,
} from '../../src/modules/gst/gst-tax';

const IST = 'Asia/Kolkata';

describe('gst-tax: line tax split (§9.9.2 tax model, INV-15)', () => {
  it('splits CGST+SGST when place of supply equals the seller state', () => {
    // ₹1000.00 taxable at 18% → ₹90.00 + ₹90.00.
    const tax = computeLineTax(100_000n, DEFAULT_GST_RATE, true);
    expect(tax).toEqual({ cgst: 9_000n, sgst: 9_000n, igst: 0n });
    const json = taxComponentsJson(tax, DEFAULT_GST_RATE);
    expect(json).toEqual([
      { type: 'CGST', rate: '0.090000', amount: '90.00' },
      { type: 'SGST', rate: '0.090000', amount: '90.00' },
    ]);
  });

  it('levies IGST when place of supply is a different state', () => {
    const tax = computeLineTax(100_000n, DEFAULT_GST_RATE, false);
    expect(tax).toEqual({ cgst: 0n, sgst: 0n, igst: 18_000n });
    expect(taxComponentsJson(tax, DEFAULT_GST_RATE)).toEqual([
      { type: 'IGST', rate: '0.180000', amount: '180.00' },
    ]);
  });

  it('rounds each component half-up to the paise when computed (INV-15)', () => {
    // ₹10.005 is not representable — use ₹33.33 at 18%: IGST = 5.9994 → ₹6.00.
    const igst = computeLineTax(3_333n, DEFAULT_GST_RATE, false);
    expect(igst.igst).toBe(600n);
    // Same-state halves: 9% of 3333 = 299.97 → ₹3.00 each.
    const split = computeLineTax(3_333n, DEFAULT_GST_RATE, true);
    expect(split.cgst).toBe(300n);
    expect(split.sgst).toBe(300n);
  });

  it('keeps odd-millionth halves summing to the full rate', () => {
    // 5% → 2.5% + 2.5%: 25000n is even here; use 2.9% (29000n → 14500+14500)
    // and a genuinely odd rate 0.001% (10n → 5 + 5). 11n → 5 + 6.
    const rate = 11n;
    const tax = computeLineTax(100_000_000n, rate, true);
    const json = taxComponentsJson(tax, rate);
    expect(json[0].rate).toBe('0.000005');
    expect(json[1].rate).toBe('0.000006');
    expect(tax.cgst + tax.sgst).toBe(computeLineTax(100_000_000n, rate, false).igst);
  });

  it('computes taxable value as unit_price × quantity in paise', () => {
    expect(taxableValuePaise('500.00', 2)).toBe(100_000n);
    expect(taxableValuePaise(null, 2)).toBeNull();
  });

  it('line total is taxable + rounded components', () => {
    const tax = computeLineTax(3_333n, DEFAULT_GST_RATE, false);
    expect(lineTotalPaise(3_333n, tax)).toBe(3_933n);
  });
});

describe('gst-tax: totals (INV-15)', () => {
  it('totals are sums of rounded per-line components, never a re-round', () => {
    // Two lines of ₹33.33 at 18% IGST: per-line IGST ₹6.00 each.
    // A re-round of the unrounded total (₹66.66 × 18% = 11.9988 → ₹12.00)
    // would match here, so pick values where they differ: ₹0.05 at 18%.
    // Per line: IGST = round(5 × 0.18) = round(0.9) = 1p. Two lines → 2p.
    // Re-round of total: 10p × 18% = 1.8 → 2p. Use three lines of ₹0.05:
    // per-line 1p × 3 = 3p vs re-round 15 × 0.18 = 2.7 → 3p. Hmm — use
    // ₹0.15 at 18%: per-line round(2.7) = 3p; two lines = 6p vs
    // re-round(30 × 0.18 = 5.4) = 5p → they differ.
    const line = () => ({ taxableValue: 15n, tax: computeLineTax(15n, DEFAULT_GST_RATE, false) });
    const totals = computeTotals([line(), line()]);
    expect(totals.igst).toBe('0.06'); // 3p + 3p — NOT a re-round (which gives ₹0.05)
    expect(totals.taxableValue).toBe('0.30');
    expect(totals.taxTotal).toBe('0.06');
    expect(totals.grandTotal).toBe('0.36');
    expect(totals.cgst).toBe('0.00');
    expect(totals.currency).toBe('INR');
  });

  it('sums CGST and SGST separately across lines', () => {
    const a = { taxableValue: 100_000n, tax: computeLineTax(100_000n, DEFAULT_GST_RATE, true) };
    const b = { taxableValue: 3_333n, tax: computeLineTax(3_333n, DEFAULT_GST_RATE, true) };
    const totals = computeTotals([a, b]);
    expect(totals.cgst).toBe('93.00');
    expect(totals.sgst).toBe('93.00');
    expect(totals.igst).toBe('0.00');
    expect(totals.grandTotal).toBe('1219.33');
  });
});

describe('gst-tax: financial year (§5.2, A1-11)', () => {
  it('runs 1 April – 31 March', () => {
    expect(financialYearForShopLocal(2026, 4)).toBe('2026-27');
    expect(financialYearForShopLocal(2027, 3)).toBe('2026-27');
    expect(financialYearForShopLocal(2027, 1)).toBe('2026-27');
    expect(financialYearForShopLocal(2026, 3)).toBe('2025-26');
  });

  it('boundary: 31 Mar 23:59:59 shop-local is the old FY', () => {
    // 2026-03-31 23:59:59 IST == 18:29:59 UTC.
    expect(financialYearAt(new Date('2026-03-31T18:29:59.000Z'), IST)).toBe('2025-26');
  });

  it('boundary: 1 Apr 00:00:00 shop-local starts the new FY', () => {
    // 2026-04-01 00:00:00 IST == 2026-03-31 18:30:00 UTC.
    expect(financialYearAt(new Date('2026-03-31T18:30:00.000Z'), IST)).toBe('2026-27');
  });

  it('respects the shop timezone, not UTC', () => {
    // Behind UTC: still 31 March locally when UTC has crossed into April.
    expect(financialYearAt(new Date('2026-04-01T03:00:00.000Z'), 'America/New_York')).toBe(
      '2025-26',
    );
  });
});

describe('gst-tax: number format (§13.5)', () => {
  it('formats {series}/{FY}/{seq} zero-padded to 6', () => {
    expect(formatInvoiceNumber('INV', '2026-27', 1)).toBe('INV/2026-27/000001');
    expect(formatInvoiceNumber('INV', '2026-27', 241)).toBe('INV/2026-27/000241');
    expect(formatInvoiceNumber('CN', '2025-26', 1234567)).toBe('CN/2025-26/1234567');
  });

  it('renders rates as 0–1 at 6dp (§4.1)', () => {
    expect(millionthsToRateString(DEFAULT_GST_RATE)).toBe('0.180000');
    expect(millionthsToRateString(90_000n)).toBe('0.090000');
  });
});
