import { describe, expect, it } from 'vitest';
import { MAX_PAGE_SIZE, OrdersReadService } from '../../src/modules/orders/orders-read.service';
import { MockPool } from '../shopify/helpers';

/*
 * The order LIST statement contains a `count(*)` subquery for shipment_count,
 * so a loose /count\(\*\)/ responder would also swallow the list query and
 * hand back count rows. These patterns are deliberately specific.
 */
const ORDER_COUNT = /count\(\*\)::int AS n FROM "order"/;
const ORDER_LIST = /ORDER BY o\.created_at DESC/;
const SHIP_COUNT = /count\(\*\)::int AS n\s+FROM shipment/;
const SHIP_LIST = /ORDER BY s\.created_at DESC/;

const SHOP_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_SHOP = '22222222-2222-2222-2222-222222222222';
const ORDER_ID = '33333333-3333-3333-3333-333333333333';

const ORDER_ROW = {
  order_id: ORDER_ID,
  shopify_order_number: '#1042',
  order_state: 'READY',
  payment_mode: 'COD',
  cod_assignment_state: 'ASSIGNED',
  order_amount: '1250.5000',
  cod_outstanding: '1250.5000',
  is_test_order: false,
  created_at: new Date('2026-07-01T00:00:00.000Z'),
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
  shipment_count: 1,
};

const SHIPMENT_ROW = {
  shipment_id: '44444444-4444-4444-4444-444444444444',
  order_id: ORDER_ID,
  shopify_order_number: '#1042',
  awb_raw: 'DL 0087-412391',
  awb_normalized: 'DL0087412391',
  booking_state: 'CONFIRMED',
  custody_state: 'IN_CUSTODY',
  movement_state: 'IN_TRANSIT',
  collectible: '1250.5000',
  is_test: false,
  booked_at: new Date('2026-07-02T00:00:00.000Z'),
  delivered_at: null,
  created_at: new Date('2026-07-01T00:00:00.000Z'),
  courier_code: 'DELHIVERY',
};

function svc(pool: MockPool) {
  return new OrdersReadService(pool as never);
}

describe('OrdersReadService.listOrders (§9.2 read surface)', () => {
  it('scopes every query to the shop and returns a page (INV-1)', async () => {
    const pool = new MockPool()
      .on(ORDER_COUNT, [{ n: 1 }])
      .on(ORDER_LIST, [ORDER_ROW]);

    const page = await svc(pool).listOrders({ shopId: SHOP_ID, view: 'live' });

    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      orderNumber: '#1042',
      orderState: 'READY',
      city: 'Bengaluru',
      pincode: '560001',
      isTest: false,
      shipmentCount: 1,
    });
    // Every statement must carry shop_id as the first bind (INV-1).
    for (const call of pool.calls) {
      expect(call.params[0]).toBe(SHOP_ID);
      expect(call.sql).toContain('o.shop_id = $1');
    }
  });

  it('§9.23: defaults to live and only shows test rows when asked', async () => {
    const live = new MockPool()
      .on(ORDER_COUNT, [{ n: 0 }])
      .on(ORDER_LIST, []);
    await svc(live).listOrders({ shopId: SHOP_ID, view: 'live' });
    // is_test_order is bound false — the filter is applied in SQL, never left
    // to the client where it could be forgotten.
    expect(live.calls[0]?.params[1]).toBe(false);

    const test = new MockPool()
      .on(ORDER_COUNT, [{ n: 0 }])
      .on(ORDER_LIST, []);
    await svc(test).listOrders({ shopId: SHOP_ID, view: 'test' });
    expect(test.calls[0]?.params[1]).toBe(true);
  });

  it('caps the page size so a client cannot ask for the whole table', async () => {
    const pool = new MockPool()
      .on(ORDER_COUNT, [{ n: 0 }])
      .on(ORDER_LIST, []);

    const page = await svc(pool).listOrders({ shopId: SHOP_ID, view: 'live', limit: 100000 });

    expect(page.limit).toBe(MAX_PAGE_SIZE);
    const listCall = pool.matching(/ORDER BY o\.created_at DESC/)[0];
    expect(listCall?.params[4]).toBe(MAX_PAGE_SIZE);
  });

  it('rejects nonsense paging instead of emitting invalid SQL', async () => {
    const pool = new MockPool()
      .on(ORDER_COUNT, [{ n: 0 }])
      .on(ORDER_LIST, []);

    const page = await svc(pool).listOrders({
      shopId: SHOP_ID, view: 'live', limit: -5, offset: -20,
    });

    expect(page.limit).toBeGreaterThan(0);
    expect(page.offset).toBe(0);
  });

  it('passes state and search as binds, never as interpolated SQL', async () => {
    const pool = new MockPool()
      .on(ORDER_COUNT, [{ n: 0 }])
      .on(ORDER_LIST, []);

    await svc(pool).listOrders({
      shopId: SHOP_ID, view: 'live', state: "READY'; DROP TABLE shop; --", search: "%_'",
    });

    const call = pool.calls[0];
    expect(call.params[2]).toBe("READY'; DROP TABLE shop; --");
    expect(call.params[3]).toBe("%_'");
    // The literal must never appear in the statement text.
    expect(call.sql).not.toContain('DROP TABLE');
  });
});

