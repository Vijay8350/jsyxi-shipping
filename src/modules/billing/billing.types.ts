/**
 * Billing module shared types and constants (spec.md §9.14, §9.5.6, §3.11,
 * §3.20; A2-08; INV-23).
 *
 * INV-23 / §9.14: the ONLY money Jsyxi charges a merchant is the Shopify
 * Billing subscription plus AWB overage, and every charge goes through the
 * Shopify Billing API. There is no margin, wallet, balance, payout or credit
 * ledger of value here — `overage_credit` is a *charge-avoidance* record
 * (§9.5.6), never money held or disbursed by Jsyxi.
 */

/** §3.11 ACCOUNT_STATE / SUBSCRIPTION_STATE (enum `account_state`, migration 0001). */
export type AccountState =
  | 'TRIALING'
  | 'ACTIVE'
  | 'RESTRICTED'
  | 'READ_ONLY'
  | 'UNINSTALLED';

/** §3.20 USAGE_RECORD_STATE. */
export type UsageRecordState =
  | 'PENDING'
  | 'SUBMITTED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'REVERSED';

/** §3.11: the four triggers into RESTRICTED. */
export type RestrictionReason =
  | 'TRIAL_EXPIRED'
  | 'CANCELLED'
  | 'PAYMENT_FAILED'
  | 'STORE_FROZEN';

/** S-39: trial length (14 days, 50 AWBs — the allowance lives on the seeded TRIAL plan). */
export const S39_TRIAL_DAYS = 14;

/** S-40: days in RESTRICTED before the daily sweep moves a Shop to READ_ONLY. */
export const S40_RESTRICTED_DAYS = 30;

/** §9.14/§9.21: the Owner is alerted this many days before trial end. */
export const TRIAL_ENDING_ALERT_DAYS = 3;

/** §9.14/§9.21 allowance alert thresholds (percent of plan allowance). */
export const ALLOWANCE_ALERT_PCT_80 = 80;
export const ALLOWANCE_ALERT_PCT_100 = 100;

/** §3.11 states in which a subscription still consumes/provides allowance. */
export const LIVE_SUBSCRIPTION_STATES: readonly AccountState[] = [
  'TRIALING',
  'ACTIVE',
];

/**
 * §3.20/§9.5.6 (RW-17): `REVERSED` is reachable ONLY where the verified
 * Shopify API supports a safe usage-record reversal. As of the pinned Admin
 * API version (2025-01, see ShopifyGraphqlClient) there is NO mutation that
 * deletes or reverses an AppUsageRecord, so this is false and every
 * post-submission reversal is held as an equal `overage_credit` instead.
 * Flip only after re-verifying the API surface — and NEVER compensate by
 * inventing a negative usage call.
 */
export const SHOPIFY_USAGE_REVERSAL_SUPPORTED = false;

/** §5.7 queue + job names for the daily account-state sweep. */
export const BILLING_QUEUE = 'billing';
export const BILLING_SWEEP_JOB = 'account-state-sweep';
export const BILLING_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

/**
 * Default usage-charge cap offered at subscription approval when the caller
 * does not name one: one full cycle's allowance worth of overage at the
 * plan's overage unit price (a build choice — the plan schema has no cap
 * column and migrations may not be added). The merchant can approve a
 * different cap at Shopify; the APPROVED cap is what gets stored back on
 * `subscription.capped_amount` at confirmation.
 */
export function defaultCappedAmountRupees(
  overageUnitPriceRupees: string,
  awbAllowancePerCycle: number,
): string {
  const unit = Number(overageUnitPriceRupees);
  if (!Number.isFinite(unit) || unit <= 0 || awbAllowancePerCycle <= 0) {
    return '0';
  }
  return (unit * awbAllowancePerCycle).toFixed(2);
}

/** Redis keys (shop-scoped, INV-1). */
export const billingKeys = {
  /** Pending downgrade target plan id (§9.5.6: downgrades at the next cycle). */
  pendingDowngrade: (shopId: string) => `billing:pending-downgrade:${shopId}`,
  /** Set of shop ids with a pending downgrade, scanned by the daily sweep. */
  pendingDowngradeSet: 'billing:pending-downgrades',
  /** Once-per-cycle allowance alert dedupe (§9.14). */
  allowanceAlert: (
    subscriptionId: string,
    cycleStartIso: string,
    pct: number,
  ) => `billing:alert:${subscriptionId}:${cycleStartIso}:${pct}`,
  /** Once-per-trial trial-ending alert dedupe (§9.21). */
  trialEndingAlert: (subscriptionId: string) =>
    `billing:alert:${subscriptionId}:trial-ending`,
};

/** §9.5.6 overage idempotency key: shop + shipment + cycle — stable, unique. */
export function overageIdempotencyKey(
  shopId: string,
  shipmentId: string,
  cycleStartAt: string | Date,
): string {
  const cycle =
    cycleStartAt instanceof Date
      ? cycleStartAt.toISOString()
      : new Date(cycleStartAt).toISOString();
  return `overage:${shopId}:${shipmentId}:${cycle}`;
}

export interface PlanRow {
  plan_id: string;
  code: string;
  name: string;
  awb_allowance_per_cycle: number;
  price: string;
  currency: string;
  overage_unit_price: string;
  is_trial: boolean;
  is_active: boolean;
}

export interface SubscriptionRow {
  subscription_id: string;
  shop_id: string;
  plan_id: string;
  shopify_subscription_gid: string | null;
  cycle_start_at: string | null;
  cycle_end_at: string | null;
  state: AccountState;
  capped_amount: string | null;
  currency: string;
  created_at: string;
}

export interface UsageRecordRow {
  usage_id: string;
  shop_id: string;
  subscription_id: string;
  idempotency_key: string;
  shopify_usage_record_gid: string | null;
  amount: string;
  currency: string;
  state: UsageRecordState;
  submitted_at: string | null;
  created_at: string;
}

/** §9.5.6 plan-change timing: upgrades start after approval, downgrades at the next cycle. */
export type PlanChangeTiming = 'AFTER_APPROVAL' | 'NEXT_CYCLE';
