import { REPORT_CATALOGUE } from '../report-catalogue';
import { applySharedFilters, applyTestExclusion, Where } from '../report-filters';
import { ReportData, ReportGenerator } from '../reports.types';

interface InvoicePendingRow {
  order_number: string | null;
  invoice_state: string;
  missing_fields: string | null;
  age_days: string;
}

/**
 * §11 INVOICE_PENDING — gst_invoice in ISSUE_PENDING (§3.12), the list
 * behind the dashboard card (RW-10). missing_fields is the §9.9.2 list
 * stored on the invoice; age is calendar days from invoice creation to the
 * as-of. A current-state report: the cohort is what is pending AT the as-of.
 */
export const generateInvoicePending: ReportGenerator = async (q, ctx): Promise<ReportData> => {
  const w = new Where();
  w.add(`gi.shop_id = ${w.param(ctx.shopId)}::uuid`);
  w.add(`gi.state = 'ISSUE_PENDING'`);
  w.add(`gi.created_at <= ${w.param(ctx.asOf.toISOString())}::timestamptz`);
  applyTestExclusion(w, 'COALESCE(o.is_test_order, false)', ctx.filters.includeTest);
  applySharedFilters(w, ctx.filters, { paymentMode: 'o.payment_mode' });
  const asOf = w.param(ctx.asOf.toISOString());

  const { rows } = await q.query<InvoicePendingRow>(
    `SELECT o.shopify_order_number AS order_number,
            gi.state::text AS invoice_state,
            (SELECT string_agg(f, ', ') FROM jsonb_array_elements_text(gi.missing_fields) f)
              AS missing_fields,
            ((${asOf}::timestamptz)::date - gi.created_at::date)::text AS age_days
       FROM gst_invoice gi
       JOIN "order" o ON o.order_id = gi.order_id
       ${w.sql()}
      ORDER BY gi.created_at ASC`,
    w.values(),
  );

  return {
    columns: REPORT_CATALOGUE.INVOICE_PENDING.columns,
    rows: rows.map((r) => [r.order_number, r.invoice_state, r.missing_fields, r.age_days]),
  };
};
