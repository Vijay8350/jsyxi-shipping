import { REPORT_CATALOGUE } from '../report-catalogue';
import {
  applyAttributionFrame,
  applySharedFilters,
  applyTestExclusion,
  money2,
  Where,
} from '../report-filters';
import { ReportData, ReportGenerator } from '../reports.types';
import { ratio } from './courier-perf';

interface PaymentModeRow {
  period: string;
  payment_mode: string | null;
  volume: string;
  value: string | null;
  delivered: string;
  rto_delivered: string;
  terminal: string;
}

/**
 * §11 PAYMENT_MODE — Payment-mode analysis. Grain: payment mode × period,
 * where the period is the shop-local calendar MONTH of booked-at (§5.2:
 * shipments and cost attribute to booked-at; local ranges are shop-local).
 * Value is the summed F-17 order amount in shop money (INR, INV-2).
 * Delivery/RTO rates are F-16.a / F-16.c.
 */
export const generatePaymentMode: ReportGenerator = async (q, ctx): Promise<ReportData> => {
  const w = new Where();
  w.add(`s.shop_id = ${w.param(ctx.shopId)}::uuid`);
  w.add(`s.booked_at IS NOT NULL`);
  applyTestExclusion(w, 's.is_test', ctx.filters.includeTest);
  applyAttributionFrame(w, 's.booked_at', ctx.filters, ctx.timezone, ctx.asOf);
  applySharedFilters(w, ctx.filters, {
    serviceId: 's.service_id',
    courierAccountId: 's.courier_account_id',
    paymentMode: `s.snapshot -> 'payment' ->> 'mode'`,
  });
  const tz = w.param(ctx.timezone);

  const { rows } = await q.query<PaymentModeRow>(
    `SELECT to_char(s.booked_at AT TIME ZONE ${tz}, 'YYYY-MM') AS period,
            COALESCE(s.snapshot -> 'payment' ->> 'mode', 'UNRESOLVED') AS payment_mode,
            count(*)::text AS volume,
            ${money2('sum(o.order_amount)')} AS value,
            count(*) FILTER (WHERE s.movement_state = 'DELIVERED')::text AS delivered,
            count(*) FILTER (WHERE s.movement_state = 'RTO_DELIVERED')::text AS rto_delivered,
            count(*) FILTER (WHERE s.movement_state IN
                     ('DELIVERED', 'RTO_DELIVERED', 'LOST_OR_DAMAGED', 'CANCELLED_BY_COURIER'))::text AS terminal
       FROM shipment s
       JOIN "order" o ON o.order_id = s.order_id
       ${w.sql()}
      GROUP BY 1, 2
      ORDER BY 1 ASC, 2 ASC`,
    w.values(),
  );

  return {
    columns: REPORT_CATALOGUE.PAYMENT_MODE.columns,
    rows: rows.map((r) => [
      r.period,
      r.payment_mode,
      r.volume,
      r.value,
      ratio(r.delivered, String(Number(r.delivered) + Number(r.rto_delivered))),
      ratio(r.rto_delivered, r.terminal),
    ]),
  };
};
