/**
 * Rate-card pricing engine (§4.2–§4.4, §4.8) — pure functions, no Nest deps.
 *
 * Numeric policy (§4.1):
 * - Money is integer paise via src/common/money.ts; every component is rounded
 *   half-up to paise at the moment it is computed and a total is the SUM OF
 *   THE STORED ROUNDED COMPONENTS, never a re-round (INV-15). No floats.
 * - Weights are kg at 3dp = integer grams; dimensions cm at 2dp = integer
 *   hundredths; the volumetric divisor is NUMERIC(12,4) = integer
 *   ten-thousandths. All division is exact integer math.
 * - Zero/null guards (§4.1): a null divisor, null slab, null rate card version
 *   or null zone makes the lane UNPRICEABLE — a typed failure, never ₹0.00.
 *
 * INV-23: nothing here adds a margin — a rate card records the merchant's own
 * contracted price and these functions compute exactly that.
 */

import {
  applyRate,
  ceilDiv,
  divRoundHalfUp,
  paiseToRupees,
  rateToMillionths,
  rupeesToPaise,
  type Paise,
} from '../../common/money';
import {
  gramsToKg,
  kgToGrams,
} from '../order-derivation/weight';
import type { payment_mode } from '../courier-framework/adapter.enum-types';

export type ZoneCode = 'A' | 'B' | 'C' | 'D' | 'E';
export const ZONE_CODES: readonly ZoneCode[] = ['A', 'B', 'C', 'D', 'E'];

export type RtoBasis = 'SAME_AS_FORWARD' | 'PERCENT_OF_FORWARD';

/** §3.31 rate_card_component.basis + PERCENT_OF_DECLARED_VALUE (ADD-41). */
export type ComponentBasis =
  | 'FLAT'
  | 'PERCENT_OF_BASE_FREIGHT'
  | 'PERCENT_OF_PRE_TAX_SUBTOTAL'
  | 'PER_KG_BILLABLE'
  | 'PERCENT_OF_DECLARED_VALUE';

export const COMPONENT_BASES: readonly ComponentBasis[] = [
  'FLAT',
  'PERCENT_OF_BASE_FREIGHT',
  'PERCENT_OF_PRE_TAX_SUBTOTAL',
  'PER_KG_BILLABLE',
  'PERCENT_OF_DECLARED_VALUE',
];

/** §4.1 zero/null guards — the structured reasons a lane is unpriceable. */
export type UnpriceableReason =
  | 'RATE_CARD_MISSING'
  | 'RATE_CARD_VERSION_MISSING'
  | 'SERVICE_VERSION_MISSING'
  | 'DIVISOR_MISSING'
  | 'ORIGIN_MISSING'
  | 'ZONE_NOT_MATCHED'
  | 'SLAB_MISSING';

/* ---------------------------------------------------------------------------
 * §4.2 Weight — F-1, F-2, F-3
 * ------------------------------------------------------------------------- */

/** "30.00" cm -> 3000n hundredths of cm (NUMERIC(10,2) storage scale, §4.1). */
function cmToHundredths(value: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new Error(`invalid dimension value: ${value}`);
  const [, whole, frac = ''] = m;
  return BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
}

/** "5000.0000" -> 50000000n ten-thousandths (NUMERIC(12,4) storage scale). */
function divisorToTenThousandths(value: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(value.trim());
  if (!m) throw new Error(`invalid divisor value: ${value}`);
  const [, whole, frac = ''] = m;
  return BigInt(whole) * 10_000n + BigInt((frac + '0000').slice(0, 4));
}

/**
 * F-1 · Volumetric weight (kg, 3dp) = (L × W × H) ÷ divisor (§4.2).
 * grams = round_half_up(L₂·W₂·H₂·10 ÷ D) where L₂/W₂/H₂ are hundredths of cm
 * and D is the divisor in ten-thousandths — exact integer math.
 * Null divisor → null (§4.1 zero/null guard: unpriceable, never zero).
 */
export function volumetricWeightKg(
  lengthCm: string,
  widthCm: string,
  heightCm: string,
  divisor: string | null,
): string | null {
  if (divisor === null) return null; // §4.1 zero/null guard
  const d = divisorToTenThousandths(divisor);
  if (d <= 0n) return null; // a zero divisor is as unpriceable as a null one
  const product =
    cmToHundredths(lengthCm) * cmToHundredths(widthCm) * cmToHundredths(heightCm);
  return gramsToKg(divRoundHalfUp(product * 10n, d));
}

