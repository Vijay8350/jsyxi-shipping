import { REPORT_CATALOGUE } from '../report-catalogue';
import { applySharedFilters, applyTestExclusion, Where } from '../report-filters';
import { ReportData, ReportGenerator } from '../reports.types';

interface ManualRow {
  order_number: string | null;
  awb: string | null;
  manual_assignment_reason: string | null;
  service_failure_reasons: string | null;
  age_days: string;
}

/**
 * §11 MANUAL_ASSIGNMENT — shipments with BOOKING_STATE =
 * NEEDS_MANUAL_ASSIGNMENT (§3.2), the list behind the dashboard card (RW-10).
 * manual_assignment_reason is §3.30; the per-Service failure reasons behind
 * it come from the latest rule_evaluation_trace's candidate_results (§2.4) —
 * "serviceId: REASON, REASON" per eliminated candidate, bounded by the as-of.
 * Age is calendar days since the shipment's last state change (updated_at is
 * the closest stored instant; there is no per-state timestamp in §2.4).
 * A current-state report: the cohort is who needs assignment AT the as-of.
 */
export const generateManualAssignment: ReportGenerator = async (q, ctx): Promise<ReportData> => {
  const w = new Where();
  w.add(`s.shop_id = ${w.param(ctx.shopId)}::uuid`);
  w.add(`s.booking_state = 'NEEDS_MANUAL_ASSIGNMENT'`);
  w.add(`s.created_at <= ${w.param(ctx.asOf.toISOString())}::timestamptz`);
  applyTestExclusion(w, 's.is_test', ctx.filters.includeTest);
  applySharedFilters(w, ctx.filters, {
    courierAccountId: 's.courier_account_id',
    status: 's.manual_assignment_reason',
  });
  const asOf = w.param(ctx.asOf.toISOString());

  const { rows } = await q.query<ManualRow>(
    `SELECT o.shopify_order_number AS order_number,
            s.awb_normalized AS awb,
            s.manual_assignment_reason::text,
            (SELECT string_agg(
                      COALESCE(c ->> 'serviceId', '?') || ': ' ||
                      COALESCE((SELECT string_agg(r ->> 'code', ', ')
                                  FROM jsonb_array_elements(c -> 'reasons') r), '-'),
                      '; ')
               FROM jsonb_array_elements(tr.candidate_results) c
              WHERE (c ->> 'eliminated')::boolean) AS service_failure_reasons,
            ((${asOf}::timestamptz)::date - s.updated_at::date)::text AS age_days
       FROM shipment s
       JOIN "order" o ON o.order_id = s.order_id
       LEFT JOIN LATERAL (
         SELECT t.candidate_results
           FROM rule_evaluation_trace t
          WHERE t.shipment_id = s.shipment_id
            AND t.evaluated_at <= ${asOf}::timestamptz
          ORDER BY t.evaluated_at DESC
          LIMIT 1
       ) tr ON true
       ${w.sql()}
      ORDER BY s.updated_at ASC`,
    w.values(),
  );

  return {
    columns: REPORT_CATALOGUE.MANUAL_ASSIGNMENT.columns,
    rows: rows.map((r) => [
      r.order_number,
      r.awb,
      r.manual_assignment_reason,
      r.service_failure_reasons,
      r.age_days,
    ]),
  };
};
