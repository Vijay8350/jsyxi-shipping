import { REPORT_CATALOGUE } from '../report-catalogue';
import { applySharedFilters, applyTestExclusion, money2, Where } from '../report-filters';
import { ReportData, ReportGenerator } from '../reports.types';

interface CodUnassignedRow {
  order_number: string | null;
  cod_outstanding: string | null;
  shipments_booked: string;
  flagged_at: string | null;
  age_days: string;
}

/**
 * §11 COD_UNASSIGNED — orders with cod_assignment_state = UNASSIGNED
 * (§3.24), the row §4.7 promises (RW-10): a COD order whose collectible has
 * no active carrier. cod_outstanding is F-15; shipments_booked counts active
 * AWBs (awb set, booking not VOID — the migration-0003 definition);
 * flagged_at is the order's last update (the closest stored instant to the
 * state flip — there is no per-state timestamp in §2.4); age is calendar
 * days from flagged_at to the as-of. A current-state report.
 */
export const generateCodUnassigned: ReportGenerator = async (q, ctx): Promise<ReportData> => {
  const w = new Where();
  w.add(`o.shop_id = ${w.param(ctx.shopId)}::uuid`);
  w.add(`o.cod_assignment_state = 'UNASSIGNED'`);
  w.add(`o.created_at <= ${w.param(ctx.asOf.toISOString())}::timestamptz`);
  applyTestExclusion(w, 'o.is_test_order', ctx.filters.includeTest);
  applySharedFilters(w, ctx.filters, { paymentMode: 'o.payment_mode' });
  const asOf = w.param(ctx.asOf.toISOString());

  const { rows } = await q.query<CodUnassignedRow>(
    `SELECT o.shopify_order_number AS order_number,
            ${money2('o.cod_outstanding')} AS cod_outstanding,
            (SELECT count(*)::text FROM shipment s
              WHERE s.order_id = o.order_id
                AND s.awb_normalized IS NOT NULL
                AND s.booking_state <> 'VOID'
                AND s.created_at <= ${asOf}::timestamptz) AS shipments_booked,
            o.updated_at::text AS flagged_at,
            ((${asOf}::timestamptz)::date - o.updated_at::date)::text AS age_days
       FROM "order" o
       ${w.sql()}
      ORDER BY o.updated_at ASC`,
    w.values(),
  );

  return {
    columns: REPORT_CATALOGUE.COD_UNASSIGNED.columns,
    rows: rows.map((r) => [
      r.order_number,
      r.cod_outstanding,
      r.shipments_booked,
      r.flagged_at,
      r.age_days,
    ]),
  };
};