/** F-2 · Raw chargeable weight = max(F-24 dead, F-1 volumetric) (§4.2). */
export function rawChargeableWeightKg(deadWeightKg: string, volumetricKg: string): string {
  const dead = kgToGrams(deadWeightKg);
  const volumetric = kgToGrams(volumetricKg);
  return gramsToKg(dead > volumetric ? dead : volumetric);
}

/**
 * F-3 · Billable weight = max(min_billable, ceil(F-2 ÷ increment) × increment)
 * (§4.2). All terms are integer grams, so the ceil is exact (ceilDiv).
 * Null minimum/increment → null (§4.1 zero/null guard).
 */
export function billableWeightKg(
  rawChargeableKg: string,
  minBillableKg: string | null,
  incrementKg: string | null,
): string | null {
  if (minBillableKg === null || incrementKg === null) return null; // §4.1
  const increment = kgToGrams(incrementKg);
  if (increment <= 0n) return null;
  const raw = kgToGrams(rawChargeableKg);
  const min = kgToGrams(minBillableKg);
  const stepped = ceilDiv(raw, increment) * increment;
  return gramsToKg(stepped > min ? stepped : min);
}

export interface WeightBreakdown {
  /** F-1, 3dp kg. */
  volumetricWeightKg: string;
  /** F-2, 3dp kg. */
  rawChargeableKg: string;
  /** F-3, 3dp kg. */
  billableWeightKg: string;
}

/**
 * F-1→F-3 pipeline over a service_version's weight terms. Any null term makes
 * the whole chain unpriceable (§4.1), surfaced as `null` here.
 */
export function computeWeights(args: {
  deadWeightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  divisor: string | null;
  minBillableKg: string | null;
  incrementKg: string | null;
}): WeightBreakdown | null {
  const f1 = volumetricWeightKg(args.lengthCm, args.widthCm, args.heightCm, args.divisor);
  if (f1 === null) return null;
  const f2 = rawChargeableWeightKg(args.deadWeightKg, f1);
  const f3 = billableWeightKg(f2, args.minBillableKg, args.incrementKg);
  if (f3 === null) return null;
  return { volumetricWeightKg: f1, rawChargeableKg: f2, billableWeightKg: f3 };
}

/* ---------------------------------------------------------------------------
 * §4.3 Zone — F-4 matcher shape and resolution
 * ------------------------------------------------------------------------- */

/**
 * Matcher JSON shape for commercial_zone_rule.origin_matcher /
 * destination_matcher (§4.3). A matcher is a flat object mapping
 * postal_pincode attribute names to predicates; ALL predicates are ANDed and
 * an empty object `{}` matches every pincode (the catch-all rule).
 *
 *   { "state": "Maharashtra" }                          exact (case-folded, trimmed)
 *   { "state": ["Assam", "Bihar"] }                     list — any exact
 *   { "pincode": { "prefix": "11" } }                   prefix (text attributes)
 *   { "pincode": { "prefix": ["380", "382"] } }         prefix — any of
 *   { "is_metro": true }                                boolean flag
 *
 * Attribute values that are missing in the frozen postal master never match a
 * predicate ("missing data = no match"); only predicates absent from the
 * matcher pass. Anything outside this shape is rejected at write time by
 * `validateMatcher`.
 */
export const MATCHER_ATTRIBUTES = [
  'pincode',
  'city',
  'district',
  'state',
  'region',
  'is_metro',
  'is_special',
] as const;
export type MatcherAttribute = (typeof MATCHER_ATTRIBUTES)[number];

export type MatcherPredicate =
  | string
  | string[]
  | boolean
  | { prefix: string | string[] };

export type ZoneMatcher = Partial<Record<MatcherAttribute, MatcherPredicate>>;

