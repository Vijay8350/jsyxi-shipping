import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import { AuditService } from '../../audit/audit.service';
import { BillingService } from './billing.service';
import { OverageService } from './overage.service';
import { BillingAlertsService } from './billing-alerts.service';
import { billingKeys, S40_RESTRICTED_DAYS } from './billing.types';

/**
 * Daily account-state sweep (§3.11, §9.14; S-40). A plain injectable method —
 * the BullMQ shell in billing-queue.ts only schedules and invokes it.
 *
 * Steps, all shop-scoped and idempotent:
 *  1. Trial expiry: TRIALING past cycle_end_at → RESTRICTED.
 *  2. Trial-ending alerts (3 days out, §9.21).
 *  3. RESTRICTED for S-40 (30 days) → READ_ONLY. The restriction date is the
 *     latest `billing.account_state` audit row (append-only, §12); a shop
 *     with no such row falls back to shop.updated_at.
 *  4. Pending downgrades whose cycle has ended are applied (§9.5.6).
 *  5. SUBMITTED usage records reconciled to ACCEPTED (§3.20).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SweepSummary {
  trialsExpired: number;
  trialEndingAlerts: number;
  movedToReadOnly: number;
  downgradesApplied: number;
  usageAccepted: number;
}

@Injectable()
export class AccountSweepService {
  private readonly logger = new Logger(AccountSweepService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
    private readonly overage: OverageService,
    private readonly alerts: BillingAlertsService,
  ) {}

  async runDailySweep(now: Date = new Date()): Promise<SweepSummary> {
    const trialsExpired = await this.expireTrials(now);
    const { alerted } = await this.alerts.alertTrialsEnding(now);
    const movedToReadOnly = await this.restrictedToReadOnly(now);
    const downgradesApplied = await this.applyDueDowngrades(now);
    const usageAccepted = await this.reconcileUsage();
    return {
      trialsExpired,
      trialEndingAlerts: alerted,
      movedToReadOnly,
      downgradesApplied,
      usageAccepted,
    };
  }

  /** §3.11: trial expiry → RESTRICTED (capability ladder applies). */
  private async expireTrials(now: Date): Promise<number> {
    const { rows } = await this.pool.query<{ shop_id: string }>(
      `SELECT DISTINCT shop_id
         FROM subscription
        WHERE state = 'TRIALING'
          AND cycle_end_at IS NOT NULL
          AND cycle_end_at <= $1`,
      [now],
    );
    let count = 0;
    for (const row of rows) {
      const result = await this.billing.applyRestriction(
        row.shop_id,
        'TRIAL_EXPIRED',
      );
      if (result.restricted) count += 1;
    }
    return count;
  }

  /** §3.11 + S-40: RESTRICTED for 30 days → READ_ONLY; writes stop. */
  private async restrictedToReadOnly(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - S40_RESTRICTED_DAYS * DAY_MS);
    const { rows } = await this.pool.query<{
      shop_id: string;
      restricted_since: string | null;
    }>(
      `SELECT s.shop_id,
              COALESCE(
                (SELECT max(a.created_at)
                   FROM audit_log a
                  WHERE a.shop_id = s.shop_id
                    AND a.action = 'billing.account_state'
                    AND a.after->>'to' = 'RESTRICTED'),
                s.updated_at
              ) AS restricted_since
         FROM shop s
        WHERE s.account_state = 'RESTRICTED'`,
    );
    let count = 0;
    for (const row of rows) {
      if (!row.restricted_since) continue;
      if (new Date(row.restricted_since) > cutoff) continue;
      const { rowCount } = await this.pool.query(
        `UPDATE shop SET account_state = 'READ_ONLY'
          WHERE shop_id = $1 AND account_state = 'RESTRICTED'`,
        [row.shop_id],
      );
      if (!rowCount) continue;
      await this.pool.query(
        `UPDATE subscription SET state = 'READ_ONLY'
          WHERE shop_id = $1 AND state = 'RESTRICTED'`,
        [row.shop_id],
      );
      await this.audit.record({
        shopId: row.shop_id,
        actorKind: 'SYSTEM',
        action: 'billing.account_state',
        objectType: 'shop',
        objectId: row.shop_id,
        after: { to: 'READ_ONLY', reason: 'S40_ELAPSED' },
      });
      count += 1;
    }
    return count;
  }

  /**
   * §9.5.6: a downgrade held at request time is applied once the current
   * cycle ends — the new (lower) charge is created at Shopify and activates
   * on the merchant's approval, like any subscription.
   */
  private async applyDueDowngrades(now: Date): Promise<number> {
    const shopIds = await this.redis.smembers(billingKeys.pendingDowngradeSet);
    let applied = 0;
    for (const shopId of shopIds) {
      const planId = await this.redis.get(billingKeys.pendingDowngrade(shopId));
      if (!planId) {
        await this.redis.srem(billingKeys.pendingDowngradeSet, shopId);
        continue;
      }
      const current = await this.billing.currentSubscription(shopId);
      const cycleEnd = current?.subscription.cycle_end_at;
      if (cycleEnd && new Date(cycleEnd) > now) continue; // not due yet
      try {
        const result = await this.billing.createSubscription(
          shopId,
          null,
          planId,
        );
        if (result.created) {
          await this.redis.del(billingKeys.pendingDowngrade(shopId));
          await this.redis.srem(billingKeys.pendingDowngradeSet, shopId);
          applied += 1;
        }
      } catch (err) {
        // §5.7 control 4: error class only, no PII. Retried next sweep.
        this.logger.warn(
          `downgrade apply failed for a shop: ${(err as Error).name}`,
        );
      }
    }
    return applied;
  }

  /** §3.20: promote SUBMITTED usage records to ACCEPTED, per shop. */
  private async reconcileUsage(): Promise<number> {
    const { rows } = await this.pool.query<{ shop_id: string }>(
      `SELECT DISTINCT shop_id FROM usage_record WHERE state = 'SUBMITTED'`,
    );
    let total = 0;
    for (const row of rows) {
      try {
        total += (await this.overage.reconcileSubmittedUsage(row.shop_id)).accepted;
      } catch (err) {
        this.logger.warn(
          `usage reconcile failed for a shop: ${(err as Error).name}`,
        );
      }
    }
    return total;
  }
}
