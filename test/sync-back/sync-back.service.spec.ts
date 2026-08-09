import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { mockAudit } from '../booking/helpers';
import {
  FnPool,
  ORDER_ID,
  OUTBOX_ID,
  ADMIN_ID,
  SHIPMENT_ID,
  SHOP_ID,
  liveShipmentRow,
  orderGidRow,
} from './helpers';
import {
  SyncBackService,
  ShopifySyncBackPublisher,
  resolveTrackingUrl,
} from '../../src/modules/sync-back/sync-back.service';
import type {
  AddFulfillmentEventPayload,
  CreateFulfillmentPayload,
  SetOrderTagsPayload,
} from '../../src/modules/sync-back/sync-back.types';

/**
 * §8.4 outbox writer: INV-19 test skips for all four operations, the
 * idempotency-key no-op, payload shape from the frozen snapshot (INV-8), and
 * the §3.17 audited DEAD replay.
 */

function livePool(insertRowCount = 1) {
  return new FnPool()
    .on(/FROM shipment/, [liveShipmentRow()])
    .on(/FROM "order"/, [orderGidRow()])
    .on(/order_sync_settings/, [{ notify_customer: true }])
    .on(/FROM courier_account/, [{ name: 'Delhivery' }])
    .on(/FROM\s+sync_outbox/, []) // no SUCCEEDED create yet
    .on(/INSERT INTO sync_outbox/, [], insertRowCount);
}

function service(pool: FnPool, audit = mockAudit()) {
  const trackTokens = { issue: vi.fn(async () => ({ token: 'tok', url: 'https://app.jsyxi.com/track/t/tok' })) };
  return { svc: new SyncBackService(pool.asPool(), audit as never, trackTokens as never), audit, trackTokens };
}

function insertedPayload(pool: FnPool) {
  const call = pool.matching(/INSERT INTO sync_outbox/)[0];
  expect(call).toBeDefined();
  return { payload: JSON.parse(call!.params[4] as string), key: call!.params[5] as string };
}