/** Validates an origin/destination matcher against the documented shape. */
export function validateMatcher(value: unknown): value is ZoneMatcher {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const [key, predicate] of Object.entries(value)) {
    if (!(MATCHER_ATTRIBUTES as readonly string[]).includes(key)) return false;
    const flag = key === 'is_metro' || key === 'is_special';
    if (typeof predicate === 'boolean') {
      if (!flag) return false; // booleans only for the two flag attributes
      continue;
    }
    if (flag) return false; // flags take booleans only
    if (typeof predicate === 'string') continue;
    if (Array.isArray(predicate)) {
      if (predicate.length === 0 || !predicate.every((v) => typeof v === 'string')) return false;
      continue;
    }
    if (typeof predicate === 'object' && predicate !== null && !Array.isArray(predicate)) {
      const keys = Object.keys(predicate);
      if (keys.length !== 1 || keys[0] !== 'prefix') return false;
      const p = (predicate as { prefix: unknown }).prefix;
      if (typeof p === 'string') continue;
      if (Array.isArray(p) && p.length > 0 && p.every((v) => typeof v === 'string')) continue;
      return false;
    }
    return false;
  }
  return true;
}

/** The pincode attributes F-4 reads from the FROZEN postal_version_id (A1-05). */
export interface PincodeAttributes {
  pincode: string;
  city: string | null;
  district: string | null;
  state: string | null;
  region: string | null;
  isMetro: boolean | null;
  isSpecial: boolean | null;
}

export interface ZoneRuleInput {
  originMatcher: ZoneMatcher;
  destinationMatcher: ZoneMatcher;
  zone: ZoneCode;
  position: number;
}

function fold(text: string): string {
  return text.trim().toLowerCase();
}

function predicateMatches(
  attribute: MatcherAttribute,
  predicate: MatcherPredicate,
  attrs: PincodeAttributes,
): boolean {
  if (attribute === 'is_metro' || attribute === 'is_special') {
    const actual = attribute === 'is_metro' ? attrs.isMetro : attrs.isSpecial;
    if (actual === null) return false; // missing data = no match
    return actual === predicate;
  }
  const actualRaw: string | null =
    attribute === 'pincode'
      ? attrs.pincode
      : attribute === 'city'
        ? attrs.city
        : attribute === 'district'
          ? attrs.district
          : attribute === 'state'
            ? attrs.state
            : attrs.region;
  if (actualRaw === null) return false; // missing data = no match
  const actual = fold(actualRaw);
  if (typeof predicate === 'string') return actual === fold(predicate);
  if (Array.isArray(predicate)) return predicate.some((v) => actual === fold(v));
  if (typeof predicate !== 'object' || predicate === null) return false; // booleans are flag-only
  const prefixes = Array.isArray(predicate.prefix) ? predicate.prefix : [predicate.prefix];
  return prefixes.some((p: string) => actual.startsWith(fold(p)));
}

/** All predicates ANDed; `{}` matches everything (catch-all). */
export function matcherMatches(matcher: ZoneMatcher, attrs: PincodeAttributes): boolean {
  return (Object.entries(matcher) as Array<[MatcherAttribute, MatcherPredicate]>).every(
    ([attribute, predicate]) => predicateMatches(attribute, predicate, attrs),
  );
}

/**
 * F-4 · Zone resolution (§4.3): rules in position order, first match wins,
 * attributes resolved from the zone map's FROZEN postal_version_id — never
 * the current master (A1-05). `attributes: null` means the pincode is absent
 * from the frozen master: the raw pincode itself still matches, but every
 * attribute predicate fails (missing data = no match).
 * No match → null → the lane is unpriceable (§4.1 zero/null guard), never a
 * guessed zone.
 */
export function resolveZone(
  rules: ZoneRuleInput[],
  origin: { pincode: string; attributes: Omit<PincodeAttributes, 'pincode'> | null },
  destination: { pincode: string; attributes: Omit<PincodeAttributes, 'pincode'> | null },
): ZoneCode | null {
  const originAttrs: PincodeAttributes = {
    pincode: origin.pincode,
    city: origin.attributes?.city ?? null,
    district: origin.attributes?.district ?? null,
    state: origin.attributes?.state ?? null,
    region: origin.attributes?.region ?? null,
    isMetro: origin.attributes?.isMetro ?? null,
    isSpecial: origin.attributes?.isSpecial ?? null,
  };
  const destinationAttrs: PincodeAttributes = {
    pincode: destination.pincode,
    city: destination.attributes?.city ?? null,
    district: destination.attributes?.district ?? null,
    state: destination.attributes?.state ?? null,
    region: destination.attributes?.region ?? null,
    isMetro: destination.attributes?.isMetro ?? null,
    isSpecial: destination.attributes?.isSpecial ?? null,
  };
  const ordered = [...rules].sort((a, b) => a.position - b.position);
  for (const rule of ordered) {
    if (
      matcherMatches(rule.originMatcher, originAttrs) &&
      matcherMatches(rule.destinationMatcher, destinationAttrs)
    ) {
      return rule.zone;
    }
  }
  return null; // §4.1: no match → unpriceable, never a guess
}

