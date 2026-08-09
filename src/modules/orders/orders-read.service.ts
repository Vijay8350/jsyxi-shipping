import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { TestView } from '../dashboard/dashboard.types';

/**
 * Read models for the merchant console's order and shipment lists.
 *
 * The rest of the API is per-object (book this shipment, label that one); the
 * console needs list surfaces, and those did not exist. Read-only and strictly
 * shop-scoped — every query filters on shop_id (INV-1), never on an id alone.
 *
 * §9.23: `view` selects test or live and DEFAULTS TO LIVE. A merchant must
 * never mistake a test parcel for a real one, so the filter is applied in SQL
 * rather than in the client where it could be forgotten.
 *
 * No PII beyond what the list needs: recipient city/state/pincode come from the
 * snapshot for display, but never phone, email or address lines (§5.7 control
 * 4, RV-13 minimisation).
 */

export const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

export interface ListQuery {
  shopId: string;
  view: TestView;
  state?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface OrderListItem {
  orderId: string;
  orderNumber: string | null;
  orderState: string;
  paymentMode: string;
  codAssignmentState: string;
  orderAmount: string | null;
  codOutstanding: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  isTest: boolean;
  createdAt: string;
  shipmentCount: number;
}

export interface ShipmentListItem {
  shipmentId: string;
  orderId: string;
  orderNumber: string | null;
  awb: string | null;
  bookingState: string;
  custodyState: string;
  movementState: string;
  collectible: string;
  isTest: boolean;
  bookedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  courierCode: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  view: TestView;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(limit), MAX_PAGE_SIZE);
}

