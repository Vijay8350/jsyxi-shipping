/**
 * §9.4.4 rule-evaluation core — PURE. No I/O, no Date.now(), no randomness:
 * every input arrives in the EvaluateInput, so the unit tests drive it
 * directly and the persisting service is a thin loader around it.
 *
 * Semantics implemented here (stated once, cited everywhere else):
 *  - Rules evaluate top-down by position; first match wins (§9.4.4).
 *  - Inactive rules and ADD-16 out-of-window rules are skipped, each with
 *    its own trace status.
 *  - ADD-13: within a group conditions are ANDed, between groups ORed, one
 *    level only. An empty group is a catch-all (AND over zero terms = true).
 *  - §3.9: missing data for a condition = NO match, shown in the trace.
 *  - ADD-01…ADD-12 operands resolve exactly as the addendum states (see
 *    OrderFacts); ADD-05 ESTIMATED_FREIGHT, ADD-10 VOLUMETRIC_WEIGHT and
 *    ADD-03 ZONE are CANDIDATE-LEVEL — they never affect group matching
 *    (trace note DEFERRED_TO_CANDIDATES) and instead act as elimination
 *    filters during §4.5 candidate evaluation, each with its own trace
 *    reason. Missing operand there eliminates the candidate (missing data
 *    = no match, applied per candidate).
 *  - ADD-14 MANUAL_ONLY short-circuits BEFORE candidate building.
 *  - ADD-15 excluded_service_ids eliminate BEFORE the action's own rule,
 *    with their own reason.
 *  - §4.5 candidate elimination — one rule per action, never merged
 *    (RV-04): CHEAPEST excludes unpriced (chain fallback "price
 *    unavailable — fell back to chain"), FASTEST excludes missing/stale
 *    EDD (F-18, chain fallback), PRIORITY_CHAIN excludes on NEITHER price
 *    nor EDD — only serviceability moves down the chain. Ties break by the
 *    merchant's priority_tiebreak_order (§9.4.3).
 *  - No rule matches → the S-22 default chain evaluated as PRIORITY_CHAIN
 *    (§9.4.4); unset or exhausted → NO_RULE_AND_NO_DEFAULT_CHAIN (§3.30).
 */

/* --------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------ */

/** §3.8 RULE_ACTION_TYPE + MANUAL_ONLY (ADD-14). */
export type RuleActionType = 'PRIORITY_CHAIN' | 'CHEAPEST' | 'FASTEST' | 'MANUAL_ONLY';

/** §3.9 RULE_CONDITION_FIELD + ADD-01…ADD-12 (mirrors the DB enum). */
export type RuleConditionField =
  | 'WEIGHT'
  | 'ORDER_AMOUNT'
  | 'PAYMENT_MODE'
  | 'PINCODE'
  | 'SKU'
  | 'TAG'
  | 'DEST_STATE'
  | 'DEST_CITY'
  | 'ZONE'
  | 'COD_AMOUNT'
  | 'ESTIMATED_FREIGHT'
  | 'CHECKOUT_SHIPPING_TITLE'
  | 'CHECKOUT_SHIPPING_AMOUNT'
  | 'ITEM_COUNT'
  | 'PRODUCT'
  | 'VENDOR'
  | 'COLLECTION'
  | 'VOLUMETRIC_WEIGHT'
  | 'RISK_FLAG'
  | 'WEEKDAY'
  | 'TIME_OF_DAY';

/** §3.9 OPERATOR + the operators the ADD fields introduce (mirrors the DB enum). */
export type RuleOperator =
  | 'EQUALS'
  | 'BETWEEN'
  | 'GTE'
  | 'LTE'
  | 'IN_LIST'
  | 'NOT_IN_LIST'
  | 'IN_SAVED_ZONE'
  | 'CSV_UPLOAD'
  | 'IS_COD'
  | 'IS_PREPAID'
  | 'CONTAINS'
  | 'IS_HIGH'
  | 'IS_NOT_HIGH';

/**
 * The value_json shape. Which member an operator reads:
 *  - EQUALS / GTE / LTE          → value
 *  - BETWEEN (ranges inclusive, §3.9) → min + max
 *  - IN_LIST / NOT_IN_LIST / CONTAINS → list (CONTAINS uses list[0])
 *  - IN_SAVED_ZONE / CSV_UPLOAD  → pincodes (IN_SAVED_ZONE is inlined from
 *    the saved_zone row by the loader before the core runs; zoneId is the
 *    stored reference at rest)
 *  - IS_COD / IS_PREPAID / IS_HIGH / IS_NOT_HIGH → no operand
 */
export interface ConditionValue {
  value?: string;
  min?: string;
  max?: string;
  list?: string[];
  pincodes?: string[];
  /** IN_SAVED_ZONE: the saved_zone reference stored in value_json. */
  zoneId?: string;
}

export interface ConditionDef {
  field: RuleConditionField;
  operator: RuleOperator;
  value: ConditionValue;
}

/** ADD-13: one level of grouping; conditions AND within, groups OR between. */
export interface ConditionGroupDef {
  position: number;
  conditions: ConditionDef[];
}

