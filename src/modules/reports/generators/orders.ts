import { deriveOrderShippingStatus } from '../../order-derivation/order-status';
import { REPORT_CATALOGUE } from '../report-catalogue';
import {
  applyAttributionFrame,
  applySharedFilters,
  applyTestExclusion,
  money2,
  Where,
} from '../report-filters';
import { ReportData, ReportGenerator } from '../reports.types';

interface OrderRow {
  order_id: string;
  order_number: string | null;
  created_at: string | null;
  order_amount: string | null;
  payment_mode: string;
  order_state: string;
  cod_outstanding: string | null;
  cod_assignment_state: string;
}

interface ShipmentStateRow {
  order_id: string;
  booking_state: string;
  movement_state: string;
  custody_state: string;
}

/**
 * §11 ORDERS — Order export. Grain: Orders; attribution: Shopify created-at
 * (§5.2). derived_status is F-22, computed by the order-derivation module's
 * own pure function — never re-derived here.
 */
export const generateOrders: ReportGenerator = async (q, ctx): Promise<ReportData> => {
  const w = new Where();
  w.add(`o.shop_id = ${w.param(ctx.shopId)}::uuid`);
  applyTestExclusion(w, 'o.is_test_order', ctx.filters.includeTest);
  applyAttributionFrame(w, 'o.created_at_shopify', ctx.filters, ctx.timezone, ctx.asOf);
  applySharedFilters(w, ctx.filters, { paymentMode: 'o.payment_mode', status: 'o.order_state' });

  const { rows: orders } = await q.query<OrderRow>(
    `SELECT o.order_id,
            o.shopify_order_number AS order_number,
            o.created_at_shopify::text AS created_at,
            ${money2('o.order_amount')} AS order_amount,
            o.payment_mode::text,
            o.order_state::text,
            ${money2('o.cod_outstanding')} AS cod_outstanding,
            o.cod_assignment_state::text
       FROM "order" o
       ${w.sql()}
      ORDER BY o.created_at_shopify ASC`,
    w.values(),
  );

  if (orders.length === 0) return { columns: REPORT_CATALOGUE.ORDERS.columns, rows: [] };

  // F-22 needs each order's shipment states; bounded by the same as-of so a
  // shipment created after job start cannot change an exported status.
  const ids = new Where();
  const { rows: shipments } = await q.query<ShipmentStateRow>(
    `SELECT s.order_id, s.booking_state::text, s.movement_state::text, s.custody_state::text
       FROM shipment s
      WHERE s.shop_id = ${ids.param(ctx.shopId)}::uuid
        AND s.order_id = ANY(${ids.param(orders.map((o) => o.order_id))}::uuid[])
        AND s.created_at <= ${ids.param(ctx.asOf.toISOString())}::timestamptz`,
    ids.values(),
  );

  const byOrder = new Map<string, ShipmentStateRow[]>();
  for (const s of shipments) {
    const list = byOrder.get(s.order_id) ?? [];
    list.push(s);
    byOrder.set(s.order_id, list);
  }

  return {
    columns: REPORT_CATALOGUE.ORDERS.columns,
    rows: orders.map((o) => {
      const states = byOrder.get(o.order_id) ?? [];
      return [
        o.order_number,
        o.created_at,
        o.order_amount,
        o.payment_mode,
        deriveOrderShippingStatus({
          orderState: o.order_state,
          shipments: states.map((s) => ({
            bookingState: s.booking_state,
            movementState: s.movement_state,
            custodyState: s.custody_state,
          })),
        }),
        String(states.length),
        o.cod_outstanding,
        o.cod_assignment_state,
      ];
    }),
  };
};
