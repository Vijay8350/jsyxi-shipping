import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { EntitlementLedgerService } from '../../src/modules/platform/ledger/entitlement-ledger.service';
import { AccountSweepService } from '../../src/modules/billing/account-sweep.service';
import { BillingAlertsService } from '../../src/modules/billing/billing-alerts.service';
import { BillingService } from '../../src/modules/billing/billing.service';
import { OverageService } from '../../src/modules/billing/overage.service';
import { NOTIFICATION_EVENTS } from '../../src/modules/notifications/notifications.types';
import {
  FnPool,
  fakeRedis,
  mockAudit,
  mockLedger,
  mockNotify,
  SHOP_ID,
  SUBSCRIPTION_ID,
} from './helpers';

/**
 * Alerts (§9.14/§9.21) and the daily account-state sweep (§3.11, S-40):
 * 80%/100% allowance alerts, trial-ending 3 days out, trial expiry →
 * RESTRICTED, RESTRICTED 30d → READ_ONLY, due downgrades applied.
 */

function makeAlerts(pool: FnPool, consumed: number) {
  const redis = fakeRedis();
  const notify = mockNotify();
  const service = new BillingAlertsService(
    pool.asPool(),
    redis as never,
    notify as never,
    mockLedger(consumed) as unknown as EntitlementLedgerService,
  );
  return { service, redis, notify };
}

function allowanceSubRow(consumedAllowance = 500) {
  return {
    subscription_id: SUBSCRIPTION_ID,
    cycle_start_at: '2026-07-01T00:00:00.000Z',
    cycle_end_at: '2026-07-31T00:00:00.000Z',
    awb_allowance_per_cycle: consumedAllowance,
  };
}

describe('BillingAlertsService.checkAllowanceThresholds (§9.14)', () => {
  let pool: FnPool;
  beforeEach(() => {
    pool = new FnPool();
    pool.on(/FROM subscription s\s+JOIN plan p/, [allowanceSubRow()]);
  });

  it('fires ALLOWANCE_80 once per cycle at 80%', async () => {
    const { service, notify } = makeAlerts(pool, 400); // 400/500 = 80%
    expect(await service.checkAllowanceThresholds(SHOP_ID)).toBe('80');
    expect(await service.checkAllowanceThresholds(SHOP_ID)).toBeNull();
    const events = notify.calls.map((c) => c.event);
    expect(events).toEqual([NOTIFICATION_EVENTS.ALLOWANCE_80]);
  });

  it('fires ALLOWANCE_100 once per cycle at 100% (and not the 80% alert on top)', async () => {
    const { service, notify } = makeAlerts(pool, 500);
    expect(await service.checkAllowanceThresholds(SHOP_ID)).toBe('100');
    expect(await service.checkAllowanceThresholds(SHOP_ID)).toBeNull();
    const events = notify.calls.map((c) => c.event);
    expect(events).toEqual([NOTIFICATION_EVENTS.ALLOWANCE_100]);
  });

  it('fires nothing below 80%', async () => {
    const { service, notify } = makeAlerts(pool, 399); // 79%
    expect(await service.checkAllowanceThresholds(SHOP_ID)).toBeNull();
    expect(notify.calls).toHaveLength(0);
  });
});

describe('BillingAlertsService.alertTrialsEnding (§9.21: 3 days before)', () => {
  it('alerts the Owner once for a trial ending within 3 days', async () => {
    const pool = new FnPool();
    const now = new Date('2026-07-12T00:00:00.000Z');
    pool.on(/FROM subscription\s+WHERE state = 'TRIALING'/, [
      {
        shop_id: SHOP_ID,
        subscription_id: SUBSCRIPTION_ID,
        cycle_end_at: '2026-07-14T00:00:00.000Z', // 2 days out
      },
    ]);
    const { service, notify } = makeAlerts(pool, 0);

    expect(await service.alertTrialsEnding(now)).toEqual({ alerted: 1 });
    expect(await service.alertTrialsEnding(now)).toEqual({ alerted: 0 });
    expect(notify.calls.map((c) => c.event)).toEqual([
      NOTIFICATION_EVENTS.TRIAL_ENDING,
    ]);
    expect(notify.calls[0].context).toMatchObject({
      subject: 'Your trial ends in 2 day(s)',
    });
  });
});