/* ---------------------------------------------------------------------------
 * §4.4 Freight components — F-5 … F-11
 * ------------------------------------------------------------------------- */

export interface SlabInput {
  zone: ZoneCode;
  baseWeightKg: string;
  baseRate: string;
  additionalStepKg: string;
  additionalRate: string;
}

export interface ComponentRowInput {
  code: string;
  label: string;
  basis: ComponentBasis;
  /** FLAT / PER_KG_BILLABLE: money (2dp). Percent bases: rate 0–1 (6dp). */
  value: string;
  isTaxable: boolean;
  position: number;
}

/** The rate_card_version terms F-5…F-11 compute over (§2.3, §4.4). */
export interface TariffInput {
  fuelPct: string;
  codFlat: string;
  codPct: string;
  gstPct: string;
  /**
   * §4.4 taxable set: names among 'F-5' | 'F-6' | 'F-7' | 'F-8'. 'F-8' acts as
   * the master switch for surcharge rows — a rate_card_component row is taxed
   * only when 'F-8' is present here AND the row's is_taxable is true, which
   * reproduces the A2-10 default (every component taxable ⇒ F-10 = gst × F-9)
   * and makes removing 'F-8' exempt all surcharges.
   */
  taxableComponents: string[];
  slabs: SlabInput[];
  components: ComponentRowInput[];
}

/** One §8.3 quote component — amount already rounded half-up (INV-15). */
export interface PricedComponent {
  code: string;
  label: string;
  /** 2dp text. */
  amount: string;
  taxable: boolean;
}

export interface FreightBreakdown {
  /** 2dp text each; F-11 is the sum of the rounded components (INV-15). */
  f5BaseFreight: string;
  f6Fuel: string;
  f7Cod: string;
  f8Other: string;
  f9PreTaxSubtotal: string;
  f10Gst: string;
  f11Total: string;
  /** §8.3 line shape: F-5, F-6, F-7, one per F-8 row, then F-10 GST. */
  components: PricedComponent[];
}

export type FreightResult =
  | { priceable: true; breakdown: FreightBreakdown }
  | { priceable: false; reason: UnpriceableReason };

/** F-8 basis evaluation for one surcharge row (§4.4 + ADD-41). */
function surchargeAmount(
  row: ComponentRowInput,
  bases: { f5: Paise; f6: Paise; f7: Paise; billableGrams: bigint; declaredValue: Paise },
): Paise {
  switch (row.basis) {
    case 'FLAT':
      return rupeesToPaise(row.value);
    case 'PERCENT_OF_BASE_FREIGHT':
      return applyRate(bases.f5, rateToMillionths(row.value));
    case 'PERCENT_OF_PRE_TAX_SUBTOTAL':
      // §4.4: the pre-tax subtotal basis is F-5 + F-6 + F-7 (never other F-8
      // rows — that would be recursive).
      return applyRate(bases.f5 + bases.f6 + bases.f7, rateToMillionths(row.value));
    case 'PER_KG_BILLABLE':
      return divRoundHalfUp(rupeesToPaise(row.value) * bases.billableGrams, 1000n);
    case 'PERCENT_OF_DECLARED_VALUE':
      // ADD-41: the insurance surcharge basis.
      return applyRate(bases.declaredValue, rateToMillionths(row.value));
  }
}

/**
 * F-5…F-11 over a resolved zone and billable weight (§4.4). F-23 (§4.8) is
 * this same function with the INVOICED billable weight substituted for F-3.
 * Zero/null guards (§4.1): null zone or missing slab → unpriceable, never a
 * zero price.
 */