export interface RuleDef {
  ruleId: string;
  name: string;
  version: number;
  isActive: boolean;
  position: number;
  actionType: RuleActionType;
  /** ADD-15. */
  excludedServiceIds: string[];
  /** ADD-16 scheduling window (ISO instants); null = unbounded. */
  activeFrom: string | null;
  activeTo: string | null;
  groups: ConditionGroupDef[];
  /** The action's ordered Service chain (PRIORITY_CHAIN order; the
   *  candidate set for CHEAPEST / FASTEST, §9.4.3). */
  actionServiceIds: string[];
}

/**
 * Order-level operands. Every field is null when its data is missing —
 * §3.9's "missing data = no match" is driven by these nulls.
 */
export interface OrderFacts {
  /** F-24 dead weight (WEIGHT, §3.9 A1-03), 3dp kg text. */
  deadWeightKg: string | null;
  /** F-17 (ORDER_AMOUNT), 2dp text. */
  orderAmount: string | null;
  paymentMode: 'PREPAID' | 'COD' | 'UNRESOLVED';
  /** Destination pincode (PINCODE). */
  destinationPincode: string | null;
  /** Per-line SKUs on the Shipment (null entries = line without SKU). */
  skus: (string | null)[];
  /** Union of per-line tags. */
  tags: string[];
  /** ADD-01/ADD-02: from the CURRENT postal zone master, never the
   *  Shopify address string. */
  destState: string | null;
  destCity: string | null;
  /** ADD-04: F-15 order COD outstanding — explicitly NOT F-17. */
  codAmount: string | null;
  /** ADD-06/ADD-07: the order's checkout shipping line. */
  checkoutShippingTitle: string | null;
  checkoutShippingAmount: string | null;
  /** ADD-08: sum of allocated line quantities on the Shipment. */
  itemCount: number | null;
  /** ADD-09: per-line product titles / vendors / collections. */
  products: (string | null)[];
  vendors: (string | null)[];
  collections: (string | null)[];
  /** ADD-11: Shopify risk flag as mirrored per §8.1 ('HIGH' / … / null). */
  riskFlag: string | null;
  // WEEKDAY / TIME_OF_DAY (ADD-12) have no operand here — they derive from
  // `now` in the Shop's timezone (§5.2), computed inside the core.
}

/** The pricing/EDD facts one candidate Service carries into elimination. */
export interface CandidateQuote {
  serviceable: boolean;
  failureReasons: string[];
  rateAvailable: boolean;
  /** F-11 / quote total, 2dp text; null when no usable price. */
  total: string | null;
  eddFrom: string | null;
  eddTo: string | null;
  fetchedAt: string | null;
}

export interface CandidateFacts {
  serviceId: string;
  courierAccountId: string | null;
  costSource: 'RATE_CARD' | 'LIVE_QUOTE' | 'NONE';
  /** The §9.3.2 isBookable gate (only enabled Services are candidates). */
  bookable: boolean;
  /** Structured detail when bookable = false (RV-03). */
  notBookableReason: string | null;
  /** §9.4.3 tie-break for CHEAPEST / FASTEST. */
  priorityTiebreakOrder: number;
  /** Null for COST_SOURCE = NONE Services (§4.5) and for failed quote
   *  calls (quoteError carries the structured note). */
  quote: CandidateQuote | null;
  /** Set when the quote call itself failed (budget/breaker/provider). A
   *  failed quote is NOT a serviceability verdict: it excludes from
   *  CHEAPEST (no usable price) and FASTEST (no usable EDD) but never
   *  from PRIORITY_CHAIN (§4.5, A3-04). */
  quoteError: string | null;
  /** ADD-03: F-4 of origin→destination against THIS candidate's rate-card
   *  zone map; null = unresolved (LIVE_QUOTE Services have no zone map,
   *  §4.3). */
  zone: string | null;
  /** ADD-10: F-1 with THIS candidate's service_version divisor, 3dp kg. */
  volumetricWeightKg: string | null;
}

export interface EvaluateInput {
  /** The evaluation instant (UTC) — injected, never read from the clock. */
  now: Date;
  /** The Shop's IANA timezone (S-2, §5.2) for ADD-12 and ADD-16. */
  shopTimezone: string;
  /** F-18 / S-18 EDD staleness threshold in ms (default 6 h). */
  eddStaleMs: number;
  /** All of the Shop's rules in position order (loader guarantees order). */
  rules: RuleDef[];
  order: OrderFacts;
  /** Facts for every Service any rule action or the S-22 chain references. */
  candidates: CandidateFacts[];
  /** S-22 as ordered service ids; null/empty = unset at day one (RW-22). */
  defaultChainServiceIds: string[] | null;
}

/* ------------------------------- trace ---------------------------------- */

export type RuleTraceStatus =
  | 'MATCHED'
  | 'NO_MATCH'
  | 'SKIPPED_INACTIVE'
  | 'SKIPPED_SCHEDULE' // ADD-16
  | 'NOT_EVALUATED'; // below the first match (first-match-wins, §9.4.4)

