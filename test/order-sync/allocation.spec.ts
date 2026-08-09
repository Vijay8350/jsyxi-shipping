import { describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { AllocationService } from '../../src/modules/order-sync/allocation.service';
import { LocationService } from '../../src/modules/order-sync/location.service';
import { ShopifyGraphqlClient } from '../../src/modules/shopify/shopify-graphql.client';
import { buildAllocationPlan } from '../../src/modules/order-sync/allocation-plan';
import { mapShopifyOrder } from '../../src/modules/order-sync/order-mapper';
import { ShipmentWorkingValues } from '../../src/modules/order-sync/working-values.types';
import { MockTxPool, ORDER_GID, ORDER_ID, SHOP_ID, mockAudit, sampleOrderPayload } from './helpers';

const L1 = 'gid://shopify/Location/1';
const L2 = 'gid://shopify/Location/2';

function fo(gid: string, status: string, locationGid: string | null = L1) {
  return {
    id: gid,
    status,
    assignedLocation: locationGid ? { location: { id: locationGid, name: 'WH' } } : null,
  };
}

function graphqlReturning(nodes: unknown[]) {
  return {
    queryForShop: vi.fn(() =>
      Promise.resolve({ order: { fulfillmentOrders: { nodes } } }),
    ),
  } as unknown as ShopifyGraphqlClient;
}

/** Pool pre-loaded with the fixed rows AllocationService.rebuild reads. */
function poolForRebuild(locationFlags: Array<{ gid: string; ships: boolean }>) {
  return new MockTxPool()
    .on(/INSERT INTO shopify_location/, [])
    .on(
      /SELECT shopify_location_gid, ships_via_jsyxi/,
      locationFlags.map((f) => ({
        shopify_location_gid: f.gid,
        ships_via_jsyxi: f.ships,
      })),
    )
    .on(/SELECT order_state FROM "order"/, [{ order_state: 'IMPORTED' }])
    .on(/SELECT pickup_location_id/, [{ pickup_location_id: 'pl-1' }])
    .on(/FROM order_line ol/, [
      {
        order_line_id: 'ol-1',
        shopify_line_gid: 'gid://shopify/LineItem/9001',
        sku: 'TEE-BLK-M',
        title: 'Cotton Tee',
        variant: 'Black / M',
        quantity: 2,
        unit_price: '500.00',
        tags: ['summer', 'bestseller'],
        hsn_code: '6109',
        weight_kg_override: '0.250',
      },
    ])
    .on(/INSERT INTO allocation/, [{ allocation_id: 'alloc-1' }])
    .on(/INSERT INTO shipment /, [{ shipment_id: 'ship-1', created_at: '2026-07-29T00:00:00.000Z' }]);
}

describe('buildAllocationPlan (§9.2.3, pure)', () => {
  const allShip = () => true;

  it('consolidates all in-house fulfillment orders into ONE allocation', () => {
    const plan = buildAllocationPlan(
      [
        { gid: 'FO1', status: 'OPEN', locationGid: L1, locationName: 'WH' },
        { gid: 'FO2', status: 'OPEN', locationGid: L2, locationName: 'WH2' },
      ],
      allShip,
      true,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      state: 'OPEN',
      sourceFulfillmentOrderGids: ['FO1', 'FO2'],
      mergePath: 'CONSOLIDATED',
    });
  });

  it('fallback flag → one allocation per fulfillment order, never dropped (INV-20, RV-06)', () => {
    const plan = buildAllocationPlan(
      [
        { gid: 'FO1', status: 'OPEN', locationGid: L1, locationName: 'WH' },
        { gid: 'FO2', status: 'OPEN', locationGid: L2, locationName: 'WH2' },
      ],
      allShip,
      false,
    );
    expect(plan).toHaveLength(2);
    expect(plan.every((p) => p.mergePath === 'FALLBACK_PER_FULFILLMENT_ORDER')).toBe(true);
  });

  it('externally fulfilled + ships_via_jsyxi=false → EXCLUDED with reasons, never absent', () => {
    const plan = buildAllocationPlan(
      [
        { gid: 'FO1', status: 'OPEN', locationGid: L1, locationName: 'WH' },
        { gid: 'FO2', status: 'CLOSED', locationGid: L1, locationName: 'WH' },
        { gid: 'FO3', status: 'OPEN', locationGid: L2, locationName: 'Store' },
        { gid: 'FO4', status: 'CANCELLED', locationGid: L1, locationName: 'WH' },
      ],
      (gid) => gid !== L2,
      true,
    );
    const excluded = plan.filter((p) => p.state === 'EXCLUDED');
    expect(excluded).toHaveLength(3);
    expect(excluded.find((p) => p.sourceFulfillmentOrderGids[0] === 'FO2')?.exclusionReason).toBe(
      'EXTERNALLY_FULFILLED',
    );
    expect(excluded.find((p) => p.sourceFulfillmentOrderGids[0] === 'FO3')?.exclusionReason).toBe(
      'LOCATION_NOT_SHIPPED_VIA_JSYXI',
    );
    expect(excluded.find((p) => p.sourceFulfillmentOrderGids[0] === 'FO4')?.exclusionReason).toBe(
      'FULFILLMENT_ORDER_CANCELLED',
    );
    expect(plan.filter((p) => p.state === 'OPEN')).toHaveLength(1);
  });

  it('no fulfillment orders → one default allocation (never skip an order)', () => {
    const plan = buildAllocationPlan([], allShip, true);
    expect(plan).toEqual([
      expect.objectContaining({ state: 'OPEN', sourceFulfillmentOrderGids: [] }),
    ]);
  });
});

