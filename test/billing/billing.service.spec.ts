import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { EntitlementLedgerService } from '../../src/modules/platform/ledger/entitlement-ledger.service';
import { BillingService } from '../../src/modules/billing/billing.service';
import { ShopifyBillingClient } from '../../src/modules/billing/shopify-billing.client';
import { billingKeys } from '../../src/modules/billing/billing.types';
import {
  FnPool,
  MEMBER_ID,
  mockAudit,
  mockLedger,
  mockShopifyBilling,
  fakeRedis,
  PLAN_PRO_ID,
  PLAN_STARTER_ID,
  PLAN_TRIAL_ID,
  planRow,
  proPlanRow,
  SHOP_ID,
  SUB_GID,
  subscriptionRow,
  trialPlanRow,
} from './helpers';

/**
 * Subscription lifecycle (§9.14, §9.5.6, §3.11): create → approve at Shopify
 * → ACTIVE on the confirmation redirect; upgrade after approval; downgrade
 * at next cycle; cancel → RESTRICTED; resubscribe → ACTIVE with a new
 * allowance period.
 */

function makeService(pool: FnPool) {
  const redis = fakeRedis();
  const audit = mockAudit();
  const shopify = mockShopifyBilling();
  const config = {
    get: (key: string) =>
      key === 'shopify.appUrl' ? 'https://app.jsyxi.com' : undefined,
  };
  const service = new BillingService(
    pool.asPool(),
    redis as never,
    config as unknown as ConfigService,
    audit as unknown as AuditService,
    mockLedger() as unknown as EntitlementLedgerService,
    shopify as unknown as ShopifyBillingClient,
  );
  return { service, redis, audit, shopify };
}

describe('BillingService.createSubscription (§9.14)', () => {
  let pool: FnPool;
  beforeEach(() => {
    pool = new FnPool();
  });

  it('creates the charge with cappedAmount + remaining trial days and a returnUrl back to the app', async () => {
    pool.on(/FROM plan WHERE plan_id = \$1 AND is_active/, [planRow()]);
    // TRIALING subscription with 10 days left → trialDays 10 (S-39 remainder).
    pool.on(/FROM subscription s\s+WHERE s\.shop_id = \$1 AND s\.state = 'TRIALING'/, [
      { cycle_end_at: new Date(Date.now() + 10 * 86_400_000).toISOString() },
    ]);
    const { service, shopify, audit } = makeService(pool);

    const result = await service.createSubscription(
      SHOP_ID,
      MEMBER_ID,
      PLAN_STARTER_ID,
    );

    expect(result.created).toBe(true);
    if (result.created) {
      expect(result.confirmationUrl).toContain('charges/confirm');
    }
    const input = shopify.createSubscription.mock.calls[0][1];
    expect(input.name).toBe('Jsyxi Starter');
    expect(input.returnUrl).toBe('https://app.jsyxi.com/billing/confirm');
    expect(input.trialDays).toBe(10);
    // Default cap: one cycle's allowance worth of overage (500 × ₹2).
    expect(input.cappedAmount).toBe('1000.00');
    expect(input.recurringPrice).toBe('499.00');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.subscription.create_requested',
        after: expect.objectContaining({ trialDays: 10 }),
      }),
    );
  });

  it('offers no usage line item when the plan has no overage price', async () => {
    pool.on(/FROM plan WHERE plan_id = \$1 AND is_active/, [
      planRow({ overage_unit_price: '0.0000' }),
    ]);
    const { service, shopify } = makeService(pool);
    const result = await service.createSubscription(
      SHOP_ID,
      MEMBER_ID,
      PLAN_STARTER_ID,
    );
    expect(result.created).toBe(true);
    expect(shopify.createSubscription.mock.calls[0][1].cappedAmount).toBeNull();
  });

  it('never bills the TRIAL plan — it is the S-39 local seed', async () => {
    pool.on(/FROM plan WHERE plan_id = \$1 AND is_active/, [trialPlanRow()]);
    const { service, shopify } = makeService(pool);
    const result = await service.createSubscription(
      SHOP_ID,
      MEMBER_ID,
      PLAN_TRIAL_ID,
    );
    expect(result).toEqual({
      created: false,
      reason: 'TRIAL_PLAN_NOT_BILLABLE',
    });
    expect(shopify.createSubscription).not.toHaveBeenCalled();
  });
});

