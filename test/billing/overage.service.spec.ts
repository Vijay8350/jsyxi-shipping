import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { EntitlementLedgerService } from '../../src/modules/platform/ledger/entitlement-ledger.service';
import { OverageService } from '../../src/modules/billing/overage.service';
import {
  ShopifyBillingClient,
  ShopifyBillingUserError,
} from '../../src/modules/billing/shopify-billing.client';
import {
  FnPool,
  mockAudit,
  mockLedger,
  mockShopifyBilling,
  SHIPMENT_ID,
  SHIPMENT_ID_2,
  SHOP_ID,
  SUBSCRIPTION_ID,
  SUB_GID,
  subscriptionRow,
  USAGE_GID,
  USAGE_LINE_ITEM_GID,
  usageRecordRow,
} from './helpers';

/**
 * Overage (§9.5.6, §3.20): one usage_record per overage AWB with a stable
 * idempotency key; cap enforcement; credit-hold vs reversal; and the
 * never-negative-usage invariant.
 */

function makeService(pool: FnPool, consumed: number) {
  const audit = mockAudit();
  const ledger = mockLedger(consumed);
  const shopify = mockShopifyBilling();
  const service = new OverageService(
    pool.asPool(),
    audit as unknown as AuditService,
    ledger as unknown as EntitlementLedgerService,
    shopify as unknown as ShopifyBillingClient,
  );
  return { service, audit, ledger, shopify };
}

const OVERAGE_CONSUMED = 501; // plan allowance is 500

