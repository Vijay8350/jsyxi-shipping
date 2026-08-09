import { REPORT_CATALOGUE } from '../report-catalogue';
import {
  applyAttributionFrame,
  applySharedFilters,
  applyTestExclusion,
  money2,
  Where,
} from '../report-filters';
import { ReportData, ReportGenerator } from '../reports.types';

interface ShipmentRow {
  awb: string | null;
  service: string | null;
  booked_at: string | null;
  dead_weight_kg: string | null;
  billable_weight_kg: string | null;
  expected_cost: string | null;
  expected_cost_basis: string | null;
  collectible: string | null;
  movement_state: string;
  delivered_at: string | null;
  tat_hours: string | null;
}

/**
 * §11 SHIPMENTS — Shipment / AWB export. Grain: Shipments; attribution:
 * booked-at (§5.2). Weights (F-24 dead, F-3 billable), F-11 expected cost and
 * the Service name all come from the frozen booking snapshot (§2.9, INV-10) —
 * never from live rate data. TAT is F-16.d: PICKED_UP occurred-at → DELIVERED
 * occurred-at, calendar hours, both bounded by the job's as-of.
 */
export const generateShipments: ReportGenerator = async (q, ctx): Promise<ReportData> => {
  const w = new Where();
  w.add(`s.shop_id = ${w.param(ctx.shopId)}::uuid`);
  w.add(`s.booked_at IS NOT NULL`);
  applyTestExclusion(w, 's.is_test', ctx.filters.includeTest);
  applyAttributionFrame(w, 's.booked_at', ctx.filters, ctx.timezone, ctx.asOf);
  applySharedFilters(w, ctx.filters, {
    serviceId: 's.service_id',
    courierAccountId: 's.courier_account_id',
    status: 's.movement_state',
    paymentMode: `s.snapshot -> 'payment' ->> 'mode'`,
  });
  const asOf = w.param(ctx.asOf.toISOString());

  const { rows } = await q.query<ShipmentRow>(
    `SELECT s.awb_normalized AS awb,
            s.snapshot -> 'service' ->> 'name' AS service,
            s.booked_at::text,
            s.snapshot -> 'weights' ->> 'deadWeightKg' AS dead_weight_kg,
            s.snapshot -> 'weights' ->> 'billableWeightKg' AS billable_weight_kg,
            ${money2(`NULLIF(s.snapshot -> 'expectedQuote' ->> 'total', '')::numeric`)} AS expected_cost,
            s.expected_cost_basis::text,
            ${money2('s.collectible')} AS collectible,
            s.movement_state::text,
            s.delivered_at::text,
            (SELECT ROUND((EXTRACT(EPOCH FROM (
                       max(CASE WHEN te.carrier_event_status = 'DELIVERED' THEN te.occurred_at END)
                     - min(CASE WHEN te.carrier_event_status = 'PICKED_UP' THEN te.occurred_at END)
                     )) / 3600)::numeric, 1)::text
               FROM tracking_event te
              WHERE te.shipment_id = s.shipment_id
                AND te.occurred_at <= ${asOf}::timestamptz) AS tat_hours
       FROM shipment s
       ${w.sql()}
      ORDER BY s.booked_at ASC`,
    w.values(),
  );

  return {
    columns: REPORT_CATALOGUE.SHIPMENTS.columns,
    rows: rows.map((r) => [
      r.awb,
      r.service,
      r.booked_at,
      r.dead_weight_kg,
      r.billable_weight_kg,
      r.expected_cost,
      r.expected_cost_basis,
      r.collectible,
      r.movement_state,
      r.delivered_at,
      r.tat_hours,
    ]),
  };
};