export function computeFreight(
  tariff: TariffInput,
  args: {
    zone: ZoneCode | null;
    billableWeightKg: string;
    paymentMode: payment_mode;
    collectible: string;
    declaredValue: string;
  },
): FreightResult {
  if (args.zone === null) {
    return { priceable: false, reason: 'ZONE_NOT_MATCHED' }; // §4.1 guard
  }
  const slab = tariff.slabs.find((s) => s.zone === args.zone) ?? null;
  if (slab === null) {
    return { priceable: false, reason: 'SLAB_MISSING' }; // §4.1 guard
  }

  // F-5 · Base freight = base_rate + ceil additional steps × additional_rate.
  const w = kgToGrams(args.billableWeightKg);
  const baseW = kgToGrams(slab.baseWeightKg);
  const step = kgToGrams(slab.additionalStepKg);
  const additionalSteps = w > baseW ? ceilDiv(w - baseW, step) : 0n;
  const f5 = rupeesToPaise(slab.baseRate) + additionalSteps * rupeesToPaise(slab.additionalRate);

  // F-6 · Fuel = fuel_pct × F-5 (basis is forward freight, A1-05).
  const f6 = applyRate(f5, rateToMillionths(tariff.fuelPct));

  // F-7 · COD = 0 unless COD with a Collectible; else max(flat, pct ×
  // Collectible) — the basis is the Collectible, not the order amount (A1-05).
  const collectiblePaise = rupeesToPaise(args.collectible);
  const f7: Paise =
    args.paymentMode !== 'COD' || collectiblePaise <= 0n
      ? 0n
      : (() => {
          const pct = applyRate(collectiblePaise, rateToMillionths(tariff.codPct));
          const flat = rupeesToPaise(tariff.codFlat);
          return pct > flat ? pct : flat;
        })();

  // F-8 · Other surcharges in position order (RW-19: no rows ⇒ ₹0.00), each
  // rounded individually at compute time (INV-15).
  const declaredValue = rupeesToPaise(args.declaredValue);
  const rows = [...tariff.components].sort((a, b) => a.position - b.position);
  const rowAmounts = rows.map((row) =>
    surchargeAmount(row, { f5, f6, f7, billableGrams: w, declaredValue }),
  );
  const f8 = rowAmounts.reduce((acc, a) => acc + a, 0n);

  // F-9 · Pre-tax subtotal.
  const f9 = f5 + f6 + f7 + f8;

  // F-10 · GST = gst_pct × taxable set (§4.4; see TariffInput for the 'F-8'
  // master-switch reading of taxable_components).
  const taxable = new Set(tariff.taxableComponents);
  const taxF8 = taxable.has('F-8');
  const taxableBase =
    (taxable.has('F-5') ? f5 : 0n) +
    (taxable.has('F-6') ? f6 : 0n) +
    (taxable.has('F-7') ? f7 : 0n) +
    rowAmounts.reduce((acc, a, i) => acc + (taxF8 && rows[i].isTaxable ? a : 0n), 0n);
  const f10 = applyRate(taxableBase, rateToMillionths(tariff.gstPct));

  // F-11 · Total = sum of the stored rounded components (INV-15).
  const f11 = f9 + f10;

  const components: PricedComponent[] = [
    { code: 'F-5', label: 'Base freight', amount: paiseToRupees(f5), taxable: taxable.has('F-5') },
    { code: 'F-6', label: 'Fuel surcharge', amount: paiseToRupees(f6), taxable: taxable.has('F-6') },
    { code: 'F-7', label: 'COD charge', amount: paiseToRupees(f7), taxable: taxable.has('F-7') },
    ...rows.map((row, i) => ({
      code: row.code,
      label: row.label,
      amount: paiseToRupees(rowAmounts[i]),
      taxable: taxF8 && row.isTaxable,
    })),
    { code: 'F-10', label: 'GST', amount: paiseToRupees(f10), taxable: false },
  ];

  return {
    priceable: true,
    breakdown: {
      f5BaseFreight: paiseToRupees(f5),
      f6Fuel: paiseToRupees(f6),
      f7Cod: paiseToRupees(f7),
      f8Other: paiseToRupees(f8),
      f9PreTaxSubtotal: paiseToRupees(f9),
      f10Gst: paiseToRupees(f10),
      f11Total: paiseToRupees(f11),
      components,
    },
  };
}

/**
 * F-23 · Audited freight quote (§4.8): F-5…F-11 recomputed with the INVOICED
 * billable weight substituted for F-3, against the immutable snapshot tariff.
 * This is exactly `computeFreight` — named so reconciliation code states its
 * intent.
 */
export const auditedQuote = computeFreight;

/* ---------------------------------------------------------------------------
 * §4.4 F-12 — RTO charge
 * ------------------------------------------------------------------------- */

/**
 * F-12 (§4.4) result. `NO_EXPECTATION` is the typed "no RTO expectation"
 * outcome: a `charge_type = RTO` invoice row for such an AWB gets flag_review,
 * never a false amount mismatch (§4.4, §4.8).
 */