describe('AllocationService.rebuild (§9.2.3)', () => {
  it('produces one allocation + one DRAFT shipment with §2.9 working values', async () => {
    const pool = poolForRebuild([{ gid: L1, ships: true }]);
    const audit = mockAudit();
    const svc = new AllocationService(
      pool as unknown as Pool,
      graphqlReturning([fo('FO1', 'OPEN'), fo('FO2', 'OPEN')]),
      new LocationService(pool as unknown as Pool, graphqlReturning([])),
      audit as never,
    );
    const mapped = mapShopifyOrder(sampleOrderPayload());
    const result = await svc.rebuild(SHOP_ID, ORDER_ID, mapped);

    expect(result.rebuilt).toBe(true);
    // Order row locked and state re-checked inside the transaction.
    expect(pool.matching(/FOR UPDATE/)).toHaveLength(1);
    // Refresh replaces only unbooked rows (§9.2.5).
    expect(pool.matching(/DELETE FROM shipment\b/)).toHaveLength(1);
    expect(pool.matching(/DELETE FROM allocation/)).toHaveLength(1);

    const allocs = pool.matching(/INSERT INTO allocation/);
    expect(allocs).toHaveLength(1);
    expect(allocs[0]?.params).toContain('OPEN');
    expect(allocs[0]?.params[2]).toEqual(['FO1', 'FO2']); // both FOs consolidated

    const ships = pool.matching(/INSERT INTO shipment /);
    expect(ships).toHaveLength(1);
    const workingValues = JSON.parse(ships[0]?.params[4] as string) as ShipmentWorkingValues;
    expect(workingValues.schemaVersion).toBe(1);
    expect(workingValues.recipient?.pincode).toBe('560001');
    expect(workingValues.lines).toHaveLength(1);
    expect(workingValues.payment).toEqual({
      mode: 'UNRESOLVED', // week-4 §3.5 derivation
      gatewayNames: ['Cash on Delivery (COD)'],
      collectible: '0.00',
      totalOutstanding: null, // §4.6 F-15 basis — absent from this fixture
    });
    expect(workingValues.fulfillment).toEqual({
      sourceFulfillmentOrderGids: ['FO1', 'FO2'],
      shopifyLocationGid: L1,
      mergePath: 'CONSOLIDATED',
    });

    // Partitioned shipment: child rows carry shipment_created_at.
    const line = pool.matching(/INSERT INTO shipment_line/)[0];
    expect(line?.params[0]).toBe('ship-1');
    expect(line?.params[1]).toBe('2026-07-29T00:00:00.000Z');
  });

  it('canMergeFulfillmentOrders=false → one DRAFT shipment per fulfillment order', async () => {
    const pool = poolForRebuild([{ gid: L1, ships: true }]);
    const svc = new AllocationService(
      pool as unknown as Pool,
      graphqlReturning([fo('FO1', 'OPEN'), fo('FO2', 'OPEN')]),
      new LocationService(pool as unknown as Pool, graphqlReturning([])),
      mockAudit() as never,
    );
    svc.canMergeFulfillmentOrders = () => false;
    await svc.rebuild(SHOP_ID, ORDER_ID, mapShopifyOrder(sampleOrderPayload()));
    expect(pool.matching(/INSERT INTO allocation/)).toHaveLength(2);
    expect(pool.matching(/INSERT INTO shipment /)).toHaveLength(2);
  });

  it('ships_via_jsyxi=false and externally fulfilled → EXCLUDED allocations, no shipments, reason audited', async () => {
    const pool = poolForRebuild([
      { gid: L1, ships: true },
      { gid: L2, ships: false },
    ]);
    const audit = mockAudit();
    const svc = new AllocationService(
      pool as unknown as Pool,
      graphqlReturning([fo('FO1', 'OPEN', L1), fo('FO2', 'OPEN', L2), fo('FO3', 'CLOSED', L1)]),
      new LocationService(pool as unknown as Pool, graphqlReturning([])),
      audit as never,
    );
    await svc.rebuild(SHOP_ID, ORDER_ID, mapShopifyOrder(sampleOrderPayload()));

    const allocs = pool.matching(/INSERT INTO allocation/);
    const states = allocs.map((c) => c.params[3]);
    expect(states.filter((s) => s === 'OPEN')).toHaveLength(1);
    expect(states.filter((s) => s === 'EXCLUDED')).toHaveLength(2);
    expect(pool.matching(/INSERT INTO shipment /)).toHaveLength(1);
    const reasons = (audit.entries as Array<{ reason?: string }>).map((e) => e.reason);
    expect(reasons).toContain('LOCATION_NOT_SHIPPED_VIA_JSYXI');
    expect(reasons).toContain('EXTERNALLY_FULFILLED');
  });

  it('does not rebuild a booked order (§9.2.5)', async () => {
    const pool = poolForRebuild([{ gid: L1, ships: true }]);
    // Re-point the order-state responder at a booked state.
    const booked = new MockTxPool()
      .on(/INSERT INTO shopify_location/, [])
      .on(/SELECT shopify_location_gid/, [{ shopify_location_gid: L1, ships_via_jsyxi: true }])
      .on(/SELECT order_state FROM "order"/, [{ order_state: 'PARTIALLY_BOOKED' }]);
    const svc = new AllocationService(
      booked as unknown as Pool,
      graphqlReturning([fo('FO1', 'OPEN')]),
      new LocationService(booked as unknown as Pool, graphqlReturning([])),
      mockAudit() as never,
    );
    const result = await svc.rebuild(SHOP_ID, ORDER_ID, mapShopifyOrder(sampleOrderPayload()));
    expect(result.rebuilt).toBe(false);
    expect(booked.matching(/INSERT INTO allocation/)).toHaveLength(0);
    expect(booked.matching(/ROLLBACK/)).toHaveLength(1);
  });
});