describe('BillingService.confirmSubscription (§9.14: ACTIVE on approval)', () => {
  let pool: FnPool;
  beforeEach(() => {
    pool = new FnPool();
  });

  it('activates a new subscription + cycle and moves the shop to ACTIVE (resubscribe, §3.11)', async () => {
    pool.on(/FROM plan WHERE is_active/, [planRow()]);
    pool.on(/INSERT INTO subscription/, [{ subscription_id: 'new-sub-id' }], 1);
    const { service, audit } = makeService(pool);

    const result = await service.confirmSubscription(SHOP_ID, MEMBER_ID);

    expect(result).toEqual({
      activated: true,
      subscriptionId: 'new-sub-id',
      planCode: 'STARTER',
    });
    const insert = pool.matching(/INSERT INTO subscription/)[0];
    expect(insert.params[1]).toBe(PLAN_STARTER_ID);
    expect(insert.params[2]).toBe(SUB_GID);
    // New allowance period: fresh cycle window on the new row.
    expect(insert.sql).toContain("'ACTIVE'");
    // The approved cap is stored back — the booking gate reads it (§9.5.6).
    expect(insert.params[5]).toBe('500.00');
    const shopUpdate = pool.matching(
      /UPDATE shop SET account_state = 'ACTIVE'/,
    )[0];
    expect(shopUpdate.sql).toContain(
      "IN ('TRIALING', 'ACTIVE', 'RESTRICTED', 'READ_ONLY')",
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.account_state',
        after: { to: 'ACTIVE', reason: 'SUBSCRIBED' },
      }),
    );
  });

  it('is idempotent on a replayed redirect for an already-recorded GID', async () => {
    pool.on(
      /SELECT subscription_id, state FROM subscription\s+WHERE shop_id = \$1 AND shopify_subscription_gid = \$2/,
      [{ subscription_id: 'existing-sub', state: 'ACTIVE' }],
    );
    pool.on(/SELECT p\.code FROM subscription s JOIN plan p/, [
      { code: 'STARTER' },
    ]);
    const { service } = makeService(pool);

    const result = await service.confirmSubscription(SHOP_ID, MEMBER_ID);

    expect(result).toEqual({
      activated: true,
      subscriptionId: 'existing-sub',
      planCode: 'STARTER',
    });
    expect(pool.matching(/INSERT INTO subscription/)).toHaveLength(0);
  });

  it('activates nothing when Shopify shows no approved subscription', async () => {
    const { service, shopify } = makeService(pool);
    shopify.activeSubscriptions.mockResolvedValue([]);
    const result = await service.confirmSubscription(SHOP_ID, MEMBER_ID);
    expect(result).toEqual({
      activated: false,
      reason: 'NO_APPROVED_SUBSCRIPTION',
    });
    expect(pool.matching(/INSERT INTO subscription/)).toHaveLength(0);
  });
});

describe('BillingService.requestPlanChange (§9.5.6 timing)', () => {
  let pool: FnPool;
  beforeEach(() => {
    pool = new FnPool();
  });

  it('upgrade → Shopify charge immediately, effective AFTER_APPROVAL', async () => {
    pool.on(/FROM subscription s\s+WHERE s\.shop_id = \$1\s+ORDER BY s\.created_at DESC/, [
      subscriptionRow(),
    ]);
    pool.on(/FROM plan WHERE plan_id = \$1 AND is_active/, [proPlanRow()]);
    const { service, shopify } = makeService(pool);

    const result = await service.requestPlanChange(
      SHOP_ID,
      MEMBER_ID,
      PLAN_PRO_ID,
    );

    expect(result.changed).toBe(true);
    if (result.changed) {
      expect(result.timing).toBe('AFTER_APPROVAL');
    }
    expect(shopify.createSubscription).toHaveBeenCalled();
  });

  it('downgrade → held as a pending change for the NEXT_CYCLE', async () => {
    pool.on(/FROM subscription s\s+WHERE s\.shop_id = \$1\s+ORDER BY s\.created_at DESC/, [
      subscriptionRow({ plan_id: PLAN_PRO_ID, plan: proPlanRow() }),
    ]);
    pool.on(/FROM plan WHERE plan_id = \$1 AND is_active/, [planRow()]);
    const { service, redis, shopify, audit } = makeService(pool);

    const result = await service.requestPlanChange(
      SHOP_ID,
      MEMBER_ID,
      PLAN_STARTER_ID,
    );

    expect(result).toEqual({
      changed: true,
      timing: 'NEXT_CYCLE',
      effectiveAt: '2026-07-31T00:00:00.000Z',
    });
    // No Shopify charge yet — the daily sweep creates it at cycle end.
    expect(shopify.createSubscription).not.toHaveBeenCalled();
    expect(redis.strings.get(billingKeys.pendingDowngrade(SHOP_ID))).toBe(
      PLAN_STARTER_ID,
    );
    expect(redis.sets.get(billingKeys.pendingDowngradeSet)?.has(SHOP_ID)).toBe(
      true,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.plan_change.scheduled',
        after: expect.objectContaining({ timing: 'NEXT_CYCLE' }),
      }),
    );
  });

  it('rejects a change to the same plan', async () => {
    pool.on(/FROM subscription s\s+WHERE s\.shop_id = \$1\s+ORDER BY s\.created_at DESC/, [
      subscriptionRow(),
    ]);
    const { service } = makeService(pool);
    const result = await service.requestPlanChange(
      SHOP_ID,
      MEMBER_ID,
      PLAN_STARTER_ID,
    );
    expect(result).toEqual({ changed: false, reason: 'SAME_PLAN' });
  });
});

