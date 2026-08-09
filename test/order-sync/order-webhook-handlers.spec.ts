import { describe, expect, it, vi } from 'vitest';
import { ShopifyWebhookDispatcher } from '../../src/modules/shopify/webhook-dispatcher.service';
import { OrderIngestService } from '../../src/modules/order-sync/order-ingest.service';
import { OrderUpsertService } from '../../src/modules/order-sync/order-upsert.service';
import { AllocationService } from '../../src/modules/order-sync/allocation.service';
import {
  OrdersCancelledHandler,
  OrdersFulfilledHandler,
} from '../../src/modules/order-sync/handlers/order-webhook.handlers';
import { mapShopifyOrder } from '../../src/modules/order-sync/order-mapper';
import { ORDER_GID, ORDER_ID, SHOP_ID, mockAudit, sampleOrderPayload } from './helpers';

const message = (payload: unknown) => ({
  inboxId: 'inbox-1',
  shopId: SHOP_ID,
  topic: 'orders/cancelled',
  externalId: 'evt-1',
  payload,
});

function ingestStub() {
  return {
    ingest: vi.fn(() =>
      Promise.resolve({
        mapped: mapShopifyOrder(sampleOrderPayload()),
        upsert: {
          orderId: ORDER_ID,
          orderState: 'IMPORTED',
          inserted: false,
          linesRewritten: true,
          unbooked: true,
        },
        allocationsRebuilt: true,
      }),
    ),
  } as unknown as OrderIngestService;
}

describe('OrdersCancelledHandler (§3.1 terminal)', () => {
  it('upserts then transitions; audit written only when the transition fires', async () => {
    const upserts = {
      markCancelledInShopify: vi.fn(() => Promise.resolve(true)),
    } as unknown as OrderUpsertService;
    const audit = mockAudit();
    const handler = new OrdersCancelledHandler(
      new ShopifyWebhookDispatcher(),
      ingestStub(),
      upserts,
      audit as never,
    );
    await handler.handle(message(sampleOrderPayload()));
    expect(upserts.markCancelledInShopify).toHaveBeenCalledWith(SHOP_ID, ORDER_ID);
    expect(audit.entries).toHaveLength(1);
  });

  it('replay: the guarded transition reports no change → no duplicate audit', async () => {
    const upserts = {
      markCancelledInShopify: vi.fn(() => Promise.resolve(false)),
    } as unknown as OrderUpsertService;
    const audit = mockAudit();
    const handler = new OrdersCancelledHandler(
      new ShopifyWebhookDispatcher(),
      ingestStub(),
      upserts,
      audit as never,
    );
    await handler.handle(message(sampleOrderPayload()));
    expect(audit.entries).toHaveLength(0);
  });
});

describe('OrdersFulfilledHandler (§9.2.3, INV-20)', () => {
  function allocationsStub(closed: string[]) {
    return {
      fetchFulfillmentOrders: vi.fn(() =>
        Promise.resolve([
          ...closed.map((gid) => ({ gid, status: 'CLOSED', locationGid: null, locationName: null })),
          { gid: 'FO-OPEN', status: 'OPEN', locationGid: null, locationName: null },
        ]),
      ),
      markExternallyFulfilled: vi.fn(() => Promise.resolve(['alloc-1'])),
    } as unknown as AllocationService;
  }

  it('marks the CLOSED fulfillment orders externally fulfilled', async () => {
    const allocations = allocationsStub(['FO1']);
    const handler = new OrdersFulfilledHandler(
      new ShopifyWebhookDispatcher(),
      ingestStub(),
      allocations,
    );
    await handler.handle({ ...message(sampleOrderPayload()), topic: 'orders/fulfilled' });
    expect(allocations.fetchFulfillmentOrders).toHaveBeenCalledWith(SHOP_ID, ORDER_GID);
    expect(allocations.markExternallyFulfilled).toHaveBeenCalledWith(SHOP_ID, ORDER_ID, ['FO1']);
  });

  it('fully fulfilled with no CLOSED fulfillment orders → null marks all OPEN allocations', async () => {
    const allocations = allocationsStub([]);
    const handler = new OrdersFulfilledHandler(
      new ShopifyWebhookDispatcher(),
      ingestStub(),
      allocations,
    );
    const payload = { ...sampleOrderPayload(), fulfillment_status: 'fulfilled' };
    await handler.handle({ ...message(payload), topic: 'orders/fulfilled' });
    expect(allocations.markExternallyFulfilled).toHaveBeenCalledWith(SHOP_ID, ORDER_ID, null);
  });
});
