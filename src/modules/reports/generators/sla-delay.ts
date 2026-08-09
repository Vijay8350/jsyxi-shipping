import { DELAY_THRESHOLD_MS } from '../../tracking/tracking-delay.service';
import { REPORT_CATALOGUE } from '../report-catalogue';
import {
  applyAttributionFrame,
  applySharedFilters,
  applyTestExclusion,
  Where,
} from '../report-filters';
import { ReportData, ReportGenerator } from '../reports.types';

interface SlaRow {
  awb: string | null;
  edd: string | null;
  actual: string | null;
  delay_hours: string | null;
}

/**
 * §11 SLA_DELAY — SLA / delay. Grain: Shipments (booked cohort, §5.2). The
 * EDD is the frozen snapshot quote's eddTo (INV-8 — never current data).
 * "actual" is the delivered occurred-at while the shipment is open; delay
 * hours are measured against the as-of instant for undelivered shipments.
 * The flag is S-47: EDD exceeded by more than 24 hours (RW-06), reusing the
 * tracking module's DELAY_THRESHOLD_MS constant.
 */
export const generateSlaDelay: ReportGenerator = async (q, ctx): Promise<ReportData> => {
  const w = new Where();
  w.add(`s.shop_id = ${w.param(ctx.shopId)}::uuid`);
  w.add(`s.booked_at IS NOT NULL`);
  w.add(`NULLIF(s.snapshot -> 'expectedQuote' ->> 'eddTo', '') IS NOT NULL`);
  applyTestExclusion(w, 's.is_test', ctx.filters.includeTest);
  applyAttributionFrame(w, 's.booked_at', ctx.filters, ctx.timezone, ctx.asOf);
  applySharedFilters(w, ctx.filters, {
    serviceId: 's.service_id',
    courierAccountId: 's.courier_account_id',
    status: 's.movement_state',
  });
  const asOf = w.param(ctx.asOf.toISOString());

  const { rows } = await q.query<SlaRow>(
    `SELECT s.awb_normalized AS awb,
            s.snapshot -> 'expectedQuote' ->> 'eddTo' AS edd,
            s.delivered_at::text AS actual,
            ROUND((EXTRACT(EPOCH FROM (
                     COALESCE(s.delivered_at, ${asOf}::timestamptz)
                     - (s.snapshot -> 'expectedQuote' ->> 'eddTo')::timestamptz
                   )) / 3600)::numeric, 1)::text AS delay_hours
       FROM shipment s
       ${w.sql()}
      ORDER BY s.booked_at ASC`,
    w.values(),
  );

  return {
    columns: REPORT_CATALOGUE.SLA_DELAY.columns,
    rows: rows.map((r) => {
      const delayMs = r.delay_hours === null ? null : Number(r.delay_hours) * 3600_000;
      return [
        r.awb,
        r.edd,
        r.actual,
        r.delay_hours,
        // S-47: delayed when the EDD is exceeded by more than 24 hours.
        delayMs !== null && delayMs > DELAY_THRESHOLD_MS ? 'DELAYED' : 'WITHIN_SLA',
      ];
    }),
  };
};