describe('AccountSweepService.runDailySweep (§3.11, S-40)', () => {
  let pool: FnPool;
  let redis: ReturnType<typeof fakeRedis>;
  let audit: ReturnType<typeof mockAudit>;
  let billing: {
    applyRestriction: ReturnType<typeof vi.fn>;
    currentSubscription: ReturnType<typeof vi.fn>;
    createSubscription: ReturnType<typeof vi.fn>;
  };
  let overage: { reconcileSubmittedUsage: ReturnType<typeof vi.fn> };
  let sweep: AccountSweepService;

  beforeEach(() => {
    pool = new FnPool();
    redis = fakeRedis();
    audit = mockAudit();
    billing = {
      applyRestriction: vi.fn(() => Promise.resolve({ restricted: true })),
      currentSubscription: vi.fn(() => Promise.resolve(null)),
      createSubscription: vi.fn(() => Promise.resolve({ created: true })),
    };
    overage = {
      reconcileSubmittedUsage: vi.fn(() => Promise.resolve({ accepted: 2 })),
    };
    const notify = mockNotify();
    const alerts = new BillingAlertsService(
      pool.asPool(),
      redis as never,
      notify as never,
      mockLedger(0) as unknown as EntitlementLedgerService,
    );
    sweep = new AccountSweepService(
      pool.asPool(),
      redis as never,
      audit as unknown as AuditService,
      billing as unknown as BillingService,
      overage as unknown as OverageService,
      alerts,
    );
  });

  it('expires trials past cycle_end_at into RESTRICTED', async () => {
    const now = new Date('2026-07-15T00:00:00.000Z');
    pool.on(/SELECT DISTINCT shop_id\s+FROM subscription\s+WHERE state = 'TRIALING'/, [
      { shop_id: SHOP_ID },
    ]);
    const summary = await sweep.runDailySweep(now);
    expect(summary.trialsExpired).toBe(1);
    expect(billing.applyRestriction).toHaveBeenCalledWith(
      SHOP_ID,
      'TRIAL_EXPIRED',
    );
  });

  it('moves RESTRICTED → READ_ONLY only after S-40 (30 days)', async () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    pool.on(/FROM shop s\s+WHERE s\.account_state = 'RESTRICTED'/, [
      // Restricted 31 days ago — the audit_log is the clock (§12 append-only).
      { shop_id: SHOP_ID, restricted_since: '2026-07-01T00:00:00.000Z' },
      {
        shop_id: '22222222-2222-2222-2222-222222222222',
        restricted_since: '2026-07-25T00:00:00.000Z', // only 7 days — stays
      },
    ]);
    pool.on(/UPDATE shop SET account_state = 'READ_ONLY'/, [], 1);

    const summary = await sweep.runDailySweep(now);

    expect(summary.movedToReadOnly).toBe(1);
    const updates = pool.matching(/UPDATE shop SET account_state = 'READ_ONLY'/);
    expect(updates).toHaveLength(1);
    expect(updates[0].params[0]).toBe(SHOP_ID);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.account_state',
        after: { to: 'READ_ONLY', reason: 'S40_ELAPSED' },
      }),
    );
  });

  it('applies a due pending downgrade at cycle end (§9.5.6) and leaves a future one pending', async () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    const otherShop = '22222222-2222-2222-2222-222222222222';
    redis.strings.set('billing:pending-downgrade:' + SHOP_ID, 'plan-a');
    redis.strings.set('billing:pending-downgrade:' + otherShop, 'plan-b');
    redis.sets.set(
      'billing:pending-downgrades',
      new Set([SHOP_ID, otherShop]),
    );
    billing.currentSubscription.mockImplementation((shopId: string) =>
      Promise.resolve(
        shopId === SHOP_ID
          ? {
              subscription: { cycle_end_at: '2026-07-31T00:00:00.000Z' },
              plan: {},
            }
          : {
              subscription: { cycle_end_at: '2026-08-31T00:00:00.000Z' },
              plan: {},
            },
      ),
    );

    const summary = await sweep.runDailySweep(now);

    expect(summary.downgradesApplied).toBe(1);
    expect(billing.createSubscription).toHaveBeenCalledTimes(1);
    expect(billing.createSubscription).toHaveBeenCalledWith(
      SHOP_ID,
      null,
      'plan-a',
    );
    // Due shop cleared from the set; the future one remains pending.
    expect(redis.sets.get('billing:pending-downgrades')?.has(SHOP_ID)).toBe(
      false,
    );
    expect(redis.sets.get('billing:pending-downgrades')?.has(otherShop)).toBe(
      true,
    );
  });

  it('reconciles SUBMITTED usage records to ACCEPTED (§3.20)', async () => {
    pool.on(/SELECT DISTINCT shop_id FROM usage_record WHERE state = 'SUBMITTED'/, [
      { shop_id: SHOP_ID },
    ]);
    const summary = await sweep.runDailySweep(new Date());
    expect(summary.usageAccepted).toBe(2);
    expect(overage.reconcileSubmittedUsage).toHaveBeenCalledWith(SHOP_ID);
  });
});
