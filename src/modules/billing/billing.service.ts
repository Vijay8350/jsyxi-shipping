import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import { AuditService } from '../../audit/audit.service';
import { rupeesToPaise } from '../../common/money';
import { EntitlementLedgerService } from '../platform/ledger/entitlement-ledger.service';
import {
  ActiveSubscription,
  ShopifyBillingClient,
} from './shopify-billing.client';
import {
  AccountState,
  billingKeys,
  defaultCappedAmountRupees,
  LIVE_SUBSCRIPTION_STATES,
  PlanChangeTiming,
  PlanRow,
  RestrictionReason,
  S39_TRIAL_DAYS,
  SubscriptionRow,
  UsageRecordRow,
} from './billing.types';

/**
 * Subscription lifecycle via the Shopify Billing API (§9.14, §9.5.6, §3.11).
 *
 * - Every charge is a Shopify Billing charge (INV-23): this service never
 *   records money movement of its own; the local `subscription` row mirrors
 *   what Shopify has approved.
 * - The merchant approves at Shopify; the subscription becomes ACTIVE on the
 *   confirmation redirect, verified by querying the app's active
 *   subscriptions — never trusted from the redirect parameters alone.
 * - Upgrades start after approval; downgrades are held and applied at the
 *   next cycle (§9.5.6).
 * - Cancellation, trial expiry, payment failure and store freeze move the
 *   Shop to RESTRICTED (§3.11); the capability ladder itself is enforced by
 *   the query-level guards in booking / booking-ops / labels, which read
 *   `shop.account_state` (BLOCKED_ACCOUNT_STATES) — this module is the
 *   writer of that state, never a parallel gate.
 * - Resubscribe (create + approve again) restores ACTIVE with a NEW
 *   subscription row and cycle, i.e. a new allowance period (§3.11).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** §9.14 billing cycle: appRecurringPricingDetails interval EVERY_30_DAYS. */
const CYCLE_DAYS = 30;

export type CreateSubscriptionResult =
  | {
      created: true;
      confirmationUrl: string;
      shopifySubscriptionGid: string;
      trialDays: number;
      cappedAmount: string | null;
    }
  | { created: false; reason: 'PLAN_NOT_FOUND' | 'TRIAL_PLAN_NOT_BILLABLE' };

export type ConfirmSubscriptionResult =
  | { activated: true; subscriptionId: string; planCode: string }
  | { activated: false; reason: 'NO_APPROVED_SUBSCRIPTION' | 'UNKNOWN_PLAN' };