describe('AllocationService.markExternallyFulfilled (orders/fulfilled, INV-20)', () => {
  it('excludes matching OPEN allocations, drops their DRAFT shipments, audits the reason', async () => {
    const pool = new MockTxPool().on(/UPDATE allocation/, [{ allocation_id: 'alloc-1' }]);
    const audit = mockAudit();
    const svc = new AllocationService(
      pool as unknown as Pool,
      graphqlReturning([]),
      new LocationService(pool as unknown as Pool, graphqlReturning([])),
      audit as never,
    );
    const ids = await svc.markExternallyFulfilled(SHOP_ID, ORDER_ID, ['FO1']);
    expect(ids).toEqual(['alloc-1']);
    const update = pool.matching(/UPDATE allocation/)[0];
    expect(update?.sql).toContain("state = 'OPEN'"); // replay-safe guard
    expect(update?.sql).toContain('EXCLUDED');
    expect(update?.params).toEqual([SHOP_ID, ORDER_ID, ['FO1']]);
    expect(pool.matching(/DELETE FROM shipment\b/)).toHaveLength(1);
    expect((audit.entries as Array<{ reason?: string }>)[0]?.reason).toBe('EXTERNALLY_FULFILLED');
  });

  it('replay is a no-op: no OPEN allocations left → nothing deleted or audited', async () => {
    const pool = new MockTxPool().on(/UPDATE allocation/, []);
    const audit = mockAudit();
    const svc = new AllocationService(
      pool as unknown as Pool,
      graphqlReturning([]),
      new LocationService(pool as unknown as Pool, graphqlReturning([])),
      audit as never,
    );
    expect(await svc.markExternallyFulfilled(SHOP_ID, ORDER_ID, null)).toEqual([]);
    expect(pool.matching(/DELETE FROM shipment\b/)).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });
});
