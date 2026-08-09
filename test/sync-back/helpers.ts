import { vi } from 'vitest';
import { FnPool, ORDER_ID, SHIPMENT_ID, SHOP_ID, sampleSnapshot } from '../booking/helpers';
import type { SyncOutboxRow, SyncOperation, SyncPayload } from '../../src/modules/sync-back/sync-back.types';

/**
 * Fixtures for sync-back specs. Pool/Redis/GraphQL doubles only — no real
 * connections. Reuses the booking FnPool pattern.
 */

export { FnPool, ORDER_ID, SHIPMENT_ID, SHOP_ID };

export const OUTBOX_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
export const ADMIN_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
export const IDEMPOTENCY_KEY = `${SHOP_ID}:${SHIPMENT_ID}:CREATE_FULFILLMENT:test-digest`;
export const FULFILLMENT_GID = 'gid://shopify/Fulfillment/777';

export function liveShipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    shipment_id: SHIPMENT_ID,
    shop_id: SHOP_ID,
    order_id: ORDER_ID,
    is_test: false,
    awb_raw: 'DL0087412391',
    awb_normalized: 'DL0087412391',
    snapshot: sampleSnapshot(),
    ...overrides,
  };
}

export function orderGidRow(overrides: Record<string, unknown> = {}) {
  return {
    shopify_order_gid: 'gid://shopify/Order/555000111',
    is_test_order: false,
    ...overrides,
  };
}

export function outboxRow(overrides: Partial<SyncOutboxRow> = {}): SyncOutboxRow {
  return {
    outbox_id: OUTBOX_ID,
    shop_id: SHOP_ID,
    order_id: ORDER_ID,
    shipment_id: SHIPMENT_ID,
    operation: 'CREATE_FULFILLMENT' as SyncOperation,
    payload: {
      shopifyOrderGid: 'gid://shopify/Order/555000111',
      awb: 'DL0087412391',
      courierName: 'Delhivery',
      serviceName: 'Express',
      trackingUrl: null,
      notifyCustomer: true,
      lineItemsByFulfillmentOrder: [
        {
          fulfillmentOrderGid: 'gid://shopify/FulfillmentOrder/1',
          lines: [{ shopifyLineGid: 'gid://shopify/LineItem/1', quantity: 2 }],
        },
      ],
    } as SyncPayload,
    state: 'IN_FLIGHT',
    attempts: 0,
    next_attempt_at: '2026-07-31T10:00:00.000Z',
    idempotency_key: IDEMPOTENCY_KEY,
    version: 2,
    ...overrides,
  };
}

/** Mocked ShopifySyncMutations (records calls; create succeeds by default). */
export function mockMutations() {
  return {
    createFulfillment: vi.fn(async () => FULFILLMENT_GID),
    addFulfillmentEvent: vi.fn(async () => undefined),
    cancelFulfillment: vi.fn(async () => undefined),
    setOrderTags: vi.fn(async () => undefined),
  };
}

/** Mocked SyncCostBudget; allowed by default. */
export function mockBudget(allowed = true) {
  return { tryConsume: vi.fn(async () => allowed) };
}