describe('OverageService.recordOverageForShipment (§9.5.6)', () => {
  let pool: FnPool;
  beforeEach(() => {
    pool = new FnPool();
    pool.on(/FROM subscription s\s+WHERE s\.subscription_id = \$1/, [
      subscriptionRow(),
    ]);
  });

  it('does nothing while the cycle is within the plan allowance', async () => {
    const { service, shopify } = makeService(pool, 500);
    const result = await service.recordOverageForShipment({
      shopId: SHOP_ID,
      subscriptionId: SUBSCRIPTION_ID,
      shipmentId: SHIPMENT_ID,
    });
    expect(result).toEqual({ recorded: false, reason: 'WITHIN_ALLOWANCE' });
    expect(pool.matching(/INSERT INTO usage_record/)).toHaveLength(0);
    expect(shopify.createUsageRecord).not.toHaveBeenCalled();
  });

  it('emits ONE usage record per overage AWB and stores the returned GID', async () => {
    pool.on(/SELECT sum\(amount\)::text AS total/, [{ total: '10.0000' }]);
    pool.on(/INSERT INTO usage_record/, [{ usage_id: 'usage-1' }], 1);
    const { service, shopify, audit } = makeService(pool, OVERAGE_CONSUMED);

    const result = await service.recordOverageForShipment({
      shopId: SHOP_ID,
      subscriptionId: SUBSCRIPTION_ID,
      shipmentId: SHIPMENT_ID,
    });

    expect(result).toEqual({
      recorded: true,
      submitted: true,
      usageId: 'usage-1',
      shopifyGid: USAGE_GID,
    });
    const insert = pool.matching(/INSERT INTO usage_record/)[0];
    // Stable idempotency key: shop + shipment + cycle.
    expect(insert.params[2]).toBe(
      `overage:${SHOP_ID}:${SHIPMENT_ID}:2026-07-01T00:00:00.000Z`,
    );
    expect(insert.params[3]).toBe('2.0000'); // plan overage unit price
    expect(shopify.createUsageRecord).toHaveBeenCalledTimes(1);
    expect(shopify.createUsageRecord.mock.calls[0][1]).toBe(
      USAGE_LINE_ITEM_GID,
    );
    expect(shopify.createUsageRecord.mock.calls[0][2]).toBe('2.0000');
    const update = pool.matching(/UPDATE usage_record[\s\S]*'SUBMITTED'/)[0];
    expect(update.params[1]).toBe(USAGE_GID); // stored external ID
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'billing.overage.submitted' }),
    );
  });

  it('is idempotent: the same shipment never emits twice, even on retry (A1-04)', async () => {
    // ON CONFLICT DO NOTHING → no row returned: the key already exists.
    pool.on(/INSERT INTO usage_record/, [], 0);
    const { service, shopify } = makeService(pool, OVERAGE_CONSUMED);

    const result = await service.recordOverageForShipment({
      shopId: SHOP_ID,
      subscriptionId: SUBSCRIPTION_ID,
      shipmentId: SHIPMENT_ID,
    });

    expect(result).toEqual({ recorded: false, reason: 'ALREADY_RECORDED' });
    expect(shopify.createUsageRecord).not.toHaveBeenCalled();
  });

  it('blocks when the approved capped_amount cannot cover the charge', async () => {
    pool.on(/SELECT sum\(amount\)::text AS total/, [{ total: '499.0000' }]);
    const { service, shopify } = makeService(pool, OVERAGE_CONSUMED);

    const result = await service.recordOverageForShipment({
      shopId: SHOP_ID,
      subscriptionId: SUBSCRIPTION_ID,
      shipmentId: SHIPMENT_ID,
    });

    // ₹499 charged + ₹2 unit > ₹500 cap → blocked (approve-or-upgrade).
    expect(result).toEqual({ recorded: false, reason: 'CAP_EXCEEDED' });
    expect(pool.matching(/INSERT INTO usage_record/)).toHaveLength(0);
    expect(shopify.createUsageRecord).not.toHaveBeenCalled();
  });

  it('blocks when no cap was approved at all (capped_amount NULL)', async () => {
    pool.on(/FROM subscription s\s+WHERE s\.subscription_id = \$1/, [
      subscriptionRow({ capped_amount: null }),
    ]);
    const { service, shopify } = makeService(pool, OVERAGE_CONSUMED);
    const result = await service.recordOverageForShipment({
      shopId: SHOP_ID,
      subscriptionId: SUBSCRIPTION_ID,
      shipmentId: SHIPMENT_ID,
    });
    expect(result).toEqual({ recorded: false, reason: 'CAP_EXCEEDED' });
    expect(shopify.createUsageRecord).not.toHaveBeenCalled();
  });

  it('an unconsumed overage_credit covers the AWB — no Shopify charge at all', async () => {
    pool.on(/UPDATE overage_credit SET consumed_at = now\(\)/, [
      { credit_id: 'credit-1' },
    ]);
    const { service, shopify, audit } = makeService(pool, OVERAGE_CONSUMED);

    const result = await service.recordOverageForShipment({
      shopId: SHOP_ID,
      subscriptionId: SUBSCRIPTION_ID,
      shipmentId: SHIPMENT_ID_2,
    });

    expect(result).toEqual({
      recorded: false,
      reason: 'COVERED_BY_CREDIT',
      creditId: 'credit-1',
    });
    expect(pool.matching(/INSERT INTO usage_record/)).toHaveLength(0);
    expect(shopify.createUsageRecord).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'billing.overage.credit_consumed',
      }),
    );
  });

  it('a Shopify refusal moves the record to REJECTED (terminal, §3.20)', async () => {
    pool.on(/SELECT sum\(amount\)::text AS total/, [{ total: '0' }]);
    pool.on(/INSERT INTO usage_record/, [{ usage_id: 'usage-2' }], 1);
    const { service, shopify } = makeService(pool, OVERAGE_CONSUMED);
    shopify.createUsageRecord.mockRejectedValue(
      new ShopifyBillingUserError([{ message: 'cap reached' }]),
    );

    const result = await service.recordOverageForShipment({
      shopId: SHOP_ID,
      subscriptionId: SUBSCRIPTION_ID,
      shipmentId: SHIPMENT_ID,
    });

    expect(result).toMatchObject({
      recorded: true,
      submitted: false,
      reason: 'REJECTED_BY_SHOPIFY',
    });
    expect(
      pool.matching(/UPDATE usage_record SET state = 'REJECTED'/),
    ).toHaveLength(1);
  });

  it('an ambiguous submit failure never auto-resubmits (no double charge)', async () => {
    pool.on(/SELECT sum\(amount\)::text AS total/, [{ total: '0' }]);
    pool.on(/INSERT INTO usage_record/, [{ usage_id: 'usage-3' }], 1);
    const { service, shopify } = makeService(pool, OVERAGE_CONSUMED);
    shopify.createUsageRecord.mockRejectedValue(new Error('socket hang up'));

    const result = await service.recordOverageForShipment({
      shopId: SHOP_ID,
      subscriptionId: SUBSCRIPTION_ID,
      shipmentId: SHIPMENT_ID,
    });

    expect(result).toMatchObject({
      recorded: true,
      submitted: false,
      reason: 'SUBMIT_AMBIGUOUS',
    });
    // Stamped as submitted-once; the row stays PENDING for review.
    const stamp = pool.matching(
      /UPDATE usage_record SET submitted_at = now\(\)/,
    );
    expect(stamp).toHaveLength(1);
    expect(pool.matching(/state = 'SUBMITTED'/)).toHaveLength(0);
  });
});

