import {
  applyRate,
  MILLION,
  Millionths,
  Paise,
  paiseToRupees,
  rupeesToPaise,
  sumComponents,
} from '../../common/money';

/**
 * GST invoice arithmetic and numbering (§4.1, §5.2, §13.5, INV-13, INV-15).
 *
 * Tax model (§9.9.2 does not fix rates — documented here as the v1 model):
 *  - Every line carries a GST rate as integer millionths (§4.1 rate storage,
 *    0–1 at 6dp). The default is DEFAULT_GST_RATE (18%); a per-line override
 *    arrives via PATCH /gst/invoices/:id. There is no product tax table.
 *  - taxable_value = unit_price × quantity, integer paise (INV-15).
 *  - Place of supply (destination state) vs seller (pickup location) state:
 *    same state → CGST + SGST at half the rate each; different → IGST at the
 *    full rate. Each component is rounded half-up to the paise at the moment
 *    it is computed (INV-15).
 *  - Totals are sums of the already-rounded per-line components, never a
 *    re-round of an unrounded total (INV-15).
 */

/** The v1 merchant default: 18% (§9.9.2 — no product tax table at v1). */
export const DEFAULT_GST_RATE: Millionths = 180_000n;

/** Per-line tax in paise, each component already rounded (INV-15). */
export interface LineTaxPaise {
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
}

/** A tax component as stored in gst_invoice_line.tax_components (jsonb). */
export interface TaxComponentJson {
  type: 'CGST' | 'SGST' | 'IGST';
  /** 0–1 at 6dp, e.g. '0.090000' (§4.1). */
  rate: string;
  /** Rupees at 2dp, e.g. '14.40' — the rounded paise component (INV-15). */
  amount: string;
}

/** gst_invoice.totals (jsonb) — rupee strings, sums of rounded components. */
export interface InvoiceTotalsJson {
  taxableValue: string;
  cgst: string;
  sgst: string;
  igst: string;
  taxTotal: string;
  grandTotal: string;
  currency: 'INR';
}

/** 180000n -> '0.180000' (§4.1 rate display/storage form). */
export function millionthsToRateString(rate: Millionths): string {
  const whole = rate / MILLION;
  const frac = rate % MILLION;
  return `${whole}.${frac.toString().padStart(6, '0')}`;
}

/**
 * The CGST+SGST vs IGST split. Same-state supply splits the rate in two;
 * an odd millionth goes to SGST so the halves always sum to the full rate.
 */
export function computeLineTax(
  taxableValue: Paise,
  rate: Millionths,
  intraState: boolean,
): LineTaxPaise {
  if (intraState) {
    const half = rate / 2n;
    return {
      cgst: applyRate(taxableValue, half),
      sgst: applyRate(taxableValue, rate - half),
      igst: 0n,
    };
  }
  return { cgst: 0n, sgst: 0n, igst: applyRate(taxableValue, rate) };
}

/** Serialize the paise split for gst_invoice_line.tax_components. */
export function taxComponentsJson(
  tax: LineTaxPaise,
  rate: Millionths,
): TaxComponentJson[] {
  const half = rate / 2n;
  const out: TaxComponentJson[] = [];
  if (tax.cgst > 0n || tax.sgst > 0n) {
    out.push(
      { type: 'CGST', rate: millionthsToRateString(half), amount: paiseToRupees(tax.cgst) },
      { type: 'SGST', rate: millionthsToRateString(rate - half), amount: paiseToRupees(tax.sgst) },
    );
  }
  if (tax.igst > 0n) {
    out.push({ type: 'IGST', rate: millionthsToRateString(rate), amount: paiseToRupees(tax.igst) });
  }
  return out;
}

/** Line total = taxable value + the rounded components (INV-15). */
export function lineTotalPaise(taxableValue: Paise, tax: LineTaxPaise): Paise {
  return sumComponents(taxableValue, tax.cgst, tax.sgst, tax.igst);
}

/**
 * Invoice totals as sums of the stored rounded per-line components (INV-15).
 */
export function computeTotals(
  lines: Array<{ taxableValue: Paise; tax: LineTaxPaise }>,
): InvoiceTotalsJson {
  let taxable = 0n;
  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  for (const l of lines) {
    taxable += l.taxableValue;
    cgst += l.tax.cgst;
    sgst += l.tax.sgst;
    igst += l.tax.igst;
  }
  const taxTotal = sumComponents(cgst, sgst, igst);
  return {
    taxableValue: paiseToRupees(taxable),
    cgst: paiseToRupees(cgst),
    sgst: paiseToRupees(sgst),
    igst: paiseToRupees(igst),
    taxTotal: paiseToRupees(taxTotal),
    grandTotal: paiseToRupees(taxable + taxTotal),
    currency: 'INR',
  };
}

/** taxable_value = unit_price × quantity in paise (INV-15); null when no price. */
export function taxableValuePaise(unitPrice: string | null, quantity: number): Paise | null {
  if (unitPrice === null) return null;
  return rupeesToPaise(unitPrice) * BigInt(quantity);
}

/* ---------------------------------------------------------------------------
 * Financial year (§5.2, A1-11): 1 April – 31 March, derived from the
 * issued-at instant in the Shop's IANA timezone.
 * ------------------------------------------------------------------------- */

/** Shop-local calendar parts of an instant (§5.2 derivation rule). */
export function shopLocalParts(
  now: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** '2026-27' for 1 Apr 2026 – 31 Mar 2027 shop-local (§5.2, A1-11). */
export function financialYearForShopLocal(year: number, month: number): string {
  const start = month >= 4 ? year : year - 1;
  return `${start}-${((start + 1) % 100).toString().padStart(2, '0')}`;
}

/** The financial year an issue instant falls in, shop-local (§5.2). */
export function financialYearAt(now: Date, timeZone: string): string {
  const { year, month } = shopLocalParts(now, timeZone);
  return financialYearForShopLocal(year, month);
}

/** §13.5: `{series}/{FY}/{seq}` zero-padded to 6 — e.g. 'INV/2026-27/000241'. */
export function formatInvoiceNumber(series: string, financialYear: string, seq: number): string {
  return `${series}/${financialYear}/${seq.toString().padStart(6, '0')}`;
}