function clampOffset(offset: number | undefined): number {
  if (!offset || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

@Injectable()
export class OrdersReadService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async listOrders(q: ListQuery): Promise<Page<OrderListItem>> {
    const limit = clampLimit(q.limit);
    const offset = clampOffset(q.offset);
    const isTest = q.view === 'test';

    // $3 is compared against a whitelist of enum labels via a text cast, so an
    // arbitrary value simply matches nothing rather than erroring on the enum.
    const params: unknown[] = [q.shopId, isTest, q.state ?? null, q.search ?? null];

    const where = `
      WHERE o.shop_id = $1
        AND o.is_test_order = $2
        AND ($3::text IS NULL OR o.order_state::text = $3)
        AND ($4::text IS NULL OR o.shopify_order_number ILIKE '%' || $4 || '%')`;

    const { rows: countRows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM "order" o ${where}`,
      params,
    );

    const { rows } = await this.pool.query(
      `SELECT
         o.order_id, o.shopify_order_number, o.order_state, o.payment_mode,
         o.cod_assignment_state, o.order_amount, o.cod_outstanding,
         o.is_test_order, o.created_at,
         o.recipient_snapshot->>'city'    AS city,
         o.recipient_snapshot->>'state'   AS state,
         o.recipient_snapshot->>'pincode' AS pincode,
         (SELECT count(*)::int FROM shipment s
           WHERE s.shop_id = o.shop_id AND s.order_id = o.order_id) AS shipment_count
       FROM "order" o
       ${where}
       ORDER BY o.created_at DESC, o.order_id DESC
       LIMIT $5 OFFSET $6`,
      [...params, limit, offset],
    );

    return {
      items: rows.map(
        (r): OrderListItem => ({
          orderId: r.order_id,
          orderNumber: r.shopify_order_number,
          orderState: r.order_state,
          paymentMode: r.payment_mode,
          codAssignmentState: r.cod_assignment_state,
          orderAmount: r.order_amount,
          codOutstanding: r.cod_outstanding,
          city: r.city,
          state: r.state,
          pincode: r.pincode,
          isTest: r.is_test_order,
          createdAt: toIso(r.created_at),
          shipmentCount: r.shipment_count ?? 0,
        }),
      ),
      total: Number(countRows[0]?.n ?? 0),
      limit,
      offset,
      view: q.view,
    };
  }

  async listShipments(q: ListQuery): Promise<Page<ShipmentListItem>> {
    const limit = clampLimit(q.limit);
    const offset = clampOffset(q.offset);
    const isTest = q.view === 'test';

    const params: unknown[] = [q.shopId, isTest, q.state ?? null, q.search ?? null];

    // AWB search uses the F-19 normalized form, so a merchant can paste an AWB
    // with spaces or hyphens and still find it.
    const where = `
      WHERE s.shop_id = $1
        AND s.is_test = $2
        AND ($3::text IS NULL OR s.booking_state::text = $3)
        AND ($4::text IS NULL
             OR s.awb_normalized ILIKE '%' || upper(regexp_replace($4, '[\\s-]', '', 'g')) || '%'
             OR o.shopify_order_number ILIKE '%' || $4 || '%')`;

    const { rows: countRows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::int AS n
         FROM shipment s JOIN "order" o ON o.order_id = s.order_id ${where}`,
      params,
    );

    const { rows } = await this.pool.query(
      `SELECT
         s.shipment_id, s.order_id, o.shopify_order_number, s.awb_raw, s.awb_normalized,
         s.booking_state, s.custody_state, s.movement_state, s.collectible,
         s.is_test, s.booked_at, s.delivered_at, s.created_at,
         c.code AS courier_code
       FROM shipment s
       JOIN "order" o ON o.order_id = s.order_id
       LEFT JOIN courier_account ca ON ca.courier_account_id = s.courier_account_id
       LEFT JOIN courier c ON c.courier_id = ca.courier_id
       ${where}
       ORDER BY s.created_at DESC, s.shipment_id DESC
       LIMIT $5 OFFSET $6`,
      [...params, limit, offset],
    );

    return {
      items: rows.map(
        (r): ShipmentListItem => ({
          shipmentId: r.shipment_id,
          orderId: r.order_id,
          orderNumber: r.shopify_order_number,
          awb: r.awb_raw ?? r.awb_normalized ?? null,
          bookingState: r.booking_state,
          custodyState: r.custody_state,
          movementState: r.movement_state,
          collectible: r.collectible,
          isTest: r.is_test,
          bookedAt: r.booked_at ? toIso(r.booked_at) : null,
          deliveredAt: r.delivered_at ? toIso(r.delivered_at) : null,
          createdAt: toIso(r.created_at),
          courierCode: r.courier_code ?? null,
        }),
      ),
      total: Number(countRows[0]?.n ?? 0),
      limit,
      offset,
      view: q.view,
    };
  }

  /**
   * One order with its lines and shipments. Returns null when the order does
   * not belong to this shop — the caller turns that into a 404, so a probe
   * cannot distinguish "not yours" from "does not exist" (INV-1).
   */
  async getOrder(shopId: string, orderId: string): Promise<unknown | null> {
    const { rows } = await this.pool.query(
      `SELECT order_id, shopify_order_number, order_state, payment_mode,
              cod_assignment_state, order_amount, cod_outstanding, shop_currency,
              checkout_shipping_title, checkout_shipping_amount,
              is_test_order, source, risk_flag, created_at, created_at_shopify,
              recipient_snapshot->>'city'    AS city,
              recipient_snapshot->>'state'   AS state,
              recipient_snapshot->>'pincode' AS pincode
         FROM "order"
        WHERE shop_id = $1 AND order_id = $2`,
      [shopId, orderId],
    );
    const o = rows[0];
    if (!o) return null;

    const { rows: lines } = await this.pool.query(
      `SELECT order_line_id, sku, title, quantity, unit_price
         FROM order_line WHERE order_id = $1 ORDER BY order_line_id`,
      [orderId],
    );
    const { rows: shipments } = await this.pool.query(
      `SELECT s.shipment_id, s.awb_raw, s.awb_normalized, s.booking_state,
              s.custody_state, s.movement_state, s.collectible, s.is_test,
              s.booked_at, s.delivered_at, s.created_at, c.code AS courier_code
         FROM shipment s
         LEFT JOIN courier_account ca ON ca.courier_account_id = s.courier_account_id
         LEFT JOIN courier c ON c.courier_id = ca.courier_id
        WHERE s.shop_id = $1 AND s.order_id = $2
        ORDER BY s.created_at DESC`,
      [shopId, orderId],
    );

    return {
      orderId: o.order_id,
      orderNumber: o.shopify_order_number,
      orderState: o.order_state,
      paymentMode: o.payment_mode,
      codAssignmentState: o.cod_assignment_state,
      orderAmount: o.order_amount,
      codOutstanding: o.cod_outstanding,
      currency: o.shop_currency,
      checkoutShippingTitle: o.checkout_shipping_title,
      checkoutShippingAmount: o.checkout_shipping_amount,
      isTest: o.is_test_order,
      source: o.source,
      riskFlag: o.risk_flag,
      createdAt: toIso(o.created_at),
      createdAtShopify: o.created_at_shopify ? toIso(o.created_at_shopify) : null,
      city: o.city,
      state: o.state,
      pincode: o.pincode,
      lines: lines.map((l) => ({
        orderLineId: l.order_line_id,
        sku: l.sku,
        title: l.title,
        quantity: l.quantity,
        unitPrice: l.unit_price,
      })),
      shipments: shipments.map((s) => ({
        shipmentId: s.shipment_id,
        awb: s.awb_raw ?? s.awb_normalized ?? null,
        bookingState: s.booking_state,
        custodyState: s.custody_state,
        movementState: s.movement_state,
        collectible: s.collectible,
        isTest: s.is_test,
        courierCode: s.courier_code ?? null,
        bookedAt: s.booked_at ? toIso(s.booked_at) : null,
        deliveredAt: s.delivered_at ? toIso(s.delivered_at) : null,
        createdAt: toIso(s.created_at),
      })),
    };
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
