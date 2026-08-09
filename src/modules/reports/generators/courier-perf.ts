import { REPORT_CATALOGUE } from '../report-catalogue';
import {
  applyAttributionFrame,
  applySharedFilters,
  applyTestExclusion,
  Where,
} from '../report-filters';
import { ReportContext, ReportData, ReportQuery } from '../reports.types';

export interface PerfRow {
  key: string | null;
  zone: string | null;
  volume: string;
  open_count: string;
  delivered: string;
  rto_delivered: string;
  terminal: string;
  picked_up: string;
  with_ndr: string;
  avg_tat_hours: string | null;
}

/**
 * The F-16 metric set (§4.10), shared by COURIER_PERF and PINCODE_PERF —
 * grouped by an arbitrary key expression (Service / destination pincode):
 *  - F-16.a delivery rate = Delivered ÷ (Delivered + RTO Delivered) over the
 *    booked cohort; open shipments are a separate column, in neither term;
 *  - F-16.b NDR rate = shipments with ≥1 NDR ÷ picked-up shipments;
 *  - F-16.c RTO rate = RTO Delivered ÷ terminal shipments;
 *  - F-16.d TAT = PICKED_UP → DELIVERED occurred-at, calendar hours.
 * Every event/case subquery is bounded by the job as-of (§5.2). Counting
 * unit: shipments (A2-06); test shipments excluded by default (INV-19).
 */
export async function runPerfQuery(
  q: ReportQuery,
  ctx: ReportContext,
  keyExpr: string,
  withZone: boolean,
): Promise<PerfRow[]> {
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
  const asOf = w.param(ctx.asOf.toISOString());

  const { rows } = await q.query<PerfRow>(
    `SELECT ${keyExpr} AS key,
            ${withZone ? `s.snapshot ->> 'zone'` : `NULL`} AS zone,
            count(*)::text AS volume,
            count(*) FILTER (WHERE s.movement_state NOT IN
                     ('DELIVERED', 'RTO_DELIVERED', 'LOST_OR_DAMAGED', 'CANCELLED_BY_COURIER'))::text AS open_count,
            count(*) FILTER (WHERE s.movement_state = 'DELIVERED')::text AS delivered,
            count(*) FILTER (WHERE s.movement_state = 'RTO_DELIVERED')::text AS rto_delivered,
            count(*) FILTER (WHERE s.movement_state IN
                     ('DELIVERED', 'RTO_DELIVERED', 'LOST_OR_DAMAGED', 'CANCELLED_BY_COURIER'))::text AS terminal,
            count(*) FILTER (WHERE EXISTS (
                     SELECT 1 FROM tracking_event te
                      WHERE te.shipment_id = s.shipment_id
                        AND te.carrier_event_status = 'PICKED_UP'
                        AND te.occurred_at <= ${asOf}::timestamptz))::text AS picked_up,
            count(*) FILTER (WHERE EXISTS (
                     SELECT 1 FROM ndr_case n
                      WHERE n.shipment_id = s.shipment_id
                        AND n.first_ndr_at <= ${asOf}::timestamptz))::text AS with_ndr,
            ROUND(avg(EXTRACT(EPOCH FROM (p.delivered_occurred_at - p.picked_up_occurred_at)) / 3600)
                  ::numeric, 1)::text AS avg_tat_hours
       FROM shipment s
       LEFT JOIN LATERAL (
         SELECT min(te.occurred_at) FILTER (WHERE te.carrier_event_status = 'PICKED_UP') AS picked_up_occurred_at,
                max(te.occurred_at) FILTER (WHERE te.carrier_event_status = 'DELIVERED') AS delivered_occurred_at
           FROM tracking_event te
          WHERE te.shipment_id = s.shipment_id
            AND te.occurred_at <= ${asOf}::timestamptz
       ) p ON true
       ${w.sql()}
      GROUP BY 1${withZone ? ', 2' : ''}
      ORDER BY 1 ASC`,
    w.values(),
  );
  return rows;
}

/** ratio 0–1 at 4dp; null when the denominator is 0 (never a fake zero). */
export function ratio(numerator: string, denominator: string): string | null {
  const d = Number(denominator);
  if (d === 0) return null;
  return (Number(numerator) / d).toFixed(4);
}

/**
 * §11 COURIER_PERF — Courier performance. Grain: Service (the snapshot's
 * frozen service identity, §2.9). Attribution: booked-at (§5.2).
 */
export const generateCourierPerf = async (q: ReportQuery, ctx: ReportContext): Promise<ReportData> => {
  const rows = await runPerfQuery(
    q,
    ctx,
    `COALESCE(s.snapshot -> 'service' ->> 'name', s.service_id::text)`,
    false,
  );
  return {
    columns: REPORT_CATALOGUE.COURIER_PERF.columns,
    rows: rows.map((r) => [
      r.key,
      r.volume,
      r.open_count,
      // F-16.a: Delivered ÷ (Delivered + RTO Delivered)
      ratio(r.delivered, String(Number(r.delivered) + Number(r.rto_delivered))),
      // F-16.b: ≥1 NDR ÷ picked-up
      ratio(r.with_ndr, r.picked_up),
      // F-16.c: RTO Delivered ÷ terminal
      ratio(r.rto_delivered, r.terminal),
      r.avg_tat_hours,
    ]),
  };
};