describe('OrdersReadService.listShipments (§9.2 / §9.23)', () => {
  it('returns the raw AWB for display and joins the courier code', async () => {
    const pool = new MockPool()
      .on(SHIP_COUNT, [{ n: 1 }])
      .on(SHIP_LIST, [SHIPMENT_ROW]);

    const page = await svc(pool).listShipments({ shopId: SHOP_ID, view: 'live' });

    expect(page.items[0]).toMatchObject({
      awb: 'DL 0087-412391',
      courierCode: 'DELHIVERY',
      bookingState: 'CONFIRMED',
      isTest: false,
    });
  });

  it('normalizes the AWB search so a pasted AWB with spaces still matches (F-19)', async () => {
    const pool = new MockPool()
      .on(SHIP_COUNT, [{ n: 0 }])
      .on(SHIP_LIST, []);

    await svc(pool).listShipments({ shopId: SHOP_ID, view: 'live', search: 'dl 0087-412391' });

    const call = pool.calls[0];
    expect(call.sql).toContain('regexp_replace');
    expect(call.sql).toContain('upper(');
    expect(call.params[3]).toBe('dl 0087-412391');
  });

  it('§9.23: the test filter is bound, not merely a display concern', async () => {
    const pool = new MockPool()
      .on(SHIP_COUNT, [{ n: 0 }])
      .on(SHIP_LIST, []);

    await svc(pool).listShipments({ shopId: SHOP_ID, view: 'test' });

    expect(pool.calls[0]?.params[1]).toBe(true);
    expect(pool.calls[0]?.sql).toContain('s.is_test = $2');
  });
});

describe('OrdersReadService.getOrder (INV-1)', () => {
  it('returns null for an order belonging to another shop', async () => {
    // The shop-scoped SELECT simply matches nothing.
    const pool = new MockPool().on(/FROM "order"/, []);

    const result = await svc(pool).getOrder(OTHER_SHOP, ORDER_ID);

    expect(result).toBeNull();
    // Nothing further is queried — no line or shipment leak on a miss.
    expect(pool.matching(/FROM order_line/)).toHaveLength(0);
    expect(pool.matching(/FROM shipment/)).toHaveLength(0);
  });

  it('assembles the order with its lines and shipments', async () => {
    const pool = new MockPool()
      .on(/FROM "order"\s+WHERE shop_id/, [ORDER_ROW])
      .on(/FROM order_line/, [
        { order_line_id: 'l1', sku: 'SKU-1', title: 'Widget', quantity: 2, unit_price: '625.2500' },
      ])
      .on(/FROM shipment s/, [SHIPMENT_ROW]);

    const result = (await svc(pool).getOrder(SHOP_ID, ORDER_ID)) as Record<string, unknown>;

    expect(result).toMatchObject({ orderNumber: '#1042', city: 'Bengaluru' });
    expect((result.lines as unknown[])).toHaveLength(1);
    expect((result.shipments as unknown[])).toHaveLength(1);
    // The detail query is shop-scoped, not id-only (INV-1).
    expect(pool.calls[0]?.params).toEqual([SHOP_ID, ORDER_ID]);
  });
});