describe('OverageService.reverseOverageForShipment (§9.5.6 reversal)', () => {
  let pool: FnPool;
  beforeEach(() => {
    pool = new FnPool();
  });

  const reverseInput = {
    shopId: SHOP_ID,
    subscriptionId: SUBSCRIPTION_ID,
    shipmentId: SHIPMENT_ID,
  };

  it('does nothing when no usage record exists for the shipment', async () => {
    const { service } = makeService(pool, 0);
    const result = await service.reverseOverageForShipment(reverseInput);
    expect(result).toEqual({ handled: false, reason: 'NO_USAGE_RECORD' });
  });

  it('an unsubmitted PENDING record is marked REVERSED — it was never charged', async () => {
    pool.on(/FROM usage_record\s+WHERE shop_id = \$1 AND idempotency_key LIKE \$2/, [
      usageRecordRow({
        state: 'PENDING',
        shopify_usage_record_gid: null,
        submitted_at: null,
      }),
    ]);
    const { service, audit } = makeService(pool, 0);

    const result = await service.reverseOverageForShipment(reverseInput);

    expect(result).toMatchObject({
      handled: true,
      outcome: 'REVERSED_UNSUBMITTED',
    });
    expect(
      pool.matching(/UPDATE usage_record SET state = 'REVERSED'/),
    ).toHaveLength(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'billing.overage.reversed' }),
    );
  });

  it('an ambiguous PENDING (submit attempted, outcome unknown) reverses nothing and flags review', async () => {
    pool.on(/FROM usage_record\s+WHERE shop_id = \$1 AND idempotency_key LIKE \$2/, [
      usageRecordRow({
        state: 'PENDING',
        shopify_usage_record_gid: null,
        submitted_at: '2026-07-10T00:00:00.000Z',
      }),
    ]);
    const { service } = makeService(pool, 0);

    const result = await service.reverseOverageForShipment(reverseInput);

    expect(result).toEqual({
      handled: false,
      reason: 'SUBMIT_AMBIGUOUS_REVIEW',
      needsReview: true,
    });
    expect(pool.matching(/INSERT INTO overage_credit/)).toHaveLength(0);
    expect(pool.matching(/UPDATE usage_record/)).toHaveLength(0);
  });

  it('a SUBMITTED/ACCEPTED record holds an EQUAL overage_credit and keeps its state (§3.20, RW-17)', async () => {
    pool.on(/FROM usage_record\s+WHERE shop_id = \$1 AND idempotency_key LIKE \$2/, [
      usageRecordRow({ state: 'ACCEPTED' }),
    ]);
    pool.on(/INSERT INTO overage_credit/, [{ credit_id: 'credit-9' }], 1);
    const { service, shopify, audit } = makeService(pool, 0);

    const result = await service.reverseOverageForShipment(reverseInput);

    expect(result).toEqual({
      handled: true,
      outcome: 'CREDIT_HELD',
      usageId: usageRecordRow().usage_id,
      creditId: 'credit-9',
    });
    const credit = pool.matching(/INSERT INTO overage_credit/)[0];
    // Equal and signed: the negative of the charged amount (§4.1).
    expect(credit.params[2]).toBe('-2.0000');
    // The usage record STAYS ACCEPTED — the credit carries the reversal.
    expect(
      pool.matching(/UPDATE usage_record SET state = 'REVERSED'/),
    ).toHaveLength(0);
    // And no Shopify call of any kind — never a negative usage call.
    expect(shopify.createUsageRecord).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'billing.overage.credit_held' }),
    );
  });

  it('a second reversal of the same record holds no second credit', async () => {
    pool.on(/FROM usage_record\s+WHERE shop_id = \$1 AND idempotency_key LIKE \$2/, [
      usageRecordRow({ state: 'ACCEPTED' }),
    ]);
    pool.on(/SELECT credit_id FROM overage_credit\s+WHERE source_usage_id = \$1/, [
      { credit_id: 'credit-9' },
    ]);
    const { service } = makeService(pool, 0);

    const result = await service.reverseOverageForShipment(reverseInput);

    expect(result).toMatchObject({ handled: true, outcome: 'ALREADY_CREDITED' });
    expect(pool.matching(/INSERT INTO overage_credit/)).toHaveLength(0);
  });

  it('terminal records (REJECTED/REVERSED) are untouched', async () => {
    pool.on(/FROM usage_record\s+WHERE shop_id = \$1 AND idempotency_key LIKE \$2/, [
      usageRecordRow({ state: 'REJECTED' }),
    ]);
    const { service } = makeService(pool, 0);
    const result = await service.reverseOverageForShipment(reverseInput);
    expect(result).toEqual({ handled: false, reason: 'TERMINAL_STATE' });
  });
});

