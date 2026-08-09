import { kgToGrams } from './weight';

/**
 * F-20 package profile selection (§4.9, A4-03, RV-14) — pure derivation.
 *
 * Ladder, first hit wins:
 *   1. a sku_override.package_profile_id matching ANY shipment line's SKU —
 *      when two lines carry different overrides, the profile with the largest
 *      volume wins (RV-14);
 *   2. the first matching package_selection_rule in position order;
 *   3. the Shop's is_default profile — INV-24 guarantees exactly one, so a
 *      missing default is a data defect and throws, never a silent pick.
 *
 * Rule matching: a rule matches when the parcel's content weight (the F-24
 * line_weight_total, BEFORE tare — tare depends on the profile being
 * selected, so using it would be circular) and item count both fall inside
 * the rule's bounds; a null bound is unbounded. This reading is the week-4
 * derivation choice: package_selection_rule carries only min/max_dead_kg and
 * min/max_items, so those are the match dimensions.
 *
 * Volumes are compared, never stored: L×W×H on NUMERIC(10,2) cm values as
 * integer hundredths-of-cm products (bigint) — no floats anywhere.
 */

export interface PackageProfileInput {
  packageProfileId: string;
  /** NUMERIC(10,2) cm text. */
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  /** NUMERIC(10,3) kg text. */
  tareKg: string;
  isDefault: boolean;
}

export interface PackageRuleInput {
  packageRuleId: string;
  position: number;
  /** NUMERIC(10,3) kg text; null = unbounded. */
  minDeadKg: string | null;
  maxDeadKg: string | null;
  minItems: number | null;
  maxItems: number | null;
  packageProfileId: string;
}

export interface PackageSelectionInput {
  /** SKUs of the parcel's lines (null SKU lines cannot hit rung 1). */
  lineSkus: (string | null)[];
  /** sku_override rows (joined to their profile) that carry a package_profile_id. */
  skuOverrideProfiles: Array<{ sku: string; profile: PackageProfileInput }>;
  /** The shop's package_selection_rule rows; sorted by position internally. */
  rules: PackageRuleInput[];
  /** All of the shop's package_profile rows (rule targets + the default). */
  profiles: PackageProfileInput[];
  /** F-24 line_weight_total (pre-tare), NUMERIC(10,3) kg text. */
  contentWeightKg: string;
  /** Σ shipment_line.quantity. */
  totalItems: number;
}

export type PackageSelectionSource = 'SKU_OVERRIDE' | 'SELECTION_RULE' | 'DEFAULT';

export interface PackageSelectionResult {
  profile: PackageProfileInput;
  source: PackageSelectionSource;
  /** Set when source = SELECTION_RULE. */
  matchedRuleId: string | null;
  /** RV-14: >1 distinct SKU-override profiles were in conflict; largest volume won. */
  conflictResolvedByVolume: boolean;
}

/** "25.00" cm → 2500n hundredths; NUMERIC(10,2) storage scale. */
function cmToHundredths(value: string): bigint {
  const trimmed = value.trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!m) throw new Error(`invalid dimension value: ${value}`);
  const [, whole, frac = ''] = m;
  return BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
}

/** L×W×H in integer hundredths-of-cm cubed — comparison only, never stored. */
function volume(profile: PackageProfileInput): bigint {
  return cmToHundredths(profile.lengthCm) * cmToHundredths(profile.widthCm) * cmToHundredths(profile.heightCm);
}

function ruleMatches(rule: PackageRuleInput, contentGrams: bigint, totalItems: number): boolean {
  if (rule.minDeadKg !== null && contentGrams < kgToGrams(rule.minDeadKg)) return false;
  if (rule.maxDeadKg !== null && contentGrams > kgToGrams(rule.maxDeadKg)) return false;
  if (rule.minItems !== null && totalItems < rule.minItems) return false;
  if (rule.maxItems !== null && totalItems > rule.maxItems) return false;
  return true;
}

export function selectPackageProfile(input: PackageSelectionInput): PackageSelectionResult {
  const skus = new Set(input.lineSkus.filter((s): s is string => s !== null && s !== ''));

  // Rung 1 (§4.9, A4-03): SKU overrides matching any line. RV-14 conflict:
  // distinct profiles → largest volume wins.
  const hits = input.skuOverrideProfiles.filter((o) => skus.has(o.sku));
  if (hits.length > 0) {
    const distinct = new Map(hits.map((h) => [h.profile.packageProfileId, h.profile]));
    let winner: PackageProfileInput | null = null;
    for (const profile of distinct.values()) {
      if (winner === null || volume(profile) > volume(winner)) winner = profile;
    }
    // distinct.size ≥ 1 and volume() only increases strictness, so winner is set.
    return {
      profile: winner as PackageProfileInput,
      source: 'SKU_OVERRIDE',
      matchedRuleId: null,
      conflictResolvedByVolume: distinct.size > 1,
    };
  }

  // Rung 2: first matching package_selection_rule in position order.
  const byId = new Map(input.profiles.map((p) => [p.packageProfileId, p]));
  const contentGrams = kgToGrams(input.contentWeightKg);
  const sorted = [...input.rules].sort((a, b) => a.position - b.position);
  for (const rule of sorted) {
    if (!ruleMatches(rule, contentGrams, input.totalItems)) continue;
    const profile = byId.get(rule.packageProfileId);
    // FK makes a missing target impossible; skip defensively rather than
    // silently matching the wrong profile (INV-20).
    if (!profile) continue;
    return { profile, source: 'SELECTION_RULE', matchedRuleId: rule.packageRuleId, conflictResolvedByVolume: false };
  }

  // Rung 3: the Shop's default — INV-24 guarantees exactly one.
  const defaults = input.profiles.filter((p) => p.isDefault);
  if (defaults.length !== 1) {
    throw new Error(`INV-24 violated: expected exactly one default package profile, found ${defaults.length}`);
  }
  return { profile: defaults[0] as PackageProfileInput, source: 'DEFAULT', matchedRuleId: null, conflictResolvedByVolume: false };
}
