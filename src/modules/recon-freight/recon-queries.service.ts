import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { ReconDisputesProvider } from '../dashboard/recon-disputes';
import { OPEN_DISPUTE_STATES } from './recon-freight.types';

/**
 * §9.17.2 read side: batch list/detail, row list with filters, and the
 * dashboard disputes feed. All queries are shop-scoped (INV-1); recon rows
 * carry no shop_id, so every row query joins its batch.
 */

export interface BatchListFilters {
  state?: string;
  courierAccountId?: string;
  limit?: number;
  offset?: number;
}

export interface RowListFilters {
  batchId?: string;
  workflowState?: string;
  chargeType?: string;
  flagAwbNotFound?: boolean;
  flagWeightMismatch?: boolean;
  flagAmountMismatch?: boolean;
  flagReview?: boolean;
  limit?: number;
  offset?: number;
}

@Injectable()
export class ReconQueriesService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async listBatches(shopId: string, filters: BatchListFilters) {
    const params: unknown[] = [shopId];
    const where = ['b.shop_id = $1'];
    if (filters.state) {
      params.push(filters.state);
      where.push(`b.state = $${params.length}`);
    }
    if (filters.courierAccountId) {
      params.push(filters.courierAccountId);
      where.push(`b.courier_account_id = $${params.length}`);
    }
    params.push(filters.limit ?? 50, filters.offset ?? 0);
    const { rows } = await this.pool.query(
      `SELECT b.batch_id, b.courier_account_id, b.batch_reference, b.filename,
              b.tax_treatment, b.invoice_reference, b.invoice_date::text,
              b.declared_invoice_total, b.uploaded_at, b.state::text,
              b.residual, b.control_total_state::text, b.residual_remark,
              b.version,
              (SELECT count(*)::int FROM recon_freight_row r
                WHERE r.batch_id = b.batch_id) AS row_count,
              (SELECT count(*)::int FROM recon_freight_row r
                WHERE r.batch_id = b.batch_id
                  AND r.workflow_state = ANY ($${params.length + 1}::recon_workflow_state[])
              ) AS open_dispute_rows
         FROM recon_freight_batch b
        WHERE ${where.join(' AND ')}
        ORDER BY b.uploaded_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      [...params, OPEN_DISPUTE_STATES],
    );
    return rows;
  }

  async getBatch(shopId: string, batchId: string) {
    const { rows } = await this.pool.query(
      `SELECT b.batch_id, b.courier_account_id, b.batch_reference, b.filename,
              b.content_hash, b.column_map_id, b.tax_treatment,
              b.invoice_reference, b.invoice_date::text, b.declared_invoice_total,
              b.uploaded_by, b.uploaded_at, b.state::text, b.residual,
              b.control_total_state::text, b.residual_remark, b.version,
              (SELECT count(*)::int FROM recon_freight_row r
                WHERE r.batch_id = b.batch_id) AS row_count,
              (SELECT count(*)::int FROM recon_freight_row r
                WHERE r.batch_id = b.batch_id
                  AND (r.flag_awb_not_found OR r.flag_weight_mismatch
                       OR r.flag_amount_mismatch OR r.flag_review)
              ) AS flagged_row_count
         FROM recon_freight_batch b
        WHERE b.batch_id = $1 AND b.shop_id = $2`,
      [batchId, shopId],
    );
    return rows[0] ?? null;
  }

  async listRows(shopId: string, filters: RowListFilters) {
    const params: unknown[] = [shopId];
    const where = ['b.shop_id = $1'];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (filters.batchId) add('r.batch_id = ?', filters.batchId);
    if (filters.workflowState) add('r.workflow_state = ?::recon_workflow_state', filters.workflowState);
    if (filters.chargeType) add('r.charge_type = ?::charge_type', filters.chargeType);
    if (filters.flagAwbNotFound !== undefined) add('r.flag_awb_not_found = ?', filters.flagAwbNotFound);
    if (filters.flagWeightMismatch !== undefined) add('r.flag_weight_mismatch = ?', filters.flagWeightMismatch);
    if (filters.flagAmountMismatch !== undefined) add('r.flag_amount_mismatch = ?', filters.flagAmountMismatch);
    if (filters.flagReview !== undefined) add('r.flag_review = ?', filters.flagReview);
    params.push(filters.limit ?? 100, filters.offset ?? 0);
    const { rows } = await this.pool.query(
      `SELECT r.row_id, r.batch_id, r.awb_normalized, r.charge_type::text,
              r.invoiced_amount, r.invoiced_weight_kg, r.shipper_company,
              r.invoice_reference, r.invoice_date::text, r.shipment_date::text,
              r.origin_station, r.destination_station, r.filename, r.uploaded_at,
              r.remark, r.flag_awb_not_found, r.flag_weight_mismatch,
              r.flag_amount_mismatch, r.flag_review, r.workflow_state::text,
              r.expected_amount, r.audited_amount, r.shipment_id,
              r.adjusts_row_id, r.dispute_evidence_object_key, r.version
         FROM recon_freight_row r
         JOIN recon_freight_batch b ON b.batch_id = r.batch_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.created_at, r.row_id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows;
  }

  /**
   * The §9.10 dashboard disputes card (RW-18): rows in the §3.14 open
   * states plus ONE per control-total MISMATCH batch (§3.28). INV-19 needs
   * no test variant — recon rows never exist for test shipments.
   */
  async openDisputesCount(shopId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT (
          SELECT count(*) FROM recon_freight_row r
           JOIN recon_freight_batch b ON b.batch_id = r.batch_id
          WHERE b.shop_id = $1
            AND r.workflow_state = ANY ($2::recon_workflow_state[])   -- §3.14
        ) + (
          SELECT count(*) FROM recon_freight_batch
          WHERE shop_id = $1 AND control_total_state = 'MISMATCH'     -- §3.28
            AND state <> 'RESOLVED'
        ) AS n`,
      [shopId, OPEN_DISPUTE_STATES],
    );
    return Number(rows[0]?.n ?? '0');
  }
}

/**
 * Dashboard seam (src/modules/dashboard/recon-disputes.ts): implements
 * ReconDisputesProvider over the real tables. The app shell rebinds
 * RECON_DISPUTES_PROVIDER to this class when wiring ReconFreightModule.
 */
@Injectable()
export class ReconDisputesBridge implements ReconDisputesProvider {
  constructor(private readonly queries: ReconQueriesService) {}

  countOpenDisputes(shopId: string): Promise<number> {
    return this.queries.openDisputesCount(shopId);
  }
}