describe('BillingService.cancel / applyRestriction (§3.11)', () => {
  let pool: FnPool;
  beforeEach(() => {
    pool = new FnPool();
  });

  it('cancels at Shopify and moves the shop TRIALING/ACTIVE → RESTRICTED', async () => {
    pool.on(/FROM subscription s\s+WHERE s\.shop_id = \$1\s+ORDER BY s\.created_at DESC/, [
      subscriptionRow(),
    ]);
    pool.on(/UPDATE shop SET account_state = 'RESTRICTED'/, [], 1);
    const { service, shopify, audit } = makeService(pool);

    const result = await service.cancel(SHOP_ID, MEMBER_ID);

    expect(result.cancelled).toBe(true);
    expect(shopify.cancelSubscription).toHaveBeenCalledWith(SHOP_ID, SUB_GID);
    const shopUpdate = pool.matching(
      /UPDATE shop SET account_state = 'RESTRICTED'/,
    )[0];
    // Only the live states transition — READ_ONLY/UNINSTALLED never walk back.
    expect(shopUpdate.sql).toContain("IN ('TRIALING', 'ACTIVE')");
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.account_state',
        after: { to: 'RESTRICTED', reason: 'CANCELLED' },
      }),
    );
    // A pending downgrade is moot once cancelled.
  });

  it('applyRestriction is a no-op from non-live states (idempotent)', async () => {
    pool.on(/UPDATE shop SET account_state = 'RESTRICTED'/, [], 0);
    const { service, audit } = makeService(pool);
    const result = await service.applyRestriction(SHOP_ID, 'TRIAL_EXPIRED');
    expect(result).toEqual({ restricted: false });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('maps external Shopify statuses onto §3.11 triggers', async () => {
    pool.on(/UPDATE shop SET account_state = 'RESTRICTED'/, [], 1);
    const { service } = makeService(pool);
    expect((await service.applyExternalStatus(SHOP_ID, 'DECLINED')).mapped).toBe(
      'PAYMENT_FAILED',
    );
    expect((await service.applyExternalStatus(SHOP_ID, 'FROZEN')).mapped).toBe(
      'STORE_FROZEN',
    );
    expect((await service.applyExternalStatus(SHOP_ID, 'CANCELLED')).mapped).toBe(
      'CANCELLED',
    );
    expect((await service.applyExternalStatus(SHOP_ID, 'PENDING')).mapped).toBe(
      'IGNORED',
    );
  });
});

describe('BillingService.billingHistory (§9.14)', () => {
  it('lists subscriptions, usage records and credits, all shop-scoped (INV-1)', async () => {
    const pool = new FnPool();
    const { service } = makeService(pool);
    await service.billingHistory(SHOP_ID);
    const queries = pool.matching(/FROM (subscription s|usage_record|overage_credit)/);
    expect(queries.length).toBe(3);
    for (const q of queries) {
      expect(q.sql).toContain('shop_id = $1');
      expect(q.params[0]).toBe(SHOP_ID);
    }
  });
});