describe('SyncBackService enqueue (§8.4)', () => {
  it('CREATE_FULFILLMENT builds the payload from the frozen snapshot (INV-8)', async () => {
    const pool = livePool();
    const { svc } = service(pool);
    await svc.enqueueFulfillmentCreate(SHOP_ID, SHIPMENT_ID);

    const { payload, key } = insertedPayload(pool) as {
      payload: CreateFulfillmentPayload;
      key: string;
    };
    expect(payload.awb).toBe('DL0087412391'); // AWB as the tracking number
    expect(payload.courierName).toBe('Delhivery');
    expect(payload.serviceName).toBe('Express');
    expect(payload.notifyCustomer).toBe(true); // S-9
    expect(payload.shopifyOrderGid).toBe('gid://shopify/Order/555000111');
    expect(payload.lineItemsByFulfillmentOrder).toEqual([
      {
        fulfillmentOrderGid: 'gid://shopify/FulfillmentOrder/1',
        lines: [{ shopifyLineGid: 'gid://shopify/LineItem/1', quantity: 2 }],
      },
    ]);
    // §8.4: (shop_id, shipment_id, operation, attempt-invariant digest).
    expect(key).toMatch(
      new RegExp(`^${SHOP_ID}:${SHIPMENT_ID}:CREATE_FULFILLMENT:[0-9a-f]{16}$`),
    );
  });

  it('ADD_FULFILLMENT_EVENT carries the constant mapping + exact status message', async () => {
    const pool = livePool();
    const { svc } = service(pool);
    await svc.enqueueFulfillmentEvent(SHOP_ID, SHIPMENT_ID, 'RTO_IN_TRANSIT');

    const { payload, key } = insertedPayload(pool) as {
      payload: AddFulfillmentEventPayload;
      key: string;
    };
    expect(payload.carrierEventStatus).toBe('RTO_IN_TRANSIT');
    expect(payload.shopifyStatus).toBe('FAILURE'); // §8.4 constant
    expect(payload.message).toBe('RTO_IN_TRANSIT'); // exact Jsyxi status (§8.4)
    expect(key).toContain(':ADD_FULFILLMENT_EVENT:');
  });

  it('a repeat enqueue is a no-op (ON CONFLICT DO NOTHING), never a second fulfillment', async () => {
    const pool = livePool(0); // unique-key conflict → nothing inserted
    const { svc } = service(pool);
    await svc.enqueueFulfillmentCreate(SHOP_ID, SHIPMENT_ID);

    const inserts = pool.matching(/INSERT INTO sync_outbox/);
    expect(inserts).toHaveLength(1); // one attempt…
    expect(inserts[0]!.sql).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    // …which the unique key turned into a no-op (rowCount 0), and no other
    // write happened.
    expect(pool.matching(/UPDATE sync_outbox/)).toHaveLength(0);
  });

  it('the idempotency key is stable across repeat enqueues (attempt-invariant)', async () => {
    const poolA = livePool();
    const poolB = livePool();
    await service(poolA).svc.enqueueFulfillmentCreate(SHOP_ID, SHIPMENT_ID);
    await service(poolB).svc.enqueueFulfillmentCreate(SHOP_ID, SHIPMENT_ID);
    expect(insertedPayload(poolA).key).toBe(insertedPayload(poolB).key);
  });

  describe('INV-19: test shipments write NOTHING to Shopify — all four operations', () => {
    it('CREATE_FULFILLMENT is skipped for a test shipment', async () => {
      const pool = new FnPool().on(/FROM shipment/, [liveShipmentRow({ is_test: true })]);
      await service(pool).svc.enqueueFulfillmentCreate(SHOP_ID, SHIPMENT_ID);
      expect(pool.matching(/INSERT INTO sync_outbox/)).toHaveLength(0);
    });

    it('ADD_FULFILLMENT_EVENT is skipped for a test shipment', async () => {
      const pool = new FnPool().on(/FROM shipment/, [liveShipmentRow({ is_test: true })]);
      await service(pool).svc.enqueueFulfillmentEvent(SHOP_ID, SHIPMENT_ID, 'DELIVERED');
      expect(pool.matching(/INSERT INTO sync_outbox/)).toHaveLength(0);
    });

    it('CANCEL_FULFILLMENT is skipped for a test shipment', async () => {
      const pool = new FnPool().on(/FROM shipment/, [liveShipmentRow({ is_test: true })]);
      await service(pool).svc.enqueueFulfillmentCancel(SHOP_ID, SHIPMENT_ID);
      expect(pool.matching(/INSERT INTO sync_outbox/)).toHaveLength(0);
    });

    it('SET_ORDER_TAGS is skipped for a test order', async () => {
      const pool = new FnPool().on(/FROM "order"/, [orderGidRow({ is_test_order: true })]);
      await service(pool).svc.enqueueSetOrderTags(SHOP_ID, ORDER_ID, ['jsyxi']);
      expect(pool.matching(/INSERT INTO sync_outbox/)).toHaveLength(0);
    });
  });

  it('ADD-39: an order without a Shopify GID enqueues nothing', async () => {
    const pool = new FnPool()
      .on(/FROM shipment/, [liveShipmentRow()])
      .on(/FROM "order"/, [orderGidRow({ shopify_order_gid: null })]);
    await service(pool).svc.enqueueFulfillmentCreate(SHOP_ID, SHIPMENT_ID);
    expect(pool.matching(/INSERT INTO sync_outbox/)).toHaveLength(0);
  });

  it('SET_ORDER_TAGS sorts tags into the payload and keys on them', async () => {
    const pool = new FnPool()
      .on(/FROM "order"/, [orderGidRow()])
      .on(/INSERT INTO sync_outbox/, [], 1);
    await service(pool).svc.enqueueSetOrderTags(SHOP_ID, ORDER_ID, ['zeta', 'alpha']);

    const { payload, key } = insertedPayload(pool) as { payload: SetOrderTagsPayload; key: string };
    expect(payload.tags).toEqual(['alpha', 'zeta']);
    expect(payload.shopifyOrderGid).toBe('gid://shopify/Order/555000111');
    expect(key).toContain(`:${ORDER_ID}:SET_ORDER_TAGS:`);
  });
});

