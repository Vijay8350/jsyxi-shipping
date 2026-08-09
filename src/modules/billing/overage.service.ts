import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { rupeesToPaise } from '../../common/money';
import { EntitlementLedgerService } from '../platform/ledger/entitlement-ledger.service';
import {
  ShopifyBillingClient,
  ShopifyBillingUserError,
} from './shopify-billing.client';
import {
  overageIdempotencyKey,
  PlanRow,
  SHOPIFY_USAGE_REVERSAL_SUPPORTED,
  SubscriptionRow,
  UsageRecordRow,
} from './billing.types';

/**
 * AWB overage charging (§9.5.6, §3.20; A1-04 exactly-once; INV-23).
 *
 * - ONE usage_record per overage AWB, keyed by shop + shipment + cycle
 *   (stable idempotency key, unique column — a booking retry can never
 *   double-charge). The returned Shopify GID is stored on the row.
 * - Cap: an overage is charged only while the subscription's approved
 *   capped_amount covers it. When the cap is insufficient nothing is
 *   emitted and the booking-side gate (which reads subscription
 *   .capped_amount) blocks allowance-exceeding auto/bulk bookings with the
 *   approve-or-upgrade prompt.
 * - An unconsumed overage_credit covers the next overage INSTEAD of a new
 *   Shopify charge — no usage call is made for that AWB at all.
 * - Reversal (pre-pickup courier-confirmed cancellation): an unsubmitted
 *   record goes REVERSED; a submitted one can never be "un-charged" through
 *   the API (SHOPIFY_USAGE_REVERSAL_SUPPORTED, §3.20 RW-17), so an EQUAL
 *   overage_credit is held against subsequent overage and the record keeps
 *   its state. A negative usage call is NEVER invented.
 *
 * Charging uses paise (bigint) internally; decimal strings only at the
 * database and Shopify boundaries (INV-15).
 */

export type OverageRecordResult =
  | { recorded: true; submitted: true; usageId: string; shopifyGid: string }
  | {
      recorded: true;
      submitted: false;
      usageId: string;
      reason: 'NO_USAGE_LINE_ITEM' | 'SUBMIT_AMBIGUOUS' | 'REJECTED_BY_SHOPIFY';
    }
  | {
      recorded: false;
      reason:
        | 'WITHIN_ALLOWANCE'
        | 'NO_OVERAGE_PRICE'
        | 'CAP_EXCEEDED'
        | 'ALREADY_RECORDED'
        | 'COVERED_BY_CREDIT'
        | 'NO_SUBSCRIPTION';
      creditId?: string;
    };

export type OverageReverseResult =
  | { handled: true; outcome: 'REVERSED_UNSUBMITTED'; usageId: string }
  | { handled: true; outcome: 'CREDIT_HELD'; usageId: string; creditId: string }
  | { handled: true; outcome: 'ALREADY_CREDITED'; usageId: string }
  | {
      handled: false;
      reason:
        | 'NO_USAGE_RECORD'
        | 'TERMINAL_STATE'
        | 'SUBMIT_AMBIGUOUS_REVIEW';
      needsReview?: boolean;
    };

@Injectable()
export class OverageService {
  private readonly logger = new Logger(OverageService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly ledger: EntitlementLedgerService,
    private readonly shopifyBilling: ShopifyBillingClient,
  ) {}

  private async loadSubscriptionWithPlan(
    subscriptionId: string,
  ): Promise<{ subscription: SubscriptionRow; plan: PlanRow } | null> {
    const { rows } = await this.pool.query<SubscriptionRow & { plan: PlanRow }>(
      `SELECT s.subscription_id, s.shop_id, s.plan_id,
              s.shopify_subscription_gid, s.cycle_start_at, s.cycle_end_at,
              s.state, s.capped_amount, s.currency, s.created_at,
              (SELECT row_to_json(p) FROM plan p WHERE p.plan_id = s.plan_id) AS plan
         FROM subscription s
        WHERE s.subscription_id = $1`,
      [subscriptionId],
    );
    const row = rows[0];
    if (!row) return null;
    const { plan, ...subscription } = row;
    return { subscription: subscription as SubscriptionRow, plan };
  }