export type PlanChangeResult =
  | {
      changed: true;
      timing: 'AFTER_APPROVAL';
      confirmationUrl: string;
    }
  | { changed: true; timing: 'NEXT_CYCLE'; effectiveAt: string | null }
  | { changed: false; reason: 'PLAN_NOT_FOUND' | 'TRIAL_PLAN_NOT_BILLABLE' | 'SAME_PLAN' };

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly ledger: EntitlementLedgerService,
    private readonly shopifyBilling: ShopifyBillingClient,
  ) {}

  /** §9.14 tier cards: every active plan. */
  async listPlans(): Promise<PlanRow[]> {
    const { rows } = await this.pool.query<PlanRow>(
      `SELECT plan_id, code, name, awb_allowance_per_cycle, price, currency,
              overage_unit_price, is_trial, is_active
         FROM plan
        WHERE is_active
        ORDER BY price ASC`,
    );
    return rows;
  }

  /** The shop's current (latest) subscription with its plan, if any. */
  async currentSubscription(
    shopId: string,
  ): Promise<{ subscription: SubscriptionRow; plan: PlanRow } | null> {
    const { rows } = await this.pool.query<SubscriptionRow & { plan: PlanRow }>(
      `SELECT s.subscription_id, s.shop_id, s.plan_id,
              s.shopify_subscription_gid, s.cycle_start_at, s.cycle_end_at,
              s.state, s.capped_amount, s.currency, s.created_at,
              (SELECT row_to_json(p) FROM plan p WHERE p.plan_id = s.plan_id) AS plan
         FROM subscription s
        WHERE s.shop_id = $1
        ORDER BY s.created_at DESC
        LIMIT 1`,
      [shopId],
    );
    const row = rows[0];
    if (!row) return null;
    const { plan, ...subscription } = row;
    return { subscription: subscription as SubscriptionRow, plan };
  }

  /** §9.14 usage bar: current subscription plus live allowance consumption. */
  async getOverview(shopId: string) {
    const current = await this.currentSubscription(shopId);
    if (!current) return { subscription: null, plan: null, usage: null };
    const { subscription, plan } = current;
    const tally = subscription.cycle_start_at
      ? await this.ledger.allowanceBalance(
          subscription.subscription_id,
          subscription.cycle_start_at,
        )
      : { debits: 0, reversals: 0, consumed: 0 };
    return {
      subscription,
      plan,
      usage: {
        allowance: plan.awb_allowance_per_cycle,
        consumed: tally.consumed,
        cappedAmount: subscription.capped_amount,
      },
    };
  }

  /**
   * Remaining trial days to hand to the subscription-create mutation: the
   * unexpired
   * remainder of the S-39 trial seeded at install, so a merchant who
   * subscribes mid-trial is not billed before the trial ends.
   */
  private async remainingTrialDays(shopId: string): Promise<number> {
    const { rows } = await this.pool.query<{ cycle_end_at: string | null }>(
      `SELECT s.cycle_end_at
         FROM subscription s
        WHERE s.shop_id = $1 AND s.state = 'TRIALING'
        ORDER BY s.created_at DESC LIMIT 1`,
      [shopId],
    );
    const end = rows[0]?.cycle_end_at;
    if (!end) return 0;
    const remainingMs = new Date(end).getTime() - Date.now();
    if (remainingMs <= 0) return 0;
    return Math.min(S39_TRIAL_DAYS, Math.ceil(remainingMs / DAY_MS));
  }

  /**
   * §9.14: create a subscription charge at Shopify and return the approval
   * URL. The TRIAL plan is never billed — it is the S-39 local seed and a
   * ₹0 charge would be nonsense. The local `subscription` row is written
   * only at confirmation (§3.11 has no PENDING state — a row written before
   * approval would lie about the account's entitlement).
   */
  async createSubscription(
    shopId: string,
    actorMemberId: string | null,
    planId: string,
    opts: { cappedAmountRupees?: string; test?: boolean } = {},
  ): Promise<CreateSubscriptionResult> {
    const { rows: plans } = await this.pool.query<PlanRow>(
      `SELECT plan_id, code, name, awb_allowance_per_cycle, price, currency,
              overage_unit_price, is_trial, is_active
         FROM plan WHERE plan_id = $1 AND is_active`,
      [planId],
    );
    const plan = plans[0];
    if (!plan) return { created: false, reason: 'PLAN_NOT_FOUND' };
    if (plan.is_trial) return { created: false, reason: 'TRIAL_PLAN_NOT_BILLABLE' };

    const cappedAmount =
      opts.cappedAmountRupees ??
      (rupeesToPaise(plan.overage_unit_price) > 0n
        ? defaultCappedAmountRupees(
            plan.overage_unit_price,
            plan.awb_allowance_per_cycle,
          )
        : null);
    const trialDays = await this.remainingTrialDays(shopId);
    const appUrl = this.config.get<string>('shopify.appUrl') ?? '';
    const result = await this.shopifyBilling.createSubscription(shopId, {
      name: `Jsyxi ${plan.name}`,
      returnUrl: `${appUrl}/billing/confirm`,
      trialDays,
      recurringPrice: Number(plan.price).toFixed(2),
      currencyCode: plan.currency,
      cappedAmount,
      usageTerms:
        cappedAmount !== null
          ? `AWB overage beyond the ${plan.awb_allowance_per_cycle} AWB plan allowance, at ₹${Number(plan.overage_unit_price).toFixed(2)} per additional AWB (§9.5.6)`
          : null,
      test: opts.test,
    });
    await this.audit.record({
      shopId,
      actorKind: actorMemberId ? 'MEMBER' : 'SYSTEM',
      actorId: actorMemberId,
      action: 'billing.subscription.create_requested',
      objectType: 'plan',
      objectId: plan.plan_id,
      after: {
        planCode: plan.code,
        shopifySubscriptionGid: result.subscriptionGid,
        trialDays,
        cappedAmount,
      },
    });
    return {
      created: true,
      confirmationUrl: result.confirmationUrl,
      shopifySubscriptionGid: result.subscriptionGid,
      trialDays,
      cappedAmount,
    };
  }

  /**
   * §9.14: the confirmation-redirect handler. Queries the app's ACTIVE
   * subscriptions at Shopify (the redirect's own parameters are not proof of
   * approval), matches the newest one to a plan by its charge name, and
   * activates a new local subscription row + cycle. Idempotent: an already
   * recorded GID activates nothing twice. Resubscribe from RESTRICTED /
   * READ_ONLY restores ACTIVE with a new allowance period (§3.11); an
   * UNINSTALLED shop is never reactivated here (§3.11 terminal).
   */
  async confirmSubscription(
    shopId: string,
    actorMemberId: string | null,
  ): Promise<ConfirmSubscriptionResult> {
    const active = await this.shopifyBilling.activeSubscriptions(shopId);
    const approved = active
      .filter((s) => s.status === 'ACTIVE')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!approved) {
      return { activated: false, reason: 'NO_APPROVED_SUBSCRIPTION' };
    }

    // Already recorded? Then this redirect is a replay — idempotent success.
    const { rows: existing } = await this.pool.query<{
      subscription_id: string;
      state: AccountState;
    }>(
      `SELECT subscription_id, state FROM subscription
        WHERE shop_id = $1 AND shopify_subscription_gid = $2`,
      [shopId, approved.gid],
    );
    if (existing[0] && LIVE_SUBSCRIPTION_STATES.includes(existing[0].state)) {
      const { rows: planRows } = await this.pool.query<{ code: string }>(
        `SELECT p.code FROM subscription s JOIN plan p ON p.plan_id = s.plan_id
          WHERE s.subscription_id = $1`,
        [existing[0].subscription_id],
      );
      return {
        activated: true,
        subscriptionId: existing[0].subscription_id,
        planCode: planRows[0]?.code ?? '',
      };
    }

    const plan = await this.planForCharge(approved);
    if (!plan) return { activated: false, reason: 'UNKNOWN_PLAN' };

    const cycleStart = new Date();
    const cycleEnd = approved.currentPeriodEnd
      ? new Date(approved.currentPeriodEnd)
      : new Date(cycleStart.getTime() + CYCLE_DAYS * DAY_MS);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Close every open cycle (the superseded subscription's). State is
      // left as-is (§3.11 has no "ended" value); readers always take the
      // LATEST row, so the new row below is authoritative from here on.
      await client.query(
        `UPDATE subscription
            SET cycle_end_at = now()
          WHERE shop_id = $1
            AND cycle_end_at IS NOT NULL
            AND cycle_end_at > now()`,
        [shopId],
      );
      const { rows: inserted } = await client.query<{
        subscription_id: string;
      }>(
        `INSERT INTO subscription
           (shop_id, plan_id, shopify_subscription_gid,
            cycle_start_at, cycle_end_at, state, capped_amount, currency)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7)
         RETURNING subscription_id`,
        [
          shopId,
          plan.plan_id,
          approved.gid,
          cycleStart,
          cycleEnd,
          approved.cappedAmount,
          plan.currency,
        ],
      );
      // §3.11: resubscribe → ACTIVE from TRIALING/ACTIVE/RESTRICTED/READ_ONLY.
      // UNINSTALLED is terminal and never reactivated by billing.
      await client.query(
        `UPDATE shop SET account_state = 'ACTIVE'
          WHERE shop_id = $1
            AND account_state IN ('TRIALING', 'ACTIVE', 'RESTRICTED', 'READ_ONLY')`,
        [shopId],
      );
      await client.query('COMMIT');
      await this.audit.record({
        shopId,
        actorKind: actorMemberId ? 'MEMBER' : 'SYSTEM',
        actorId: actorMemberId,
        action: 'billing.subscription.activated',
        objectType: 'subscription',
        objectId: inserted[0].subscription_id,
        after: {
          planCode: plan.code,
          shopifySubscriptionGid: approved.gid,
          cycleStartAt: cycleStart.toISOString(),
          cycleEndAt: cycleEnd.toISOString(),
          cappedAmount: approved.cappedAmount,
        },
      });
      await this.audit.record({
        shopId,
        actorKind: actorMemberId ? 'MEMBER' : 'SYSTEM',
        actorId: actorMemberId,
        action: 'billing.account_state',
        objectType: 'shop',
        objectId: shopId,
        after: { to: 'ACTIVE', reason: 'SUBSCRIBED' },
      });
      return {
        activated: true,
        subscriptionId: inserted[0].subscription_id,
        planCode: plan.code,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** The charge name is `Jsyxi {plan.name}` — match it back to the plan. */
  private async planForCharge(
    approved: ActiveSubscription,
  ): Promise<PlanRow | null> {
    const { rows } = await this.pool.query<PlanRow>(
      `SELECT plan_id, code, name, awb_allowance_per_cycle, price, currency,
              overage_unit_price, is_trial, is_active
         FROM plan WHERE is_active`,
    );
    return (
      rows.find((p) => approved.name === `Jsyxi ${p.name}`) ??
      rows.find((p) => approved.name.endsWith(p.name)) ??
      null
    );
  }

  /**
   * §9.5.6: upgrades start after approval; downgrades at the next cycle.
   * An upgrade creates the Shopify charge immediately (it activates on
   * approval, via confirmSubscription). A downgrade is recorded as a pending
   * change and applied by the daily sweep once the current cycle ends.
   */
  async requestPlanChange(
    shopId: string,
    actorMemberId: string,
    newPlanId: string,
  ): Promise<PlanChangeResult> {
    const current = await this.currentSubscription(shopId);
    if (!current) {
      const created = await this.createSubscription(
        shopId,
        actorMemberId,
        newPlanId,
      );
      if (!created.created) {
        return { changed: false, reason: created.reason };
      }
      return {
        changed: true,
        timing: 'AFTER_APPROVAL',
        confirmationUrl: created.confirmationUrl,
      };
    }
    if (current.plan.plan_id === newPlanId) {
      return { changed: false, reason: 'SAME_PLAN' };
    }
    const { rows: plans } = await this.pool.query<PlanRow>(
      `SELECT plan_id, code, name, awb_allowance_per_cycle, price, currency,
              overage_unit_price, is_trial, is_active
         FROM plan WHERE plan_id = $1 AND is_active`,
      [newPlanId],
    );
    const newPlan = plans[0];
    if (!newPlan) return { changed: false, reason: 'PLAN_NOT_FOUND' };
    if (newPlan.is_trial) {
      return { changed: false, reason: 'TRIAL_PLAN_NOT_BILLABLE' };
    }

    const isUpgrade =
      rupeesToPaise(newPlan.price) > rupeesToPaise(current.plan.price);
    if (isUpgrade) {
      const created = await this.createSubscription(
        shopId,
        actorMemberId,
        newPlanId,
      );
      if (!created.created) {
        return { changed: false, reason: created.reason };
      }
      return {
        changed: true,
        timing: 'AFTER_APPROVAL',
        confirmationUrl: created.confirmationUrl,
      };
    }

    // Downgrade: hold until the next cycle (§9.5.6). The sweep applies it.
    await this.redis.set(
      billingKeys.pendingDowngrade(shopId),
      newPlanId,
      'PX',
      (CYCLE_DAYS + S39_TRIAL_DAYS) * DAY_MS,
    );
    await this.redis.sadd(billingKeys.pendingDowngradeSet, shopId);
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: actorMemberId,
      action: 'billing.plan_change.scheduled',
      objectType: 'subscription',
      objectId: current.subscription.subscription_id,
      after: {
        fromPlan: current.plan.code,
        toPlan: newPlan.code,
        timing: 'NEXT_CYCLE',
        effectiveAt: current.subscription.cycle_end_at,
      },
    });
    return {
      changed: true,
      timing: 'NEXT_CYCLE',
      effectiveAt: current.subscription.cycle_end_at,
    };
  }

  /**
   * §9.14/§3.11: cancel at Shopify, then RESTRICTED. The capability ladder
   * (booking/bulk/auto-ship/new labels stop; tracking, sync-back, NDR,
   * recon, tickets, reports, exports and re-download continue) is enforced
   * by the sibling guards that read shop.account_state.
   */
  async cancel(
    shopId: string,
    actorMemberId: string,
  ): Promise<{ cancelled: boolean }> {
    const current = await this.currentSubscription(shopId);
    if (current?.subscription.shopify_subscription_gid) {
      await this.shopifyBilling.cancelSubscription(
        shopId,
        current.subscription.shopify_subscription_gid,
      );
    }
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: actorMemberId,
      action: 'billing.subscription.cancelled',
      objectType: 'subscription',
      objectId: current?.subscription.subscription_id ?? null,
    });
    await this.applyRestriction(shopId, 'CANCELLED');
    // A pending downgrade is moot once cancelled.
    await this.redis.del(billingKeys.pendingDowngrade(shopId));
    await this.redis.srem(billingKeys.pendingDowngradeSet, shopId);
    return { cancelled: true };
  }

  /**
   * §3.11 writer: TRIALING/ACTIVE → RESTRICTED. Idempotent and one-way from
   * the live states only; READ_ONLY and UNINSTALLED are never walked back.
   * The audit row (`after.to`) is how the S-40 sweep dates the restriction.
   */
  async applyRestriction(
    shopId: string,
    reason: RestrictionReason,
  ): Promise<{ restricted: boolean }> {
    const { rowCount } = await this.pool.query(
      `UPDATE shop SET account_state = 'RESTRICTED'
        WHERE shop_id = $1 AND account_state IN ('TRIALING', 'ACTIVE')`,
      [shopId],
    );
    if (!rowCount) return { restricted: false };
    await this.pool.query(
      `UPDATE subscription SET state = 'RESTRICTED'
        WHERE shop_id = $1 AND state IN ('TRIALING', 'ACTIVE')`,
      [shopId],
    );
    await this.audit.record({
      shopId,
      actorKind: 'SYSTEM',
      action: 'billing.account_state',
      objectType: 'shop',
      objectId: shopId,
      after: { to: 'RESTRICTED', reason },
    });
    return { restricted: true };
  }

  /**
   * Binding point for the Shopify webhook module (app/subscriptions_update):
   * map an external AppSubscription status onto §3.11. DECLINED is payment
   * failure, FROZEN is a store freeze, CANCELLED/EXPIRED end entitlement.
   */
  async applyExternalStatus(
    shopId: string,
    status: string,
  ): Promise<{ applied: boolean; mapped: RestrictionReason | 'ACTIVE' | 'IGNORED' }> {
    switch (status) {
      case 'ACTIVE':
        await this.confirmSubscription(shopId, null);
        return { applied: true, mapped: 'ACTIVE' };
      case 'DECLINED':
        return { applied: (await this.applyRestriction(shopId, 'PAYMENT_FAILED')).restricted, mapped: 'PAYMENT_FAILED' };
      case 'FROZEN':
        return { applied: (await this.applyRestriction(shopId, 'STORE_FROZEN')).restricted, mapped: 'STORE_FROZEN' };
      case 'CANCELLED':
      case 'EXPIRED':
        return { applied: (await this.applyRestriction(shopId, 'CANCELLED')).restricted, mapped: 'CANCELLED' };
      default:
        this.logger.log(`unhandled subscription status ${status}`);
        return { applied: false, mapped: 'IGNORED' };
    }
  }

  /** §9.14 billing history: subscriptions, usage charges and credits. */
  async billingHistory(shopId: string): Promise<{
    subscriptions: Array<SubscriptionRow & { plan: PlanRow | null }>;
    usageRecords: UsageRecordRow[];
    overageCredits: Array<{
      credit_id: string;
      amount: string;
      currency: string;
      source_usage_id: string;
      consumed_at: string | null;
      created_at: string;
    }>;
  }> {
    const { rows: subscriptions } = await this.pool.query<
      SubscriptionRow & { plan: PlanRow | null }
    >(
      `SELECT s.subscription_id, s.shop_id, s.plan_id,
              s.shopify_subscription_gid, s.cycle_start_at, s.cycle_end_at,
              s.state, s.capped_amount, s.currency, s.created_at,
              (SELECT row_to_json(p) FROM plan p WHERE p.plan_id = s.plan_id) AS plan
         FROM subscription s
        WHERE s.shop_id = $1
        ORDER BY s.created_at DESC`,
      [shopId],
    );
    const { rows: usageRecords } = await this.pool.query<UsageRecordRow>(
      `SELECT usage_id, shop_id, subscription_id, idempotency_key,
              shopify_usage_record_gid, amount, currency, state,
              submitted_at, created_at
         FROM usage_record
        WHERE shop_id = $1
        ORDER BY created_at DESC`,
      [shopId],
    );
    const { rows: overageCredits } = await this.pool.query(
      `SELECT credit_id, amount, currency, source_usage_id, consumed_at, created_at
         FROM overage_credit
        WHERE shop_id = $1
        ORDER BY created_at DESC`,
      [shopId],
    );
    return {
      subscriptions: subscriptions.map((s) => s),
      usageRecords,
      overageCredits: overageCredits as never,
    };
  }
}