describe('§8.4 tracking URL selection (S-37)', () => {
  it('uses the Track-Order page URL when S-37 is on', () => {
    expect(
      resolveTrackingUrl({
        s37ReplaceTrackingLink: true,
        trackPageUrl: 'https://track.jsyxi.com/t/abc',
        courierTrackingUrl: 'https://courier.example/track/DL1',
      }),
    ).toBe('https://track.jsyxi.com/t/abc');
  });

  it("uses the courier's own URL when S-37 is off", () => {
    expect(
      resolveTrackingUrl({
        s37ReplaceTrackingLink: false,
        trackPageUrl: 'https://track.jsyxi.com/t/abc',
        courierTrackingUrl: 'https://courier.example/track/DL1',
      }),
    ).toBe('https://courier.example/track/DL1');
  });
});

describe('DEAD replay (§3.17, A1-10)', () => {
  function replayPool(state: string) {
    return new FnPool()
      .on(/FROM sync_outbox/, [
        { outbox_id: OUTBOX_ID, shop_id: SHOP_ID, state, attempts: 10, version: 3 },
      ])
      .on(/UPDATE sync_outbox/, [], 1)
      .on(/UPDATE dlq_item/, [], 1);
  }

  it('returns a DEAD item to PENDING with attempts reset, audited as ADMIN', async () => {
    const pool = replayPool('DEAD');
    const audit = mockAudit();
    await service(pool, audit).svc.replay(OUTBOX_ID, ADMIN_ID);

    const update = pool.matching(/UPDATE sync_outbox/)[0]!;
    expect(update.sql).toContain("state = 'PENDING'");
    expect(update.sql).toContain('attempts = 0');
    expect(update.params).toEqual([OUTBOX_ID, 3]); // INV-22 version check

    const dlq = pool.matching(/UPDATE dlq_item/)[0]!;
    expect(dlq.params).toEqual([OUTBOX_ID, ADMIN_ID]);

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      shopId: SHOP_ID,
      actorKind: 'ADMIN',
      actorId: ADMIN_ID,
      action: 'sync_outbox.replay',
      objectType: 'sync_outbox',
      objectId: OUTBOX_ID,
      before: { state: 'DEAD', attempts: 10 },
      after: { state: 'PENDING', attempts: 0 },
    });
  });

  it('rejects replay of a non-DEAD item', async () => {
    const pool = replayPool('RETRYING');
    await expect(service(pool).svc.replay(OUTBOX_ID, ADMIN_ID)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(pool.matching(/UPDATE sync_outbox/)).toHaveLength(0);
  });

  it('rejects replay of an unknown item', async () => {
    const pool = new FnPool().on(/FROM sync_outbox/, []);
    await expect(service(pool).svc.replay(OUTBOX_ID, ADMIN_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('SyncBackPublisher seam (booking-ops contract)', () => {
  it('resolves shopId from the shipment, then enqueues', async () => {
    const pool = livePool();
    const audit = mockAudit();
    const svc = new SyncBackService(pool.asPool(), audit as never, { issue: vi.fn() } as never);
    const publisher = new ShopifySyncBackPublisher(pool.asPool(), svc);

    await publisher.enqueueFulfillmentCreate(SHIPMENT_ID);

    const lookup = pool.matching(/SELECT shop_id FROM shipment/)[0]!;
    expect(lookup.params).toEqual([SHIPMENT_ID]);
    expect(pool.matching(/INSERT INTO sync_outbox/)).toHaveLength(1);
  });
});