  /**
   * Called by the booking pipeline after a durably-confirmed non-test AWB
   * debit (INV-19/INV-12 already applied there). If the shipment pushed the
   * cycle past the plan allowance, emit its single overage usage record.
   */
  async recordOverageForShipment(input: {
    shopId: string;
    subscriptionId: string;
    shipmentId: string;
  }): Promise<OverageRecordResult> {
    const loaded = await this.loadSubscriptionWithPlan(input.subscriptionId);
    if (!loaded || !loaded.subscription.cycle_start_at) {
      return { recorded: false, reason: 'NO_SUBSCRIPTION' };
    }
    const { subscription, plan } = loaded;
    // Guaranteed non-null by the load guard above.
    const cycleStartAt = subscription.cycle_start_at as string;

    const tally = await this.ledger.allowanceBalance(
      subscription.subscription_id,
      cycleStartAt,
    );
    if (tally.consumed <= plan.awb_allowance_per_cycle) {
      return { recorded: false, reason: 'WITHIN_ALLOWANCE' };
    }

    const unitPrice = rupeesToPaise(plan.overage_unit_price);
    if (unitPrice <= 0n) {
      return { recorded: false, reason: 'NO_OVERAGE_PRICE' };
    }

    const key = overageIdempotencyKey(
      input.shopId,
      input.shipmentId,
      cycleStartAt,
    );

    // §9.5.6: an unconsumed credit covers this overage — no charge at all.
    // Single-statement consume so concurrent bookings cannot take the same
    // credit twice (the consumed_at guard is re-checked under the row lock).
    const { rows: credits } = await this.pool.query<{ credit_id: string }>(
      `UPDATE overage_credit SET consumed_at = now()
        WHERE credit_id = (
                SELECT credit_id FROM overage_credit
                 WHERE shop_id = $1 AND subscription_id = $2
                   AND consumed_at IS NULL
                 ORDER BY created_at ASC LIMIT 1
              )
          AND consumed_at IS NULL
        RETURNING credit_id`,
      [input.shopId, subscription.subscription_id],
    );
    if (credits[0]) {
      await this.audit.record({
        shopId: input.shopId,
        actorKind: 'SYSTEM',
        action: 'billing.overage.credit_consumed',
        objectType: 'overage_credit',
        objectId: credits[0].credit_id,
        after: { shipmentId: input.shipmentId, idempotencyKey: key },
      });
      return {
        recorded: false,
        reason: 'COVERED_BY_CREDIT',
        creditId: credits[0].credit_id,
      };
    }

    // §9.5.6 cap check: charged-so-far this cycle + this unit must fit the
    // approved capped_amount. A null/zero cap permits no overage at all.
    const cappedPaise =
      subscription.capped_amount !== null
        ? rupeesToPaise(subscription.capped_amount)
        : 0n;
    const { rows: chargedRows } = await this.pool.query<{ total: string | null }>(
      `SELECT sum(amount)::text AS total
         FROM usage_record
        WHERE shop_id = $1
          AND subscription_id = $2
          AND created_at >= $3
          AND state IN ('PENDING', 'SUBMITTED', 'ACCEPTED')`,
      [input.shopId, subscription.subscription_id, cycleStartAt],
    );
    const chargedPaise = rupeesToPaise(chargedRows[0]?.total ?? '0');
    if (chargedPaise + unitPrice > cappedPaise) {
      return { recorded: false, reason: 'CAP_EXCEEDED' };
    }

    // Exactly-once (A1-04): the unique idempotency_key is the enforcer; a
    // conflict means this AWB's overage already exists — never emit twice.
    const { rows: inserted } = await this.pool.query<{ usage_id: string }>(
      `INSERT INTO usage_record
         (shop_id, subscription_id, idempotency_key, amount, currency, state)
       VALUES ($1, $2, $3, $4, $5, 'PENDING')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING usage_id`,
      [
        input.shopId,
        subscription.subscription_id,
        key,
        plan.overage_unit_price,
        plan.currency,
      ],
    );
    const usageId = inserted[0]?.usage_id;
    if (!usageId) {
      return { recorded: false, reason: 'ALREADY_RECORDED' };
    }

    // Submit to Shopify. The usage line item id is resolved live (the schema
    // has no column for it and migrations may not be added).
    const lineItemId = await this.usageLineItemId(
      input.shopId,
      subscription.shopify_subscription_gid,
    );
    if (!lineItemId) {
      return {
        recorded: true,
        submitted: false,
        usageId,
        reason: 'NO_USAGE_LINE_ITEM',
      };
    }
    try {
      const gid = await this.shopifyBilling.createUsageRecord(
        input.shopId,
        lineItemId,
        plan.overage_unit_price,
        `AWB overage (${key})`,
      );
      await this.pool.query(
        `UPDATE usage_record
            SET state = 'SUBMITTED', shopify_usage_record_gid = $2,
                submitted_at = now()
          WHERE usage_id = $1`,
        [usageId, gid],
      );
      await this.audit.record({
        shopId: input.shopId,
        actorKind: 'SYSTEM',
        action: 'billing.overage.submitted',
        objectType: 'usage_record',
        objectId: usageId,
        after: { shipmentId: input.shipmentId, shopifyUsageRecordGid: gid },
      });
      return { recorded: true, submitted: true, usageId, shopifyGid: gid };
    } catch (err) {
      if (err instanceof ShopifyBillingUserError) {
        // §3.20: REJECTED is terminal — Shopify refused the charge outright.
        await this.pool.query(
          `UPDATE usage_record SET state = 'REJECTED' WHERE usage_id = $1`,
          [usageId],
        );
        await this.audit.record({
          shopId: input.shopId,
          actorKind: 'SYSTEM',
          action: 'billing.overage.rejected',
          objectType: 'usage_record',
          objectId: usageId,
          after: { shipmentId: input.shipmentId },
        });
        return { recorded: true, submitted: false, usageId, reason: 'REJECTED_BY_SHOPIFY' };
      }
      // Ambiguous (network/timeout): the charge MAY exist at Shopify. Submit
      // exactly once — stamp submitted_at so no retry path re-sends it, and
      // leave the row PENDING for review. Never risk a double charge.
      await this.pool.query(
        `UPDATE usage_record SET submitted_at = now() WHERE usage_id = $1`,
        [usageId],
      );
      this.logger.warn(
        `usage submit ambiguous for record ${usageId}: ${(err as Error).name}`,
      );
      return {
        recorded: true,
        submitted: false,
        usageId,
        reason: 'SUBMIT_AMBIGUOUS',
      };
    }
  }

