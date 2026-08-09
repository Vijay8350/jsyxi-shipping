import { REPORT_CATALOGUE } from '../report-catalogue';
import { applySharedFilters, applyTestExclusion, money2, Where } from '../report-filters';
import {
  ReportData,
  ReportGenerator,
  ReportSourceUnavailableError,
} from '../reports.types';

interface CodPendingRow {
  awb: string | null;
  expected_amount: string | null;
  allocated_amount: string | null;
  balance: string | null;
  due_date: string | null;
  aging_days: string;
  state: string;
}

/**
 * §11 COD_PENDING — COD pending remittance. Grain: recon_cod_expected (§2.7).
 * Expected / allocated (Σ §2.7 recon_cod_allocation, only batches uploaded by
 * the as-of) / balance; due date is F-21 (due_at, a date per §5.2); aging
 * days are calendar days since due_at at the as-of (F-21); state is §3.15.
 *
 * Like RECON_DISPUTES, the recon tables land in weeks 14–15: the SQL targets
 * the §2.7 column names and a missing table surfaces as the typed
 * ReportSourceUnavailableError (PostgreSQL 42P01) → FAILED job.
 */
export const generateCodPending: ReportGenerator = async (q, ctx): Promise<ReportData> => {
  const w = new Where();
  w.add(`e.shop_id = ${w.param(ctx.shopId)}::uuid`);
  // The expectation exists only after delivery (§9.17.3, INV-19: never test).
  w.add(`e.delivered_at <= ${w.param(ctx.asOf.toISOString())}::timestamptz`);
  if (ctx.filters.dateFrom) w.add(`e.due_at >= ${w.param(ctx.filters.dateFrom)}::date`);
  if (ctx.filters.dateTo) w.add(`e.due_at <= ${w.param(ctx.filters.dateTo)}::date`);
  applySharedFilters(w, ctx.filters, { status: 'e.state' });
  applyTestExclusion(w, 'COALESCE(s.is_test, false)', ctx.filters.includeTest);
  const asOf = w.param(ctx.asOf.toISOString());

  try {
    const { rows } = await q.query<CodPendingRow>(
      `SELECT s.awb_normalized AS awb,
              ${money2('e.expected_amount')} AS expected_amount,
              ${money2('alloc.allocated_amount')} AS allocated_amount,
              ${money2('e.expected_amount - COALESCE(alloc.allocated_amount, 0)')} AS balance,
              e.due_at::text AS due_date,
              GREATEST(0, (${asOf}::timestamptz)::date - e.due_at)::text AS aging_days,
              e.state::text
         FROM recon_cod_expected e
         LEFT JOIN shipment s ON s.shipment_id = e.shipment_id
         LEFT JOIN LATERAL (
           SELECT sum(a.amount) AS allocated_amount
             FROM recon_cod_allocation a
             JOIN recon_cod_batch cb ON cb.cod_batch_id = a.cod_batch_id
            WHERE a.expected_id = e.expected_id
              AND cb.uploaded_at <= ${asOf}::timestamptz
         ) alloc ON true
         ${w.sql()}
        ORDER BY e.due_at ASC`,
      w.values(),
    );

    return {
      columns: REPORT_CATALOGUE.COD_PENDING.columns,
      rows: rows.map((r) => [
        r.awb,
        r.expected_amount,
        r.allocated_amount ?? '0.00',
        r.balance,
        r.due_date,
        r.aging_days,
        r.state,
      ]),
    };
  } catch (err) {
    if ((err as { code?: string }).code === '42P01') {
      throw new ReportSourceUnavailableError(
        'COD_PENDING',
        'recon_cod_expected / recon_cod_allocation / recon_cod_batch (§2.7)',
      );
    }
    throw err;
  }
};
