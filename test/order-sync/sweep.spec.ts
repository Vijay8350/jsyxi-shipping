import { describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  SWEEP_WINDOW_HOURS,
  buildSweepSearchQuery,
  extractUpdatedOrdersPage,
  graphqlOrderToRestPayload,
} from '../../src/modules/order-sync/sweep/order-sweep.logic';
import { OrderSweepService } from '../../src/modules/order-sync/sweep/order-sweep.service';
import { OrderIngestScheduler } from '../../src/modules/order-sync/sweep/order-ingest.scheduler';
import { OrderIngestService } from '../../src/modules/order-sync/order-ingest.service';
import { ShopifyGraphqlClient } from '../../src/modules/shopify/shopify-graphql.client';
import { mapShopifyOrder } from '../../src/modules/order-sync/order-mapper';
import { MockTxPool, SHOP_ID } from './helpers';

const NOW = new Date('2026-07-29T12:00:00.000Z');

describe('sweep pure logic (S-15, RV-14)', () => {
  it('builds a 24-hour updated_at window in UTC', () => {
    expect(SWEEP_WINDOW_HOURS).toBe(24);
    expect(buildSweepSearchQuery(NOW)).toBe('updated_at:>=2026-07-28T12:00:00.000Z');
  });

  it('extracts a page envelope', () => {
    const page = extractUpdatedOrdersPage({
      orders: {
        nodes: [{ id: 'a' }],
        pageInfo: { hasNextPage: true, endCursor: 'cur-1' },
      },
    });
    expect(page).toEqual({ nodes: [{ id: 'a' }], hasNextPage: true, endCursor: 'cur-1' });
    expect(extractUpdatedOrdersPage({ orders: null }).nodes).toEqual([]);
  });

  it('reshapes a GraphQL node into the REST shape the §8.1 mapper consumes', () => {
    const node = {
      id: 'gid://shopify/Order/77',
      name: '#1001',
      createdAt: '2026-07-29T06:00:00Z',
      test: false,
      email: 'b@example.in',
      currentTotalPriceSet: {
        shopMoney: { amount: '999.00', currencyCode: 'INR' },
        presentmentMoney: { amount: '999.00', currencyCode: 'INR' },
      },
      paymentGatewayNames: ['cod'],
      riskLevel: 'MEDIUM',
      shippingAddress: { name: 'R', address1: 'a1', city: 'Pune', province: 'MH', zip: '411001', phone: '9000000000' },
      shippingLines: {
        nodes: [{ title: 'Free Shipping', originalPriceSet: { shopMoney: { amount: '0.00', currencyCode: 'INR' } } }],
      },
      lineItems: {
        nodes: [
          {
            id: 'gid://shopify/LineItem/1',
            sku: 'S1',
            title: 'T',
            variantTitle: 'V',
            quantity: 3,
            originalUnitPriceSet: { shopMoney: { amount: '333.00', currencyCode: 'INR' } },
            product: { tags: ['x'] },
            variant: { weight: 1.5, weightUnit: 'KILOGRAMS', inventoryItem: { harmonizedSystemCode: '6109' } },
          },
        ],
      },
    };
    const rest = graphqlOrderToRestPayload(node);
    const mapped = mapShopifyOrder(rest);
    expect(mapped.shopifyOrderGid).toBe('gid://shopify/Order/77');
    expect(mapped.shopifyOrderNumber).toBe('#1001');
    expect(mapped.orderAmount).toBe('999.00');
    expect(mapped.checkoutShippingTitle).toBe('Free Shipping'); // ADD-06
    expect(mapped.checkoutShippingAmount).toBe('0.00'); // ADD-07
    expect(mapped.riskFlag).toBe('MEDIUM');
    expect(mapped.lines[0]?.weightKgPerUnit).toBe('1.500'); // 1.5 kg → 1500 g → per-unit kg
    expect(mapped.lines[0]?.hsnCode).toBe('6109');
    expect(mapped.gatewayNames).toEqual(['cod']);
  });
});

