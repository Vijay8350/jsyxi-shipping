import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { OrderUpsertService } from '../../src/modules/order-sync/order-upsert.service';
import { mapShopifyOrder } from '../../src/modules/order-sync/order-mapper';
import { MockTxPool, ORDER_ID, SHOP_ID, sampleOrderPayload } from './helpers';

function makeService(pool: MockTxPool) {
  return new OrderUpsertService(pool as unknown as Pool);
}

describe('OrderUpsertService.upsert (§9.2.1, INV-22)', () => {
  it('inserts a new order as IMPORTED and writes its lines', async () => {
    const pool = new MockTxPool().on(/INSERT INTO "order"/, [
      { order_id: ORDER_ID, order_state: 'IMPORTED', inserted: true },
    ]);
    const svc = makeService(pool);
    const result = await svc.upsert(SHOP_ID, mapShopifyOrder(sampleOrderPayload()));

    expect(result).toEqual({
      orderId: ORDER_ID,
      orderState: 'IMPORTED',
      inserted: true,
      linesRewritten: true,
      unbooked: true,
    });

    const insert = pool.matching(/INSERT INTO "order"/)[0];
    expect(insert?.sql).toContain('ON CONFLICT (shop_id, shopify_order_gid)');
    expect(insert?.sql).toContain('version = "order".version + 1'); // INV-22
    expect(insert?.params[0]).toBe(SHOP_ID); // INV-1 shop scoping
    // order_state / payment_mode are NOT in the upsert — §3.1 transitions
    // and §3.5 derivation are owned elsewhere.
    expect(insert?.sql).not.toContain('payment_mode');
    // ADD-06/07 columns written.
    expect(insert?.params).toContain('Express');
    expect(insert?.params).toContain('80.00');
    // Money as NUMERIC text, never floats.
    expect(insert?.params).toContain('1250.50');
    expect(typeof insert?.params.find((p) => p === '1250.50')).toBe('string');

    // Lines rewritten inside one transaction.
    expect(pool.matching(/^BEGIN/)).toHaveLength(1);
    expect(pool.matching(/^COMMIT/)).toHaveLength(1);
    expect(pool.matching(/DELETE FROM order_line/)).toHaveLength(1);
    const lineInsert = pool.matching(/INSERT INTO order_line/)[0];
    expect(lineInsert?.params).toContain('TEE-BLK-M');
    expect(lineInsert?.params).toContain('0.250');
  });

  it('is idempotent on replay: same upsert path, values rewritten in place', async () => {
    const pool = new MockTxPool().on(/INSERT INTO "order"/, [
      { order_id: ORDER_ID, order_state: 'READY', inserted: false },
    ]);
    const svc = makeService(pool);
    const mapped = mapShopifyOrder(sampleOrderPayload());
    await svc.upsert(SHOP_ID, mapped);
    await svc.upsert(SHOP_ID, mapped);
    // Both runs take the same keyed upsert — no duplicate insert path, no
    // state regression (order_state untouched on update).
    expect(pool.matching(/INSERT INTO "order"/)).toHaveLength(2);
    expect(pool.matching(/INSERT INTO "order"/)[1]?.sql).not.toMatch(
      /order_state\s*=\s*EXCLUDED/,
    );
  });

  it('rewrites lines only while unbooked (§9.2.5, §10.4)', async () => {
    for (const state of ['IMPORTED', 'INCOMPLETE', 'READY']) {
      const pool = new MockTxPool().on(/INSERT INTO "order"/, [
        { order_id: ORDER_ID, order_state: state, inserted: false },
      ]);
      const result = await makeService(pool).upsert(
        SHOP_ID,
        mapShopifyOrder(sampleOrderPayload()),
      );
      expect(result.linesRewritten).toBe(true);
      expect(pool.matching(/DELETE FROM order_line/)).toHaveLength(1);
    }
    for (const state of ['PARTIALLY_BOOKED', 'FULLY_BOOKED', 'CLOSED', 'CANCELLED_IN_SHOPIFY']) {
      const pool = new MockTxPool().on(/INSERT INTO "order"/, [
        { order_id: ORDER_ID, order_state: state, inserted: false },
      ]);
      const result = await makeService(pool).upsert(
        SHOP_ID,
        mapShopifyOrder(sampleOrderPayload()),
      );
      expect(result.unbooked).toBe(false);
      expect(result.linesRewritten).toBe(false);
      expect(pool.matching(/DELETE FROM order_line/)).toHaveLength(0);
      expect(pool.matching(/INSERT INTO order_line/)).toHaveLength(0);
    }
  });
});

describe('OrderUpsertService.markCancelledInShopify (§3.1 terminal, INV-17)', () => {
  it('transitions a live order and audits nothing itself (handler audits)', async () => {
    const pool = new MockTxPool().on(/UPDATE "order"/, [{ order_id: ORDER_ID }]);
    const svc = makeService(pool);
    const changed = await svc.markCancelledInShopify(SHOP_ID, ORDER_ID);
    expect(changed).toBe(true);
    const update = pool.matching(/UPDATE "order"/)[0];
    expect(update?.sql).toContain("order_state = 'CANCELLED_IN_SHOPIFY'");
    // Guard: never regress a terminal state — replay or post-CLOSED event
    // is a no-op.
    expect(update?.sql).toContain("NOT IN ('CANCELLED_IN_SHOPIFY', 'CLOSED')");
    expect(update?.params).toEqual([SHOP_ID, ORDER_ID]);
  });

  it('replay is a no-op: guard rejects the already-terminal row', async () => {
    const pool = new MockTxPool().on(/UPDATE "order"/, []); // rowCount 0
    const svc = makeService(pool);
    expect(await svc.markCancelledInShopify(SHOP_ID, ORDER_ID)).toBe(false);
  });
});