export interface ConditionTrace {
  field: RuleConditionField;
  operator: RuleOperator;
  value: ConditionValue;
  /** The resolved operand (null when missing — §3.9 no-match). */
  operand: unknown;
  matched: boolean;
  note: 'OK' | 'MISSING_DATA' | 'DEFERRED_TO_CANDIDATES';
}

export interface GroupTrace {
  position: number;
  matched: boolean;
  conditions: ConditionTrace[];
}

export interface RuleTrace {
  ruleId: string;
  name: string;
  version: number;
  position: number;
  status: RuleTraceStatus;
  groups: GroupTrace[];
}

/** Structured elimination reason codes (§9.4.5, RW-18). */
export type EliminationCode =
  | 'SERVICE_UNKNOWN'
  | 'EXCLUDED_BY_RULE' // ADD-15
  | 'NOT_BOOKABLE' // §9.3.2 isBookable gate
  | 'NOT_SERVICEABLE' // quote.serviceable = false
  | 'ZONE_FILTERED' // ADD-03
  | 'ESTIMATED_FREIGHT_FILTERED' // ADD-05
  | 'VOLUMETRIC_WEIGHT_FILTERED' // ADD-10
  | 'PRICE_UNAVAILABLE' // §4.5 CHEAPEST (incl. quote failure, NONE source)
  | 'EDD_MISSING' // F-18 / §4.5 FASTEST
  | 'EDD_STALE'; // F-18 / §4.5 FASTEST

export interface EliminationReason {
  code: EliminationCode;
  detail: string;
}

export interface CandidateResult {
  serviceId: string;
  costSource: CandidateFacts['costSource'] | null;
  cost: string | null;
  eddFrom: string | null;
  eddTo: string | null;
  quoteFetchedAt: string | null;
  zone: string | null;
  volumetricWeightKg: string | null;
  eliminated: boolean;
  reasons: EliminationReason[];
  selected: boolean;
}

/** §3.30 MANUAL_ASSIGNMENT_REASON (routing-produced subset). */
export type ManualAssignmentReason =
  | 'HELD_BY_RULE' // ADD-14
  | 'CHAIN_EXHAUSTED'
  | 'NO_SERVICEABLE_CANDIDATE'
  | 'NO_RULE_AND_NO_DEFAULT_CHAIN';

export interface FallbackChainTrace {
  kind: 'S22_DEFAULT_CHAIN' | 'CHAIN_FALLBACK';
  /** e.g. "price unavailable — fell back to chain" (§4.5, A2-12). */
  note: string;
  serviceIds: string[];
}

export type EvaluationOutcome =
  | { kind: 'SELECTED'; serviceId: string }
  | { kind: 'MANUAL_ASSIGNMENT'; reason: ManualAssignmentReason };

export interface EvaluationResult {
  matchedRuleId: string | null;
  matchedRuleVersion: number | null;
  ruleTraces: RuleTrace[];
  candidateResults: CandidateResult[];
  selectedServiceId: string | null;
  fallbackChain: FallbackChainTrace | null;
  outcome: EvaluationOutcome;
}

/* --------------------------------------------------------------------------
 * Decimal compare (§4.1 — no floats for money; weights/dims share the path)
 * ------------------------------------------------------------------------ */

const DECIMAL_SCALE = 1_000_000n; // 6dp — covers money 4dp storage and kg 3dp

/** "1234.5678" → scaled bigint at 6dp; null when unparsable. */
export function parseDecimal(value: string): bigint | null {
  const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!m) return null;
  const frac = (m[3] ?? '').padEnd(6, '0');
  const n = BigInt(m[2]) * DECIMAL_SCALE + BigInt(frac);
  return m[1] === '-' ? -n : n;
}

/** -1 / 0 / 1; null when either side is unparsable. */
export function cmpDecimal(a: string, b: string): number | null {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  if (x === null || y === null) return null;
  return x < y ? -1 : x > y ? 1 : 0;
}

/* --------------------------------------------------------------------------
 * Shop-local time (§5.2, ADD-12, ADD-16)
 * ------------------------------------------------------------------------ */

export type WeekdayCode = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';

const WEEKDAY_FROM_SHORT: Record<string, WeekdayCode> = {
  mon: 'MON',
  tue: 'TUE',
  wed: 'WED',
  thu: 'THU',
  fri: 'FRI',
  sat: 'SAT',
  sun: 'SUN',
};

/** The instant's weekday and minutes-since-midnight in the Shop's IANA tz. */
export function shopLocalParts(
  now: Date,
  timeZone: string,
): { weekday: WeekdayCode; minutesOfDay: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  let weekday: WeekdayCode = 'MON';
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === 'weekday') weekday = WEEKDAY_FROM_SHORT[p.value.toLowerCase()] ?? 'MON';
    else if (p.type === 'hour') hour = Number(p.value) % 24;
    else if (p.type === 'minute') minute = Number(p.value);
  }
  return { weekday, minutesOfDay: hour * 60 + minute };
}