  private async usageLineItemId(
    shopId: string,
    subscriptionGid: string | null,
  ): Promise<string | null> {
    if (!subscriptionGid) return null;
    const active = await this.shopifyBilling.activeSubscriptions(shopId);
    return (
      active.find((s) => s.gid === subscriptionGid)?.usageLineItemId ?? null
    );
  }

  /**
   * §9.5.6 reversal path — called after the entitlement ledger reversed the
   * AWB (pre-pickup courier-confirmed cancellation only; the ledger itself
   * flags the ambiguous race and reverses nothing, in which case this must
   * NOT be called).
   */
  async reverseOverageForShipment(input: {
    shopId: string;
    subscriptionId: string;
    shipmentId: string;
  }): Promise<OverageReverseResult> {
    // The key embeds the cycle start; match by its shop+shipment prefix.
    const prefix = `overage:${input.shopId}:${input.shipmentId}:%`;
    const { rows } = await this.pool.query<UsageRecordRow>(
      `SELECT usage_id, shop_id, subscription_id, idempotency_key,
              shopify_usage_record_gid, amount, currency, state,
              submitted_at, created_at
         FROM usage_record
        WHERE shop_id = $1 AND idempotency_key LIKE $2
        ORDER BY created_at DESC LIMIT 1`,
      [input.shopId, prefix],
    );
    const record = rows[0];
    if (!record) return { handled: false, reason: 'NO_USAGE_RECORD' };

    if (record.state === 'REJECTED' || record.state === 'REVERSED') {
      return { handled: false, reason: 'TERMINAL_STATE' };
    }

    if (record.state === 'PENDING') {
      if (record.shopify_usage_record_gid === null && record.submitted_at === null) {
        // Never reached Shopify — safe to mark REVERSED (§3.20).
        await this.pool.query(
          `UPDATE usage_record SET state = 'REVERSED' WHERE usage_id = $1`,
          [record.usage_id],
        );
        await this.audit.record({
          shopId: input.shopId,
          actorKind: 'SYSTEM',
          action: 'billing.overage.reversed',
          objectType: 'usage_record',
          objectId: record.usage_id,
          after: { shipmentId: input.shipmentId, outcome: 'REVERSED_UNSUBMITTED' },
        });
        return {
          handled: true,
          outcome: 'REVERSED_UNSUBMITTED',
          usageId: record.usage_id,
        };
      }
      // Submitted but the outcome is unknown — charge may exist. Reverse
      // nothing automatically; flag for review (§9.5.6 ambiguous race rule).
      return {
        handled: false,
        reason: 'SUBMIT_AMBIGUOUS_REVIEW',
        needsReview: true,
      };
    }

    // SUBMITTED or ACCEPTED: the charge exists at Shopify.
    if (SHOPIFY_USAGE_REVERSAL_SUPPORTED) {
      // §3.20: reachable only when the verified API supports a safe reversal.
      // As of the pinned API version it does not — see billing.types.ts.
      throw new Error('Shopify usage reversal path not implemented');
    }

    // Hold an EQUAL overage_credit against subsequent overage; the record
    // keeps its state (§3.20, RW-17). Idempotent per source usage record.
    const { rows: existingCredits } = await this.pool.query<{
      credit_id: string;
    }>(
      `SELECT credit_id FROM overage_credit
        WHERE source_usage_id = $1 AND consumed_at IS NULL`,
      [record.usage_id],
    );
    if (existingCredits[0]) {
      return {
        handled: true,
        outcome: 'ALREADY_CREDITED',
        usageId: record.usage_id,
      };
    }
    const { rows: creditRows } = await this.pool.query<{ credit_id: string }>(
      `INSERT INTO overage_credit
         (shop_id, subscription_id, amount, currency, source_usage_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING credit_id`,
      // Signed credit row (§4.1): the negative of the charged amount.
      [
        input.shopId,
        record.subscription_id,
        `-${record.amount}`,
        record.currency,
        record.usage_id,
      ],
    );
    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'SYSTEM',
      action: 'billing.overage.credit_held',
      objectType: 'overage_credit',
      objectId: creditRows[0].credit_id,
      after: {
        shipmentId: input.shipmentId,
        sourceUsageId: record.usage_id,
        amount: `-${record.amount}`,
      },
    });
    return {
      handled: true,
      outcome: 'CREDIT_HELD',
      usageId: record.usage_id,
      creditId: creditRows[0].credit_id,
    };
  }

  /**
   * §3.20 SUBMITTED → ACCEPTED: the daily sweep reads the subscription's
   * usage records back from Shopify; a record still present is accepted.
   * ACCEPTED is terminal — nothing ever leaves it except a credit-hold.
   */
  async reconcileSubmittedUsage(shopId: string): Promise<{ accepted: number }> {
    const { rows: subs } = await this.pool.query<{
      subscription_id: string;
      shopify_subscription_gid: string;
    }>(
      `SELECT DISTINCT s.subscription_id, s.shopify_subscription_gid
         FROM subscription s
         JOIN usage_record u ON u.subscription_id = s.subscription_id
        WHERE s.shop_id = $1
          AND s.shopify_subscription_gid IS NOT NULL
          AND u.state = 'SUBMITTED'`,
      [shopId],
    );
    let accepted = 0;
    for (const sub of subs) {
      const gids = new Set(
        await this.shopifyBilling.listUsageRecordGids(
          shopId,
          sub.shopify_subscription_gid,
        ),
      );
      if (gids.size === 0) continue;
      const { rows: promoted } = await this.pool.query<{ usage_id: string }>(
        `UPDATE usage_record
            SET state = 'ACCEPTED'
          WHERE subscription_id = $1
            AND state = 'SUBMITTED'
            AND shopify_usage_record_gid = ANY($2)
          RETURNING usage_id`,
        [sub.subscription_id, Array.from(gids)],
      );
      accepted += promoted.length;
    }
    return { accepted };
  }
}
