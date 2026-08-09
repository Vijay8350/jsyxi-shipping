import { REPORT_CATALOGUE } from '../report-catalogue';
import {
  applyAttributionFrame,
  applySharedFilters,
  applyTestExclusion,
  money2,
  Where,
} from '../report-filters';
import { ReportData, ReportGenerator } from '../reports.types';

interface ProfitRow {
  awb: string | null;
  order_amount: string | null;
  expected_freight: string | null;
  margin: string | null;
}

/**
 * §11 PROFITABILITY — shipment profitability (RW-10). Grain: Shipments
 * (booked cohort, §5.2). order_amount is F-17; expected_freight is F-11 from
 * the frozen snapshot quote (null when expected_cost_basis = NONE, §3.25);
 * margin is the merchant's F-17 − F-11 (a merchant margin on their own
 * courier cost — INV-23's "no margin field" is about Jsyxi never marking up
 * a rate card, which this read-only computation does not touch).
 *
 * invoiced_freight and variance are blank until the §2.7 recon tables land
 * (weeks 14–15): they are the Σ of the AWB's FORWARD recon_freight_row
 * amounts and invoiced − expected. The columns are present now so the export
 * shape matches §11; the join is added with the recon block.
 */
export const generateProfitability: ReportGenerator = async (q, ctx): Promise<ReportData> => {
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

  const { rows } = await q.query<ProfitRow>(
    `SELECT s.awb_normalized AS awb,
            ${money2('o.order_amount')} AS order_amount,
            ${money2(`NULLIF(s.snapshot -> 'expectedQuote' ->> 'total', '')::numeric`)} AS expected_freight,
            ${money2(`o.order_amount - NULLIF(s.snapshot -> 'expectedQuote' ->> 'total', '')::numeric`)} AS margin
       FROM shipment s
       JOIN "order" o ON o.order_id = s.order_id
       ${w.sql()}
      ORDER BY s.booked_at ASC`,
    w.values(),
  );

  return {
    columns: REPORT_CATALOGUE.PROFITABILITY.columns,
    rows: rows.map((r) => [
      r.awb,
      r.order_amount,
      r.expected_freight,
      null, // invoiced_freight — §2.7 recon tables land in weeks 14–15
      null, // variance — invoiced − expected, same dependency
      r.margin,
    ]),
  };
};
