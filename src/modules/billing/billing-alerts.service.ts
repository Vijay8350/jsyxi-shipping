import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import { NotificationService } from '../notifications/notification.service';
import { NOTIFICATION_EVENTS } from '../notifications/notifications.types';
import { EntitlementLedgerService } from '../platform/ledger/entitlement-ledger.service';
import {
  ALLOWANCE_ALERT_PCT_100,
  ALLOWANCE_ALERT_PCT_80,
  billingKeys,
  TRIAL_ENDING_ALERT_DAYS,
} from './billing.types';

/**
 * Billing alerts (§9.14/§9.21): the Owner is told at 80% and 100% of the
 * allowance and three days before trial end. Each alert fires ONCE per
 * subscription cycle (Redis NX dedupe keyed on subscription + cycle); the
 * notification layer applies its own S-45 toggles on top. INV-21: nothing
 * here gates a business action — alerts are fire-and-observe.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type AllowanceAlertFired = '80' | '100' | null;

@Injectable()
export class BillingAlertsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly notifications: NotificationService,
    private readonly ledger: EntitlementLedgerService,
  ) {}

  /**
   * Called after an entitlement debit (binding point: the booking worker)
   * and by the daily sweep. Fires the highest crossed, not-yet-fired
   * threshold for the current cycle.
   */
  async checkAllowanceThresholds(shopId: string): Promise<AllowanceAlertFired> {
    const { rows } = await this.pool.query<{
      subscription_id: string;
      cycle_start_at: string | null;
      cycle_end_at: string | null;
      awb_allowance_per_cycle: number;
    }>(
      `SELECT s.subscription_id, s.cycle_start_at, s.cycle_end_at,
              p.awb_allowance_per_cycle
         FROM subscription s
         JOIN plan p ON p.plan_id = s.plan_id
        WHERE s.shop_id = $1 AND s.state IN ('TRIALING', 'ACTIVE')
        ORDER BY s.created_at DESC LIMIT 1`,
      [shopId],
    );
    const sub = rows[0];
    if (!sub || !sub.cycle_start_at || sub.awb_allowance_per_cycle <= 0) {
      return null;
    }
    const tally = await this.ledger.allowanceBalance(
      sub.subscription_id,
      sub.cycle_start_at,
    );
    const pct = Math.floor(
      (tally.consumed * 100) / sub.awb_allowance_per_cycle,
    );
    const cycleIso = new Date(sub.cycle_start_at).toISOString();
    // Longer than any cycle; the key is cycle-scoped so it resets naturally.
    const ttlMs = 45 * DAY_MS;

    if (pct >= ALLOWANCE_ALERT_PCT_100) {
      const key = billingKeys.allowanceAlert(
        sub.subscription_id,
        cycleIso,
        ALLOWANCE_ALERT_PCT_100,
      );
      if (await this.redis.set(key, '1', 'PX', ttlMs, 'NX')) {
        await this.notifications.notify(shopId, NOTIFICATION_EVENTS.ALLOWANCE_100, {
          subject: 'Allowance exhausted',
          body: `Your plan allowance of ${sub.awb_allowance_per_cycle} AWBs is fully used this cycle. Further AWBs are billed as overage up to your approved cap (§9.5.6).`,
          link: '/billing',
        });
        return '100';
      }
      return null;
    }
    if (pct >= ALLOWANCE_ALERT_PCT_80) {
      const key = billingKeys.allowanceAlert(
        sub.subscription_id,
        cycleIso,
        ALLOWANCE_ALERT_PCT_80,
      );
      if (await this.redis.set(key, '1', 'PX', ttlMs, 'NX')) {
        await this.notifications.notify(shopId, NOTIFICATION_EVENTS.ALLOWANCE_80, {
          subject: 'Allowance at 80%',
          body: `You have used ${tally.consumed} of ${sub.awb_allowance_per_cycle} AWBs this cycle. Upgrade from Plan & billing if you expect more volume.`,
          link: '/billing',
        });
        return '80';
      }
    }
    return null;
  }

  /**
   * §9.21 sweep step: TRIALING subscriptions ending within
   * TRIAL_ENDING_ALERT_DAYS alert the Owner, once per trial.
   */
  async alertTrialsEnding(now: Date = new Date()): Promise<{ alerted: number }> {
    const horizon = new Date(
      now.getTime() + TRIAL_ENDING_ALERT_DAYS * DAY_MS,
    );
    const { rows } = await this.pool.query<{
      shop_id: string;
      subscription_id: string;
      cycle_end_at: string;
    }>(
      `SELECT shop_id, subscription_id, cycle_end_at
         FROM subscription
        WHERE state = 'TRIALING'
          AND cycle_end_at IS NOT NULL
          AND cycle_end_at > $1
          AND cycle_end_at <= $2`,
      [now, horizon],
    );
    let alerted = 0;
    for (const row of rows) {
      const key = billingKeys.trialEndingAlert(row.subscription_id);
      if (!(await this.redis.set(key, '1', 'PX', 45 * DAY_MS, 'NX'))) continue;
      const daysLeft = Math.max(
        1,
        Math.ceil(
          (new Date(row.cycle_end_at).getTime() - now.getTime()) / DAY_MS,
        ),
      );
      await this.notifications.notify(row.shop_id, NOTIFICATION_EVENTS.TRIAL_ENDING, {
        subject: `Your trial ends in ${daysLeft} day(s)`,
        body: `Your Jsyxi trial ends in ${daysLeft} day(s). Subscribe from Plan & billing to keep booking without interruption — after expiry the account becomes RESTRICTED (§3.11).`,
        link: '/billing',
      });
      alerted += 1;
    }
    return { alerted };
  }
}
