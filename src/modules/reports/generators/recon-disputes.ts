import { REPORT_CATALOGUE } from '../report-catalogue';
import {
  applySharedFilters,
  applyTestExclusion,
  money2,
  Where,
} from '../report-filters';
import {
  ReportData,
  ReportGenerator,
  ReportSourceUnavailableError,
} from '../reports.types';

interface ReconDisputeRow {
  awb: string;
  charge_type: string;
  invoiced_amount: string | null;
  expected_amount: string | null;
  audited_amount: string | null;
  flag_awb_not_found: boolean;
  flag_weight_mismatch: boolean;
  flag_amount_mismatch: boolean;
  flag_review: boolean;
  workflow_state: string;
  batch_residual: string | null;
  control_total_state: string;
}

/**
 * §11 RECON_DISPUTES — Freight recon disputes. Grain: recon_freight_row
 * (§2.7). Attribution: the batch's invoice date (§5.2 — reconciliation
 * attributes to the invoice/remittance date; the as-of bound is applied to
 * the batch's uploaded_at, the separate upload axis §5.2 names).
 *
 * The recon tables land with the weeks 14–15 reconciliation block. This SQL
 * is written against the §2.7 column names and will run unchanged when the
 * migration lands; until then PostgreSQL 42P01 (undefined table) is caught
 * and rethrown as ReportSourceUnavailableError, which the job runner records
 * as a FAILED report_job — a typed "report source not yet available", never
 * a crash.
 */
export const generateReconDisputes: ReportGenerator = async (q, ctx): Promise<ReportData> => {
  const w = new Where();
  w.add(`b.shop_id = ${w.param(ctx.shopId)}::uuid`);
  // As-of bound: rows from batches uploaded after job start are invisible.
  w.add(`b.uploaded_at <= ${w.param(ctx.asOf.toISOString())}::timestamptz`);
  if (ctx.filters.dateFrom) {
    w.add(`b.invoice_date >= ${w.param(ctx.filters.dateFrom)}::date`);
  }
  if (ctx.filters.dateTo) {
    w.add(`b.invoice_date <= ${w.param(ctx.filters.dateTo)}::date`);
  }
  applySharedFilters(w, ctx.filters, {
    courierAccountId: 'b.courier_account_id',
    status: 'r.workflow_state',
  });
  // §9.23: a recon row inherits the test flag of its matched shipment.
  applyTestExclusion(w, 'COALESCE(s.is_test, false)', ctx.filters.includeTest);

  try {
    const { rows } = await q.query<ReconDisputeRow>(
      `SELECT r.awb_normalized AS awb,
              r.charge_type::text,
              ${money2('r.invoiced_amount')} AS invoiced_amount,
              ${money2('r.expected_amount')} AS expected_amount,
              ${money2('r.audited_amount')} AS audited_amount,
              r.flag_awb_not_found,
              r.flag_weight_mismatch,
              r.flag_amount_mismatch,
              r.flag_review,
              r.workflow_state::text,
              ${money2('b.residual')} AS batch_residual,
              b.control_total_state::text
         FROM recon_freight_row r
         JOIN recon_freight_batch b ON b.batch_id = r.batch_id
         LEFT JOIN shipment s ON s.shipment_id = r.shipment_id
         ${w.sql()}
        ORDER BY r.awb_normalized ASC, r.charge_type ASC`,
      w.values(),
    );

    return {
      columns: REPORT_CATALOGUE.RECON_DISPUTES.columns,
      rows: rows.map((r) => [
        r.awb,
        r.charge_type,
        r.invoiced_amount,
        r.expected_amount,
        r.audited_amount,
        String(r.flag_awb_not_found),
        String(r.flag_weight_mismatch),
        String(r.flag_amount_mismatch),
        String(r.flag_review),
        r.workflow_state,
        r.batch_residual,
        r.control_total_state,
      ]),
    };
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') {
      throw new ReportSourceUnavailableError('RECON_DISPUTES', 'recon_freight_row / recon_freight_batch (§2.7)');
    }
    throw err;
  }
};