describe('OverageService.reconcileSubmittedUsage (§3.20 SUBMITTED → ACCEPTED)', () => {
  it('promotes records still present at Shopify; ACCEPTED is terminal', async () => {
    const pool = new FnPool();
    pool.on(/SELECT DISTINCT s\.subscription_id, s\.shopify_subscription_gid/, [
      { subscription_id: SUBSCRIPTION_ID, shopify_subscription_gid: SUB_GID },
    ]);
    pool.on(/UPDATE usage_record[\s\S]*'ACCEPTED'/, [{ usage_id: 'u1' }], 1);
    const { service } = makeService(pool, 0);

    const result = await service.reconcileSubmittedUsage(SHOP_ID);

    expect(result).toEqual({ accepted: 1 });
    const update = pool.matching(/UPDATE usage_record[\s\S]*'ACCEPTED'/)[0];
    expect(update.sql).toContain("state = 'SUBMITTED'");
    expect(update.params[1]).toEqual([USAGE_GID]);
  });
});

describe('ShopifyBillingClient usage-charge guard (§9.5.6 no-negative invariant)', () => {
  it('refuses zero or negative usage amounts before any API call', async () => {
    const graphql = { queryForShop: vi.fn() };
    const client = new ShopifyBillingClient(graphql as never);
    await expect(
      client.createUsageRecord(SHOP_ID, USAGE_LINE_ITEM_GID, '0.00', 'x'),
    ).rejects.toThrow(/positive/);
    await expect(
      client.createUsageRecord(SHOP_ID, USAGE_LINE_ITEM_GID, '-2.00', 'x'),
    ).rejects.toThrow(/positive/);
    expect(graphql.queryForShop).not.toHaveBeenCalled();
  });
});
