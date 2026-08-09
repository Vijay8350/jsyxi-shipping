/**
 * F-24 dead weight of the parcel (§4.2, RV-02) — pure derivation.
 *
 * Numeric policy (§4.1): weights are kg NUMERIC(10,3) — 3 decimal places is
 * exactly integer GRAMS, so all math here is integer-gram bigint math and the
 * stored result is a 3dp decimal string. Never a binary float.
 *
 * The ladder (§4.2 step 1, first hit wins, PER UNIT):
 *   sku_override.weight_kg → order_line.weight_kg_override → Shopify line
 *   weight → 0.000 kg flagged "no weight" (INV-20 — the line is listed, never
 *   silently averaged or guessed).
 * Then (steps 2–4): × quantity, summed; S-7 per-PARCEL fallback only when
 * every line yielded zero; the resolved package profile's tare added ONCE.
 */

/** "1.630" → 1630n grams. Accepts up to 3dp (the NUMERIC(10,3) storage scale). */
export function kgToGrams(value: string): bigint {
  const trimmed = value.trim();
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(trimmed);
  if (!m) throw new Error(`invalid weight value: ${value}`);
  const [, whole, frac = ''] = m;
  return BigInt(whole) * 1000n + BigInt((frac + '000').slice(0, 3));
}

/** 1630n grams → "1.630" (3dp storage form, §4.1). */
export function gramsToKg(grams: bigint): string {
  const whole = grams / 1000n;
  const frac = grams % 1000n;
  return `${whole}.${frac.toString().padStart(3, '0')}`;
}

export type WeightSource = 'SKU_OVERRIDE' | 'LINE_OVERRIDE' | 'SHOPIFY' | 'NONE';

export interface DeadWeightLineInput {
  /** Stable identifier for the "no weight" list (order_line_id). */
  orderLineId: string | null;
  sku: string | null;
  quantity: number;
  /** Per-unit kg NUMERIC text from sku_override.weight_kg (rung 1). */
  skuOverrideWeightKg?: string | null;
  /** Per-unit kg NUMERIC text from order_line.weight_kg_override (rung 2). */
  lineOverrideWeightKg?: string | null;
  /** Per-unit kg NUMERIC text from the Shopify line weight (rung 3). */
  shopifyWeightKg?: string | null;
}

export interface DeadWeightLineResult {
  orderLineId: string | null;
  sku: string | null;
  quantity: number;
  /** Resolved PER-UNIT weight, "0.000" when no rung yielded a value. */
  perUnitWeightKg: string;
  /** perUnit × quantity. */
  lineWeightKg: string;
  source: WeightSource;
  /** INV-20: listed as "no weight" on the ship modal / bulk skipped report. */
  noWeight: boolean;
}

export interface DeadWeightResult {
  /** F-24 = (lineWeightTotal > 0 ? lineWeightTotal : S-7) + tare (§4.2). */
  deadWeightKg: string;
  lineWeightTotalKg: string;
  tareKg: string;
  /** True when S-7 was substituted (§4.2 step 3 — per parcel, never per line). */
  usedDefaultParcelWeight: boolean;
  lines: DeadWeightLineResult[];
}

/** §4.2 step 1: first hit wins; null/blank rungs fall through. */
function resolvePerUnit(line: DeadWeightLineInput): { grams: bigint; source: WeightSource } {
  const rungs: Array<[WeightSource, string | null | undefined]> = [
    ['SKU_OVERRIDE', line.skuOverrideWeightKg],
    ['LINE_OVERRIDE', line.lineOverrideWeightKg],
    ['SHOPIFY', line.shopifyWeightKg],
  ];
  for (const [source, value] of rungs) {
    if (value !== null && value !== undefined && value.trim() !== '') {
      return { grams: kgToGrams(value), source };
    }
  }
  return { grams: 0n, source: 'NONE' };
}

export function deriveDeadWeight(
  lines: DeadWeightLineInput[],
  tareKg: string,
  defaultParcelWeightKg: string,
): DeadWeightResult {
  const results: DeadWeightLineResult[] = lines.map((line) => {
    const { grams, source } = resolvePerUnit(line);
    const lineGrams = grams * BigInt(Math.trunc(line.quantity));
    return {
      orderLineId: line.orderLineId,
      sku: line.sku,
      quantity: line.quantity,
      perUnitWeightKg: gramsToKg(grams),
      lineWeightKg: gramsToKg(lineGrams),
      source,
      noWeight: source === 'NONE',
    };
  });

  // §4.2 step 2: sum across the parcel's lines.
  const lineWeightTotal = results.reduce((acc, l) => acc + kgToGrams(l.lineWeightKg), 0n);

  // §4.2 step 3: S-7 is a per-PARCEL fallback, applied once, only when NO
  // line yielded any weight — never added per line (S-7, §7.1).
  const usedDefaultParcelWeight = lineWeightTotal === 0n;
  const content = usedDefaultParcelWeight ? kgToGrams(defaultParcelWeightKg) : lineWeightTotal;

  // §4.2 step 4: the resolved package profile's tare, ONCE for the parcel
  // (worked example B exists to catch adding it per line).
  const deadWeight = content + kgToGrams(tareKg);

  return {
    deadWeightKg: gramsToKg(deadWeight),
    lineWeightTotalKg: gramsToKg(lineWeightTotal),
    tareKg: gramsToKg(kgToGrams(tareKg)),
    usedDefaultParcelWeight,
    lines: results,
  };
}
