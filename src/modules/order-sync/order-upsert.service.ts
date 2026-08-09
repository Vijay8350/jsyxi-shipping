import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { MappedOrder } from './order-mapper';

/**
 * The `order` + `order_line` writer behind §9.2.1 ingestion. One upsert
 * keyed on (shop_id, shopify_order_gid) with an INV-22 version increment.
 *
 * Deliberate boundaries (week-4 hooks):
 *  - New orders land IMPORTED (§9.2.1). INV-7 eligibility (READY/INCOMPLETE)
 *    and the §3.5 payment-mode derivation are NOT computed here — the
 *    week-4 agent consumes OrderUpsertResult and owns both.
 *  - order_state and payment_mode are never touched on update: a terminal
 *    state is never regressed (INV-17, §3.1) and a computed eligibility
 *    state is never clobbered by a sync refresh.
 *  - order_line rows are rewritten (delete+insert, same transaction) ONLY
 *    while the order is unbooked (§9.2.5, §10.4) — after any booking the
 *    Shopify edit path is cancel-then-rebook, owned elsewhere.
 */

/** §3.1 states in which no Shipment on the order can be booked yet. */
export const UNBOOKED_ORDER_STATES = ['IMPORTED', 'INCOMPLETE', 'READY'] as const;

/** §3.1 terminal states — never regressed by any sync event (INV-17). */
export const TERMINAL_ORDER_STATES = ['CANCELLED_IN_SHOPIFY', 'CLOSED'] as const;

export interface OrderUpsertResult {
  orderId: string;
  /** State AFTER the upsert — the hook the week-4 INV-7 evaluation consumes. */
  orderState: string;
  inserted: boolean;
  linesRewritten: boolean;
  unbooked: boolean;
}

interface Queryable {
  query: Pool['query'];
}

@Injectable()
export class OrderUpsertService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async upsert(shopId: string, mapped: MappedOrder): Promise<OrderUpsertResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.upsertInTx(client, shopId, mapped);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async upsertInTx(client: Queryable, shopId: string, mapped: MappedOrder): Promise<OrderUpsertResult> {
    // INV-1: every statement shop-scoped. INV-22: version increment on update.
    // order_state / payment_mode deliberately absent from the DO UPDATE —
    // see the class comment. is_test_order updates freely (INV-19's
    // immutability applies to shipment.is_test, not this mirror).
    const { rows } = await client.query<{
      order_id: string;
      order_state: string;
      inserted: boolean;
    }>(
      `INSERT INTO "order" (
         shop_id, shopify_order_gid, shopify_order_number, created_at_shopify,
         order_amount, presentment_amount, presentment_currency,
         recipient_snapshot, risk_flag, is_test_order,
         checkout_shipping_title, checkout_shipping_amount
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (shop_id, shopify_order_gid) DO UPDATE SET
         shopify_order_number    = EXCLUDED.shopify_order_number,
         created_at_shopify      = EXCLUDED.created_at_shopify,
         order_amount            = EXCLUDED.order_amount,
         presentment_amount      = EXCLUDED.presentment_amount,
         presentment_currency    = EXCLUDED.presentment_currency,
         recipient_snapshot      = EXCLUDED.recipient_snapshot,
         risk_flag               = EXCLUDED.risk_flag,
         is_test_order           = EXCLUDED.is_test_order,
         checkout_shipping_title = EXCLUDED.checkout_shipping_title,
         checkout_shipping_amount = EXCLUDED.checkout_shipping_amount,
         version = "order".version + 1
       RETURNING order_id, order_state, (xmax = 0) AS inserted`,
      [
        shopId,
        mapped.shopifyOrderGid,
        mapped.shopifyOrderNumber,
        mapped.createdAtShopify,
        mapped.orderAmount,
        mapped.presentmentAmount,
        mapped.presentmentCurrency,
        mapped.recipientSnapshot === null ? null : JSON.stringify(mapped.recipientSnapshot),
        mapped.riskFlag,
        mapped.isTestOrder,
        mapped.checkoutShippingTitle,
        mapped.checkoutShippingAmount,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('order upsert returned no row');

    const unbooked = (UNBOOKED_ORDER_STATES as readonly string[]).includes(row.order_state);
    let linesRewritten = false;
    if (unbooked) {
      // §9.2.5 / §10.4: pre-booking edits refresh the lines — rewrite in the
      // same transaction. A booked order keeps its lines untouched.
      await client.query(`DELETE FROM order_line WHERE order_id = $1`, [row.order_id]);
      if (mapped.lines.length > 0) {
        const values: string[] = [];
        const params: unknown[] = [row.order_id];
        mapped.lines.forEach((line, i) => {
          const base = 2 + i * 9;
          values.push(
            `($1, $${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
          );
          params.push(
            line.shopifyLineGid,
            line.sku,
            line.title,
            line.variant,
            line.quantity,
            line.unitPrice,
            line.tags,
            line.hsnCode,
            line.weightKgPerUnit,
          );
        });
        await client.query(
          `INSERT INTO order_line (
             order_id, shopify_line_gid, sku, title, variant, quantity,
             unit_price, tags, hsn_code, weight_kg_override
           ) VALUES ${values.join(', ')}`,
          params,
        );
      }
      linesRewritten = true;
    }

    return {
      orderId: row.order_id,
      orderState: row.order_state,
      inserted: row.inserted,
      linesRewritten,
      unbooked,
    };
  }

  /**
   * orders/cancelled → CANCELLED_IN_SHOPIFY (terminal, §3.1). The guard on
   * current state makes both a replay and a post-CLOSED late event a no-op
   * (INV-17: a terminal state is never regressed).
   *
   * @returns true when this call performed the transition.
   */
  async markCancelledInShopify(shopId: string, orderId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE "order"
          SET order_state = 'CANCELLED_IN_SHOPIFY',
              version = version + 1
        WHERE shop_id = $1
          AND order_id = $2
          AND order_state NOT IN ('CANCELLED_IN_SHOPIFY', 'CLOSED')`,
      [shopId, orderId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Shop-scoped lookup by Shopify GID (INV-1) for handlers that receive
   *  only the GID. */
  async findOrderId(shopId: string, shopifyOrderGid: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ order_id: string }>(
      `SELECT order_id FROM "order" WHERE shop_id = $1 AND shopify_order_gid = $2`,
      [shopId, shopifyOrderGid],
    );
    return rows[0]?.order_id ?? null;
  }
}

export type { PoolClient };
