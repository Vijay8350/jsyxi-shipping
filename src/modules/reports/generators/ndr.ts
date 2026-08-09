import { REPORT_CATALOGUE } from '../report-catalogue';
import {
  applyAttributionFrame,
  applySharedFilters,
  applyTestExclusion,
  Where,
} from '../report-filters';
import { ReportData, ReportGenerator } from '../reports.types';

interface NdrRow {
  awb: string | null;
  reason: string;
  case_state: string;
  attempts: number;
  action_taken: string | null;
  age_days: string;
  outcome: string;
}

/**
 * §11 NDR — NDR cases. Grain: ndr_case; attribution: first-NDR-at (§5.2).
 * action_taken is the latest submitted §3.10 action (bounded by as-of);
 * outcome is the shipment's current movement state; age is calendar days
 * from first_ndr_at to the as-of date.
 */
export const generateNdr: ReportGenerator = async (q, ctx): Promise<ReportData> => {
  const w = new Where();
  w.add(`n.shop_id = ${w.param(ctx.shopId)}::uuid`);
  applyAttributionFrame(w, 'n.first_ndr_at', ctx.filters, ctx.timezone, ctx.asOf);
  applySharedFilters(w, ctx.filters, { status: 'n.state' });
  const asOf = w.param(ctx.asOf.toISOString());
  // §9.23 test filter applies to the case's shipment.
  if (!ctx.filters.includeTest) w.add(`s.is_test = false`);

  const { rows } = await q.query<NdrRow>(
    `SELECT s.awb_normalized AS awb,
            n.reason_code::text AS reason,
            n.state::text AS case_state,
            n.attempt_count AS attempts,
            (SELECT a.action::text FROM ndr_action a
              WHERE a.ndr_case_id = n.ndr_case_id
                AND a.submitted_at <= ${asOf}::timestamptz
              ORDER BY a.submitted_at DESC LIMIT 1) AS action_taken,
            ((${asOf}::timestamptz)::date - n.first_ndr_at::date)::text AS age_days,
            s.movement_state::text AS outcome
       FROM ndr_case n
       JOIN shipment s ON s.shipment_id = n.shipment_id
       ${w.sql()}
      ORDER BY n.first_ndr_at ASC`,
    w.values(),
  );

  return {
    columns: REPORT_CATALOGUE.NDR.columns,
    rows: rows.map((r) => [
      r.awb,
      r.reason,
      r.case_state,
      String(r.attempts),
      r.action_taken,
      r.age_days,
      r.outcome,
    ]),
  };
};