export type RtoExpectation =
  | {
      kind: 'EXPECTED';
      /** The RTO base (snapshot F-5 or rto_pct × snapshot F-5), 2dp text. */
      rtoBase: string;
      breakdown: FreightBreakdown;
    }
  | { kind: 'NO_EXPECTATION'; reason: 'NO_RTO_RULE' | 'RTO_PCT_MISSING' };

/**
 * F-12 · RTO charge from the booking snapshot (§4.4). `rtoRule` is the
 * snapshot's rate-card version rto terms (rto_basis/rto_pct) or, for a
 * LIVE_QUOTE snapshot, the quote's rto_rule interpreted identically. Fuel,
 * other surcharges and GST apply on the same terms as forward (A2-10); there
 * is no COD component on a return leg. No rto_rule → NO_EXPECTATION.
 */
export function computeRtoExpectation(args: {
  rtoRule: { basis: RtoBasis; pct: string | null } | null;
  snapshot: {
    /** The snapshot's F-5 (2dp text). */
    f5BaseFreight: string;
    /** The snapshot's F-3 (3dp kg). */
    billableWeightKg: string;
    declaredValue: string;
  };
  tariff: Pick<TariffInput, 'fuelPct' | 'gstPct' | 'taxableComponents' | 'components'>;
}): RtoExpectation {
  const { rtoRule } = args;
  if (rtoRule === null) {
    return { kind: 'NO_EXPECTATION', reason: 'NO_RTO_RULE' }; // §4.4 flag_review
  }
  const forwardF5 = rupeesToPaise(args.snapshot.f5BaseFreight);
  let rtoBase: Paise;
  if (rtoRule.basis === 'SAME_AS_FORWARD') {
    rtoBase = forwardF5;
  } else {
    if (rtoRule.pct === null) {
      return { kind: 'NO_EXPECTATION', reason: 'RTO_PCT_MISSING' }; // §4.1 guard
    }
    rtoBase = applyRate(forwardF5, rateToMillionths(rtoRule.pct));
  }

  const fuel = applyRate(rtoBase, rateToMillionths(args.tariff.fuelPct));
  const w = kgToGrams(args.snapshot.billableWeightKg);
  const declaredValue = rupeesToPaise(args.snapshot.declaredValue);

  // Surcharges on the same terms as forward, over the RTO base (A2-10).
  const rows = [...args.tariff.components].sort((a, b) => a.position - b.position);
  const rowAmounts = rows.map((row) =>
    surchargeAmount(row, { f5: rtoBase, f6: fuel, f7: 0n, billableGrams: w, declaredValue }),
  );
  const other = rowAmounts.reduce((acc, a) => acc + a, 0n);
  const subtotal = rtoBase + fuel + other;

  const taxable = new Set(args.tariff.taxableComponents);
  const taxF8 = taxable.has('F-8');
  const taxableBase =
    (taxable.has('F-5') ? rtoBase : 0n) +
    (taxable.has('F-6') ? fuel : 0n) +
    rowAmounts.reduce((acc, a, i) => acc + (taxF8 && rows[i].isTaxable ? a : 0n), 0n);
  const gst = applyRate(taxableBase, rateToMillionths(args.tariff.gstPct));
  const total = subtotal + gst; // INV-15: sum of rounded components

  const components: PricedComponent[] = [
    { code: 'F-12', label: 'RTO base charge', amount: paiseToRupees(rtoBase), taxable: taxable.has('F-5') },
    { code: 'F-6', label: 'Fuel surcharge', amount: paiseToRupees(fuel), taxable: taxable.has('F-6') },
    ...rows.map((row, i) => ({
      code: row.code,
      label: row.label,
      amount: paiseToRupees(rowAmounts[i]),
      taxable: taxF8 && rows[i].isTaxable,
    })),
    { code: 'F-10', label: 'GST', amount: paiseToRupees(gst), taxable: false },
  ];

  return {
    kind: 'EXPECTED',
    rtoBase: paiseToRupees(rtoBase),
    breakdown: {
      f5BaseFreight: paiseToRupees(rtoBase),
      f6Fuel: paiseToRupees(fuel),
      f7Cod: '0.00',
      f8Other: paiseToRupees(other),
      f9PreTaxSubtotal: paiseToRupees(subtotal),
      f10Gst: paiseToRupees(gst),
      f11Total: paiseToRupees(total),
      components,
    },
  };
}