/** Accepts 'MON'…'SUN', full names, or ISO 1–7 (Monday = 1, §5.2). */
export function normalizeWeekday(value: string): WeekdayCode | null {
  const v = value.trim().toUpperCase();
  const short = v.slice(0, 3).toLowerCase();
  if (short in WEEKDAY_FROM_SHORT) {
    return WEEKDAY_FROM_SHORT[short];
  }
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1 && n <= 7) {
    return (['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as WeekdayCode[])[n - 1];
  }
  return null;
}

/** 'HH:MM' (24h) → minutes since midnight; null when unparsable. */
export function parseTimeOfDay(value: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/* --------------------------------------------------------------------------
 * Condition matching (§3.9 + ADD-01…ADD-12)
 * ------------------------------------------------------------------------ */

/** ADD-05 / ADD-10 / ADD-03: per-candidate fields — never order-level. */
export const CANDIDATE_LEVEL_FIELDS: ReadonlySet<RuleConditionField> = new Set([
  'ESTIMATED_FREIGHT',
  'VOLUMETRIC_WEIGHT',
  'ZONE',
]);

/** ADD-01/02 normalization: trim + case-fold (postal master values too). */
function fold(value: string): string {
  return value.trim().toLowerCase();
}

interface ConditionOutcome {
  matched: boolean;
  operand: unknown;
  note: ConditionTrace['note'];
}

const MISSING: ConditionOutcome = { matched: false, operand: null, note: 'MISSING_DATA' };

/** Numeric comparisons (EQUALS / BETWEEN inclusive / GTE / LTE, §3.9). */
function numericMatch(operator: RuleOperator, operand: string, value: ConditionValue): boolean | null {
  switch (operator) {
    case 'EQUALS': {
      if (value.value === undefined) return null;
      const c = cmpDecimal(operand, value.value);
      return c === null ? null : c === 0;
    }
    case 'BETWEEN': {
      if (value.min === undefined || value.max === undefined) return null;
      const lo = cmpDecimal(operand, value.min);
      const hi = cmpDecimal(operand, value.max);
      return lo === null || hi === null ? null : lo >= 0 && hi <= 0;
    }
    case 'GTE': {
      if (value.value === undefined) return null;
      const c = cmpDecimal(operand, value.value);
      return c === null ? null : c >= 0;
    }
    case 'LTE': {
      if (value.value === undefined) return null;
      const c = cmpDecimal(operand, value.value);
      return c === null ? null : c <= 0;
    }
    default:
      return null;
  }
}

/** §3.9 SKU/TAG semantics (ADD-09 reuses them): IN_LIST = ANY line matches;
 *  NOT_IN_LIST = NO present line matches, and all-missing data = no match. */
function anyNoneMatch(
  operator: RuleOperator,
  values: (string | null)[],
  list: string[],
  caseFold: boolean,
): boolean | null {
  const wanted = new Set(list.map((v) => (caseFold ? fold(v) : v.trim())));
  const present = values
    .filter((v): v is string => v !== null && v.trim() !== '')
    .map((v) => (caseFold ? fold(v) : v.trim()));
  if (present.length === 0) return null; // missing data = no match (§3.9)
  const anyHit = present.some((v) => wanted.has(v));
  return operator === 'IN_LIST' ? anyHit : !anyHit;
}

function evalCondition(
  cond: ConditionDef,
  order: OrderFacts,
  local: { weekday: WeekdayCode; minutesOfDay: number },
): ConditionOutcome {
  const { field, operator, value } = cond;

  // ADD-05 / ADD-10 / ADD-03: decided per candidate during §4.5 elimination.
  if (CANDIDATE_LEVEL_FIELDS.has(field)) {
    return { matched: true, operand: null, note: 'DEFERRED_TO_CANDIDATES' };
  }

  const list = value.list ?? [];

  switch (field) {
    case 'WEIGHT': {
      if (order.deadWeightKg === null) return MISSING;
      const m = numericMatch(operator, order.deadWeightKg, value);
      return m === null ? MISSING : { matched: m, operand: order.deadWeightKg, note: 'OK' };
    }
    case 'ORDER_AMOUNT': {
      if (order.orderAmount === null) return MISSING;
      const m = numericMatch(operator, order.orderAmount, value);
      return m === null ? MISSING : { matched: m, operand: order.orderAmount, note: 'OK' };
    }
    case 'COD_AMOUNT': {
      // ADD-04: F-15, explicitly distinct from ORDER_AMOUNT (F-17).
      if (order.codAmount === null) return MISSING;
      const m = numericMatch(operator, order.codAmount, value);
      return m === null ? MISSING : { matched: m, operand: order.codAmount, note: 'OK' };
    }
    case 'CHECKOUT_SHIPPING_AMOUNT': {
      if (order.checkoutShippingAmount === null) return MISSING;
      const m = numericMatch(operator, order.checkoutShippingAmount, value);
      return m === null
        ? MISSING
        : { matched: m, operand: order.checkoutShippingAmount, note: 'OK' };
    }
    case 'ITEM_COUNT': {
      if (order.itemCount === null) return MISSING;
      const m = numericMatch(operator, String(order.itemCount), value);
      return m === null ? MISSING : { matched: m, operand: order.itemCount, note: 'OK' };
    }
    case 'PAYMENT_MODE': {
      if (operator === 'IS_COD') {
        return { matched: order.paymentMode === 'COD', operand: order.paymentMode, note: 'OK' };
      }
      if (operator === 'IS_PREPAID') {
        return { matched: order.paymentMode === 'PREPAID', operand: order.paymentMode, note: 'OK' };
      }
      return MISSING;
    }
    case 'PINCODE': {
      if (order.destinationPincode === null) return MISSING;
      const set = new Set(
        (operator === 'IN_SAVED_ZONE' || operator === 'CSV_UPLOAD'
          ? (value.pincodes ?? [])
          : list
        ).map((p) => p.trim()),
      );
      const inside = set.has(order.destinationPincode);
      const matched =
        operator === 'NOT_IN_LIST' ? !inside : operator === 'IN_LIST' || operator === 'IN_SAVED_ZONE' || operator === 'CSV_UPLOAD' ? inside : false;
      return { matched, operand: order.destinationPincode, note: 'OK' };
    }
    case 'SKU':
    case 'PRODUCT':
    case 'VENDOR':
    case 'COLLECTION': {
      const values =
        field === 'SKU'
          ? order.skus
          : field === 'PRODUCT'
            ? order.products
            : field === 'VENDOR'
              ? order.vendors
              : order.collections;
      const m = anyNoneMatch(operator, values, list, false);
      return m === null ? MISSING : { matched: m, operand: values, note: 'OK' };
    }
    case 'TAG': {
      const m = anyNoneMatch(operator, order.tags, list, false);
      return m === null ? MISSING : { matched: m, operand: order.tags, note: 'OK' };
    }
    case 'DEST_STATE':
    case 'DEST_CITY': {
      // ADD-01/02: the postal-master value, compared case-folded.
      const operand = field === 'DEST_STATE' ? order.destState : order.destCity;
      if (operand === null) return MISSING;
      const wanted = new Set(list.map(fold));
      const inside = wanted.has(fold(operand));
      const matched = operator === 'NOT_IN_LIST' ? !inside : inside;
      return { matched, operand, note: 'OK' };
    }
    case 'CHECKOUT_SHIPPING_TITLE': {
      if (order.checkoutShippingTitle === null) return MISSING;
      if (operator === 'CONTAINS') {
        const needle = fold(list[0] ?? value.value ?? '');
        if (needle === '') return MISSING;
        return {
          matched: fold(order.checkoutShippingTitle).includes(needle),
          operand: order.checkoutShippingTitle,
          note: 'OK',
        };
      }
      const wanted = new Set(list.map(fold));
      const inside = wanted.has(fold(order.checkoutShippingTitle));
      return {
        matched: operator === 'NOT_IN_LIST' ? !inside : inside,
        operand: order.checkoutShippingTitle,
        note: 'OK',
      };
    }
    case 'RISK_FLAG': {
      // ADD-11: 'HIGH' is Shopify's high-risk value (§8.1 mirror).
      if (order.riskFlag === null || order.riskFlag.trim() === '') return MISSING;
      const high = order.riskFlag.trim().toUpperCase() === 'HIGH';
      return {
        matched: operator === 'IS_HIGH' ? high : !high,
        operand: order.riskFlag,
        note: 'OK',
      };
    }
    case 'WEEKDAY': {
      // ADD-12: shop-local weekday (§5.2).
      const wanted = new Set(
        list.map(normalizeWeekday).filter((w): w is WeekdayCode => w !== null),
      );
      if (wanted.size === 0) return MISSING;
      return { matched: wanted.has(local.weekday), operand: local.weekday, note: 'OK' };
    }
    case 'TIME_OF_DAY': {
      // ADD-12: shop-local wall time, BETWEEN inclusive; supports overnight
      // windows (min > max wraps past midnight).
      if (operator !== 'BETWEEN' || value.min === undefined || value.max === undefined) {
        return MISSING;
      }
      const lo = parseTimeOfDay(value.min);
      const hi = parseTimeOfDay(value.max);
      if (lo === null || hi === null) return MISSING;
      const t = local.minutesOfDay;
      const matched = lo <= hi ? t >= lo && t <= hi : t >= lo || t <= hi;
      return {
        matched,
        operand: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`,
        note: 'OK',
      };
    }
    default:
      return MISSING;
  }
}

/* --------------------------------------------------------------------------
 * Candidate-level filters (ADD-03 / ADD-05 / ADD-10)
 * ------------------------------------------------------------------------ */

interface CandidateFilters {
  zone: { operator: 'IN_LIST' | 'NOT_IN_LIST'; list: string[] } | null;
  freight: ConditionDef | null;
  volumetric: ConditionDef | null;
}

function collectCandidateFilters(rule: RuleDef): CandidateFilters {
  const filters: CandidateFilters = { zone: null, freight: null, volumetric: null };
  for (const group of rule.groups) {
    for (const cond of group.conditions) {
      if (cond.field === 'ZONE' && !filters.zone) {
        filters.zone = {
          operator: cond.operator === 'NOT_IN_LIST' ? 'NOT_IN_LIST' : 'IN_LIST',
          list: (cond.value.list ?? []).map((z) => z.trim().toUpperCase()),
        };
      } else if (cond.field === 'ESTIMATED_FREIGHT' && !filters.freight) {
        filters.freight = cond;
      } else if (cond.field === 'VOLUMETRIC_WEIGHT' && !filters.volumetric) {
        filters.volumetric = cond;
      }
    }
  }
  return filters;
}

/**
 * The ADD-03/05/10 filter pass. Missing operand = the candidate does not
 * satisfy the filter (§3.9 missing-data rule applied per candidate) — the
 * reason detail says the operand was unresolvable.
 */
function candidateFilterReasons(
  facts: CandidateFacts,
  filters: CandidateFilters,
): EliminationReason[] {
  const reasons: EliminationReason[] = [];
  if (filters.zone) {
    if (facts.zone === null) {
      reasons.push({
        code: 'ZONE_FILTERED',
        detail: 'zone unresolved for this candidate (no matching zone-map rule)',
      });
    } else {
      const inside = filters.zone.list.includes(facts.zone.toUpperCase());
      const ok = filters.zone.operator === 'IN_LIST' ? inside : !inside;
      if (!ok) {
        reasons.push({
          code: 'ZONE_FILTERED',
          detail: `zone ${facts.zone} fails ${filters.zone.operator} [${filters.zone.list.join(', ')}]`,
        });
      }
    }
  }
  if (filters.freight) {
    const total = facts.quote && facts.quote.rateAvailable ? facts.quote.total : null;
    if (total === null) {
      reasons.push({
        code: 'ESTIMATED_FREIGHT_FILTERED',
        detail: 'no usable price — filter operand unresolvable',
      });
    } else {
      const m = numericMatch(filters.freight.operator, total, filters.freight.value);
      if (m !== true) {
        reasons.push({
          code: 'ESTIMATED_FREIGHT_FILTERED',
          detail: `freight ${total} fails ${filters.freight.operator}`,
        });
      }
    }
  }
  if (filters.volumetric) {
    if (facts.volumetricWeightKg === null) {
      reasons.push({
        code: 'VOLUMETRIC_WEIGHT_FILTERED',
        detail: 'volumetric weight unresolvable (missing divisor/dimensions)',
      });
    } else {
      const m = numericMatch(
        filters.volumetric.operator,
        facts.volumetricWeightKg,
        filters.volumetric.value,
      );
      if (m !== true) {
        reasons.push({
          code: 'VOLUMETRIC_WEIGHT_FILTERED',
          detail: `volumetric ${facts.volumetricWeightKg} kg fails ${filters.volumetric.operator}`,
        });
      }
    }
  }
  return reasons;
}

/* --------------------------------------------------------------------------
 * The evaluation
 * ------------------------------------------------------------------------ */

/** ADD-16: outside [activeFrom, activeTo) the rule is skipped like an
 *  inactive rule. Bounds are instants; the window is authored and read in
 *  shop-local time (from inclusive, to exclusive). */
function outsideSchedule(rule: RuleDef, now: Date): boolean {
  const t = now.getTime();
  if (rule.activeFrom !== null && t < Date.parse(rule.activeFrom)) return true;
  if (rule.activeTo !== null && t >= Date.parse(rule.activeTo)) return true;
  return false;
}

interface RunCandidate {
  facts: CandidateFacts | null;
  result: CandidateResult;
  chainPosition: number;
}

export function evaluate(input: EvaluateInput): EvaluationResult {
  const local = shopLocalParts(input.now, input.shopTimezone);
  const factsByService = new Map(input.candidates.map((c) => [c.serviceId, c]));
  const candidateResults = new Map<string, CandidateResult>();

  const resultFor = (serviceId: string): CandidateResult => {
    const existing = candidateResults.get(serviceId);
    if (existing) return existing;
    const facts = factsByService.get(serviceId) ?? null;
    const created: CandidateResult = {
      serviceId,
      costSource: facts?.costSource ?? null,
      cost: facts?.quote && facts.quote.rateAvailable ? facts.quote.total : null,
      eddFrom: facts?.quote?.eddFrom ?? null,
      eddTo: facts?.quote?.eddTo ?? null,
      quoteFetchedAt: facts?.quote?.fetchedAt ?? null,
      zone: facts?.zone ?? null,
      volumetricWeightKg: facts?.volumetricWeightKg ?? null,
      eliminated: false,
      reasons: [],
      selected: false,
    };
    candidateResults.set(serviceId, created);
    return created;
  };

  /* ---- 1. rule scan: top-down, first match wins (§9.4.4) ---- */
  const ruleTraces: RuleTrace[] = [];
  let matched: RuleDef | null = null;
  for (const rule of input.rules) {
    const base = {
      ruleId: rule.ruleId,
      name: rule.name,
      version: rule.version,
      position: rule.position,
    };
    if (matched) {
      ruleTraces.push({ ...base, status: 'NOT_EVALUATED', groups: [] });
      continue;
    }
    if (!rule.isActive) {
      ruleTraces.push({ ...base, status: 'SKIPPED_INACTIVE', groups: [] });
      continue;
    }
    if (outsideSchedule(rule, input.now)) {
      ruleTraces.push({ ...base, status: 'SKIPPED_SCHEDULE', groups: [] });
      continue;
    }
    const groups: GroupTrace[] = rule.groups.map((g) => {
      const conditions = g.conditions.map((c) => {
        const out = evalCondition(c, input.order, local);
        return {
          field: c.field,
          operator: c.operator,
          value: c.value,
          operand: out.operand,
          matched: out.matched,
          note: out.note,
        };
      });
      // ADD-13: AND within a group; an empty group is a catch-all.
      return { position: g.position, matched: conditions.every((c) => c.matched), conditions };
    });
    const isMatch = groups.some((g) => g.matched); // ADD-13: OR between groups
    ruleTraces.push({ ...base, status: isMatch ? 'MATCHED' : 'NO_MATCH', groups });
    if (isMatch) matched = rule;
  }

  const done = (
    outcome: EvaluationOutcome,
    fallbackChain: FallbackChainTrace | null,
  ): EvaluationResult => ({
    matchedRuleId: matched?.ruleId ?? null,
    matchedRuleVersion: matched?.version ?? null,
    ruleTraces,
    candidateResults: [...candidateResults.values()],
    selectedServiceId: outcome.kind === 'SELECTED' ? outcome.serviceId : null,
    fallbackChain,
    outcome,
  });

  /* ---- 2. ADD-14: MANUAL_ONLY short-circuits BEFORE candidate building ---- */
  if (matched && matched.actionType === 'MANUAL_ONLY') {
    return done({ kind: 'MANUAL_ASSIGNMENT', reason: 'HELD_BY_RULE' }, null);
  }

  /* ---- candidate-set construction (shared by every action + the chains) -- */
  const buildRun = (
    serviceIds: string[],
    opts: { excluded: Set<string>; filters: CandidateFilters | null },
  ): RunCandidate[] =>
    serviceIds.map((serviceId, chainPosition) => {
      const facts = factsByService.get(serviceId) ?? null;
      const result = resultFor(serviceId);
      if (!facts) {
        result.reasons.push({ code: 'SERVICE_UNKNOWN', detail: 'no merchant service row' });
      } else {
        // ADD-15: exclusions eliminate BEFORE the action's own rule.
        if (opts.excluded.has(serviceId)) {
          result.reasons.push({ code: 'EXCLUDED_BY_RULE', detail: 'in rule excluded_service_ids' });
        }
        // §9.3.2: only enabled Services are candidates.
        if (!facts.bookable) {
          result.reasons.push({
            code: 'NOT_BOOKABLE',
            detail: facts.notBookableReason ?? 'merchant service not enabled',
          });
        }
        if (opts.filters) {
          result.reasons.push(...candidateFilterReasons(facts, opts.filters));
        }
      }
      result.eliminated = result.reasons.length > 0;
      return { facts, result, chainPosition };
    });

  const usablePrice = (c: RunCandidate): boolean =>
    c.facts !== null &&
    c.facts.costSource !== 'NONE' &&
    c.facts.quote !== null &&
    c.facts.quote.rateAvailable &&
    c.facts.quote.total !== null;

  const eddState = (c: RunCandidate): 'USABLE' | 'MISSING' | 'STALE' => {
    const q = c.facts?.quote ?? null;
    if (!q || q.eddTo === null || q.fetchedAt === null) return 'MISSING';
    // F-18: stale when now − fetched_at > S-18.
    return input.now.getTime() - Date.parse(q.fetchedAt) > input.eddStaleMs ? 'STALE' : 'USABLE';
  };

  const serviceable = (c: RunCandidate): boolean =>
    c.facts !== null && (c.facts.quote === null || c.facts.quote.serviceable);

  /** §4.5 PRIORITY_CHAIN: price and EDD NEVER eliminate (A3-04); only a
   *  serviceability failure (or a booking failure, which happens after
   *  evaluation) moves down the chain. */
  const runPriorityChain = (run: RunCandidate[]): RunCandidate | null => {
    for (const c of run) {
      if (c.result.eliminated) continue;
      if (!serviceable(c)) {
        c.result.reasons.push({
          code: 'NOT_SERVICEABLE',
          detail: (c.facts?.quote?.failureReasons ?? []).join('; ') || 'lane not serviceable',
        });
        c.result.eliminated = true;
        continue;
      }
      c.result.selected = true;
      return c;
    }
    return null;
  };

  /** The S-22 default chain, evaluated as PRIORITY_CHAIN (§9.4.4). ADD-15
   *  exclusions belong to the matched rule and do NOT apply here. */
  const runDefaultChain = (note: string, kind: FallbackChainTrace['kind']): EvaluationResult => {
    const chainIds = input.defaultChainServiceIds ?? [];
    if (chainIds.length === 0) {
      return done(
        {
          kind: 'MANUAL_ASSIGNMENT',
          reason: matched ? 'NO_SERVICEABLE_CANDIDATE' : 'NO_RULE_AND_NO_DEFAULT_CHAIN',
        },
        { kind, note: `${note}; S-22 unset`, serviceIds: [] },
      );
    }
    const run = buildRun(chainIds, { excluded: new Set(), filters: null });
    const picked = runPriorityChain(run);
    const fallback: FallbackChainTrace = { kind, note, serviceIds: chainIds };
    if (!picked) {
      return done(
        {
          kind: 'MANUAL_ASSIGNMENT',
          reason: matched ? 'NO_SERVICEABLE_CANDIDATE' : 'NO_RULE_AND_NO_DEFAULT_CHAIN',
        },
        fallback,
      );
    }
    return done({ kind: 'SELECTED', serviceId: picked.result.serviceId }, fallback);
  };

  /* ---- 3. no rule matched → S-22 as PRIORITY_CHAIN (§9.4.4) ---- */
  if (!matched) {
    if (!input.defaultChainServiceIds || input.defaultChainServiceIds.length === 0) {
      return done({ kind: 'MANUAL_ASSIGNMENT', reason: 'NO_RULE_AND_NO_DEFAULT_CHAIN' }, null);
    }
    return runDefaultChain('no rule matched — evaluated S-22 as PRIORITY_CHAIN', 'S22_DEFAULT_CHAIN');
  }

  /* ---- 4. the matched rule's action (§4.5, one rule per action, RV-04) -- */
  const filters = collectCandidateFilters(matched);
  const hasFilters = filters.zone !== null || filters.freight !== null || filters.volumetric !== null;
  const run = buildRun(matched.actionServiceIds, {
    excluded: new Set(matched.excludedServiceIds),
    filters: hasFilters ? filters : null,
  });
  const survivors = run.filter((c) => !c.result.eliminated);

  if (matched.actionType === 'PRIORITY_CHAIN') {
    const picked = runPriorityChain(survivors);
    if (!picked) {
      return done({ kind: 'MANUAL_ASSIGNMENT', reason: 'CHAIN_EXHAUSTED' }, null);
    }
    return done({ kind: 'SELECTED', serviceId: picked.result.serviceId }, null);
  }

  if (matched.actionType === 'CHEAPEST') {
    // §4.5: a Service with no usable price IS excluded (quote failure,
    // NONE source, rateAvailable = false); a missing/stale EDD is NOT.
    const priced: RunCandidate[] = [];
    for (const c of survivors) {
      if (!serviceable(c)) {
        c.result.reasons.push({
          code: 'NOT_SERVICEABLE',
          detail: (c.facts?.quote?.failureReasons ?? []).join('; ') || 'lane not serviceable',
        });
        c.result.eliminated = true;
        continue;
      }
      if (!usablePrice(c)) {
        c.result.reasons.push({
          code: 'PRICE_UNAVAILABLE',
          detail:
            c.facts?.quoteError ??
            (c.facts?.costSource === 'NONE' ? 'COST_SOURCE = NONE' : 'no usable price'),
        });
        c.result.eliminated = true;
        continue;
      }
      priced.push(c);
    }
    if (priced.length === 0) {
      // §4.5 / A2-12: fall back to the merchant's priority chain.
      return runDefaultChain('price unavailable — fell back to chain', 'CHAIN_FALLBACK');
    }
    priced.sort((a, b) => {
      const cmp = cmpDecimal(a.result.cost ?? '0', b.result.cost ?? '0') ?? 0;
      if (cmp !== 0) return cmp;
      const tie = (a.facts?.priorityTiebreakOrder ?? 0) - (b.facts?.priorityTiebreakOrder ?? 0);
      return tie !== 0 ? tie : a.chainPosition - b.chainPosition;
    });
    priced[0].result.selected = true;
    return done({ kind: 'SELECTED', serviceId: priced[0].result.serviceId }, null);
  }

  // FASTEST (§4.5): missing/stale EDD (F-18) IS excluded; a missing or
  // failed PRICE alone never excludes.
  const eddUsable: RunCandidate[] = [];
  for (const c of survivors) {
    if (!serviceable(c)) {
      c.result.reasons.push({
        code: 'NOT_SERVICEABLE',
        detail: (c.facts?.quote?.failureReasons ?? []).join('; ') || 'lane not serviceable',
      });
      c.result.eliminated = true;
      continue;
    }
    const state = eddState(c);
    if (state !== 'USABLE') {
      c.result.reasons.push({
        code: state === 'STALE' ? 'EDD_STALE' : 'EDD_MISSING',
        detail:
          state === 'STALE'
            ? `quote fetched at ${c.facts?.quote?.fetchedAt ?? '?'} older than S-18`
            : 'no EDD on the quote',
      });
      c.result.eliminated = true;
      continue;
    }
    eddUsable.push(c);
  }
  if (eddUsable.length === 0) {
    // §4.5 / A1-03: fall back to the merchant's priority chain, record why.
    return runDefaultChain('no usable EDD — fell back to chain', 'CHAIN_FALLBACK');
  }
  eddUsable.sort((a, b) => {
    const byEdd = Date.parse(a.result.eddTo ?? '') - Date.parse(b.result.eddTo ?? '');
    if (byEdd !== 0) return byEdd;
    const tie = (a.facts?.priorityTiebreakOrder ?? 0) - (b.facts?.priorityTiebreakOrder ?? 0);
    return tie !== 0 ? tie : a.chainPosition - b.chainPosition;
  });
  eddUsable[0].result.selected = true;
  return done({ kind: 'SELECTED', serviceId: eddUsable[0].result.serviceId }, null);
}