describe('OrderSweepService (S-15)', () => {
  function graphqlPages(pages: Array<{ nodes: unknown[]; hasNextPage: boolean; endCursor: string | null }>) {
    const fn = vi.fn();
    for (const p of pages) {
      fn.mockResolvedValueOnce({
        orders: { nodes: p.nodes, pageInfo: { hasNextPage: p.hasNextPage, endCursor: p.endCursor } },
      });
    }
    return { queryForShop: fn } as unknown as ShopifyGraphqlClient;
  }

  const orderNode = (gid: string) => ({
    id: gid,
    name: `#${gid.split('/').pop()}`,
    createdAt: '2026-07-29T06:00:00Z',
    currentTotalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'INR' } },
    lineItems: { nodes: [] },
    shippingLines: { nodes: [] },
  });

  it('walks a paginated 24h window and feeds every order through ingest', async () => {
    const pool = new MockTxPool().on(/SELECT account_state/, [{ account_state: 'ACTIVE' }]);
    const graphql = graphqlPages([
      {
        nodes: [orderNode('gid://shopify/Order/1'), orderNode('gid://shopify/Order/2')],
        hasNextPage: true,
        endCursor: 'c1',
      },
      { nodes: [orderNode('gid://shopify/Order/3')], hasNextPage: false, endCursor: 'c2' },
    ]);
    const ingest = { ingest: vi.fn(() => Promise.resolve({})) } as unknown as OrderIngestService;
    const svc = new OrderSweepService(pool as unknown as Pool, graphql, ingest);

    const result = await svc.runShopSweep(SHOP_ID, NOW);
    expect(result).toEqual({ shopId: SHOP_ID, skipped: false, ordersProcessed: 3, pages: 2 });

    const calls = (graphql.queryForShop as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[2]).toMatchObject({
      query: 'updated_at:>=2026-07-28T12:00:00.000Z',
      after: null,
    });
    expect(calls[1]?.[2]).toMatchObject({ after: 'c1' });
    expect(ingest.ingest).toHaveBeenCalledTimes(3);
    // Same upsert path as webhooks: a ShopifyRestOrderPayload-shaped object.
    const firstPayload = (ingest.ingest as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(firstPayload['admin_graphql_api_id']).toBe('gid://shopify/Order/1');
  });

  it('skips UNINSTALLED shops without touching Shopify (§5.5)', async () => {
    const pool = new MockTxPool().on(/SELECT account_state/, [{ account_state: 'UNINSTALLED' }]);
    const graphql = graphqlPages([]);
    const ingest = { ingest: vi.fn() } as unknown as OrderIngestService;
    const svc = new OrderSweepService(pool as unknown as Pool, graphql, ingest);
    const result = await svc.runShopSweep(SHOP_ID, NOW);
    expect(result.skipped).toBe(true);
    expect(graphql.queryForShop).not.toHaveBeenCalled();
    expect(ingest.ingest).not.toHaveBeenCalled();
  });
});

describe('OrderIngestScheduler.syncSchedules (§5.7 order-ingest queue)', () => {
  function schedulerWithMockQueue() {
    const queue = {
      upsertJobScheduler: vi.fn(() => Promise.resolve({})),
      removeJobScheduler: vi.fn(() => Promise.resolve(1)),
      close: vi.fn(() => Promise.resolve()),
    };
    const scheduler = Object.create(OrderIngestScheduler.prototype) as OrderIngestScheduler;
    Object.defineProperty(scheduler, 'queue', { value: queue });
    Object.defineProperty(scheduler, 'logger', { value: { log: () => undefined } });
    return { scheduler, queue };
  }

  it('schedules one hourly repeatable job per active shop, removes UNINSTALLED (§5.5)', async () => {
    const { scheduler, queue } = schedulerWithMockQueue();
    const result = await scheduler.syncSchedules([
      { shop_id: 's-active', account_state: 'ACTIVE' },
      { shop_id: 's-trial', account_state: 'TRIALING' },
      { shop_id: 's-gone', account_state: 'UNINSTALLED' },
    ]);
    expect(result).toEqual({ scheduled: 2, removed: 1 });
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'shop-sweep:s-active',
      { every: 3_600_000 },
      { name: 'shop-sweep', data: { shopId: 's-active' } },
    );
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('shop-sweep:s-gone');
    expect(queue.upsertJobScheduler).not.toHaveBeenCalledWith(
      'shop-sweep:s-gone',
      expect.anything(),
      expect.anything(),
    );
  });
});
