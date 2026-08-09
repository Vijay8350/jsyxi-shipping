import { Inject, Injectable } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { paiseToRupees, rupeesToPaise } from '../../common/money';
import { agingDays, localDateString, DEFAULT_TIMEZONE } from './cod-state';
import type { CodBatchState, CodExpectedState, UnmatchedItem } from './recon-cod.types';

export interface ExpectationFilters {
  state?: CodExpectedState;
  courierAccountId?: string;
  /** Only expectations at least this many calendar days past due (F-21). */
  minAgingDays?: number;
  dueFrom?: string; // 'YYYY-MM-DD'
  dueTo?: string; // 'YYYY-MM-DD'
  page?: number;
  pageSize?: number;
}

/** §11 COD_PENDING report shape: expected, allocated, balance, due, aging, state. */
export interface ExpectationView {
  expectedId: string;
  shipmentId: string;
  awb: string | null;
  courierAccountId: string | null;
  expected: string;
  allocated: string;
  /** Expected − allocated (the remittance shortfall; NOT a held balance — INV-23). */
  balance: string;
  deliveredAt: string;
  dueAt: string;
  agingDays: number;
  state: CodExpectedState;
}

export interface BatchView {
  batchId: string;
  batchReference: string;
  courierAccountId: string;
  filename: string;
  remittanceReference: string | null;
  remittanceDate: string | null;
  declaredTotal: string | null;
  state: CodBatchState;
  matchedCount: number;
  unmatchedCount: number;
  uploadedAt: string;
}

export interface BatchDetailView extends BatchView {
  /** INV-20: unmatched / invalid rows, surfaced for review. */
  unmatched: UnmatchedItem[];
}

const BATCH_COLS = `cod_batch_id, batch_reference, courier_account_id, filename,
  remittance_reference, remittance_date::text, declared_total::text, state,
  COALESCE(matched_count, 0)::int AS matched_count,
  COALESCE(unmatched_count, 0)::int AS unmatched_count,
  COALESCE(unmatched_json, '[]'::jsonb) AS unmatched_json, uploaded_at`;

type BatchDbRow = {
  cod_batch_id: string;
  batch_reference: string;
  courier_account_id: string;
  filename: string;
  remittance_reference: string | null;
  remittance_date: string | null;
  declared_total: string | null;
  state: CodBatchState;
  matched_count: number;
  unmatched_count: number;
  unmatched_json: UnmatchedItem[];
  uploaded_at: string;
};

function toBatchView(r: BatchDbRow): BatchView {
  return {
    batchId: r.cod_batch_id,
    batchReference: r.batch_reference,
    courierAccountId: r.courier_account_id,
    filename: r.filename,
    remittanceReference: r.remittance_reference,
    remittanceDate: r.remittance_date,
    declaredTotal: r.declared_total,
    state: r.state,
    matchedCount: r.matched_count,
    unmatchedCount: r.unmatched_count,
    uploadedAt: r.uploaded_at,
  };
}

/**
 * Read side of §9.17.3 (Finance+/Viewer per §10.2). Feeds the §11
 * COD_PENDING report. Every query is shop-scoped (INV-1).
 */
@Injectable()
export class CodQueryService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  private async shopTimezone(shopId: string): Promise<string> {
    const res = await this.pool.query<{ timezone: string }>(
      `SELECT timezone FROM store_settings WHERE shop_id = $1`,
      [shopId],
    );
    return res.rows[0]?.timezone ?? DEFAULT_TIMEZONE;
  }

  async listExpectations(
    shopId: string,
    filters: ExpectationFilters,
  ): Promise<{ items: ExpectationView[]; total: number }> {
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));
    const params: unknown[] = [shopId];
    let where = `e.shop_id = $1`;
    if (filters.state) {
      params.push(filters.state);
      where += ` AND e.state = $${params.length}`;
    }
    if (filters.courierAccountId) {
      params.push(filters.courierAccountId);
      where += ` AND s.courier_account_id = $${params.length}`;
    }
    if (filters.dueFrom) {
      params.push(filters.dueFrom);
      where += ` AND e.due_at >= $${params.length}::date`;
    }
    if (filters.dueTo) {
      params.push(filters.dueTo);
      where += ` AND e.due_at <= $${params.length}::date`;
    }

    const timeZone = await this.shopTimezone(shopId);
    const todayLocal = localDateString(new Date(), timeZone);

    const res = await this.pool.query<{
      expected_id: string;
      shipment_id: string;
      awb: string | null;
      courier_account_id: string | null;
      expected_amount: string;
      allocated: string;
      delivered_at: string;
      due_at: string;
      state: CodExpectedState;
      total: number;
    }>(
      `SELECT e.expected_id, e.shipment_id, s.awb_normalized AS awb,
              s.courier_account_id, e.expected_amount::text,
              COALESCE(a.allocated, 0)::text AS allocated,
              e.delivered_at, e.due_at::text, e.state,
              count(*) OVER ()::int AS total
         FROM recon_cod_expected e
         JOIN shipment s ON s.shipment_id = e.shipment_id AND s.shop_id = e.shop_id
         LEFT JOIN (
           SELECT expected_id, SUM(amount) AS allocated
             FROM recon_cod_allocation GROUP BY expected_id
         ) a ON a.expected_id = e.expected_id
        WHERE ${where}
        ORDER BY e.due_at ASC, e.created_at ASC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    );

    let items = res.rows.map((r): ExpectationView => {
      const expected = rupeesToPaise(r.expected_amount);
      const allocated = rupeesToPaise(r.allocated);
      return {
        expectedId: r.expected_id,
        shipmentId: r.shipment_id,
        awb: r.awb,
        courierAccountId: r.courier_account_id,
        expected: paiseToRupees(expected),
        allocated: paiseToRupees(allocated),
        balance: paiseToRupees(expected - allocated),
        deliveredAt: r.delivered_at,
        dueAt: r.due_at.slice(0, 10),
        agingDays: agingDays(r.due_at.slice(0, 10), todayLocal),
        state: r.state,
      };
    });
    if (filters.minAgingDays != null) {
      items = items.filter((i) => i.agingDays >= filters.minAgingDays!);
    }
    return { items, total: res.rows[0]?.total ?? 0 };
  }

  async listBatches(
    shopId: string,
    filters: { state?: CodBatchState; page?: number; pageSize?: number },
  ): Promise<{ items: BatchView[]; total: number }> {
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));
    const params: unknown[] = [shopId];
    let where = `shop_id = $1`;
    if (filters.state) {
      params.push(filters.state);
      where += ` AND state = $${params.length}`;
    }
    const res = await this.pool.query<BatchDbRow & { total: number }>(
      `SELECT ${BATCH_COLS}, count(*) OVER ()::int AS total
         FROM recon_cod_batch
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    );
    return { items: res.rows.map(toBatchView), total: res.rows[0]?.total ?? 0 };
  }

  async getBatch(shopId: string, batchId: string): Promise<BatchDetailView> {
    const res = await this.pool.query<BatchDbRow>(
      `SELECT ${BATCH_COLS} FROM recon_cod_batch
        WHERE shop_id = $1 AND cod_batch_id = $2`,
      [shopId, batchId],
    );
    const row = res.rows[0];
    if (!row) throw new NotFoundException('batch not found');
    return { ...toBatchView(row), unmatched: row.unmatched_json ?? [] };
  }

  /** Counts by §3.15 state — every state present, zero-filled. */
  async summary(shopId: string): Promise<Record<CodExpectedState, number>> {
    const res = await this.pool.query<{ state: CodExpectedState; n: number }>(
      `SELECT state, count(*)::int AS n
         FROM recon_cod_expected WHERE shop_id = $1 GROUP BY state`,
      [shopId],
    );
    const out: Record<CodExpectedState, number> = {
      AWAITING: 0,
      TALLIED: 0,
      SHORT: 0,
      EXCESS: 0,
      PENDING_OVERDUE: 0,
      RTO_UNCOLLECTED: 0,
    };
    for (const r of res.rows) out[r.state] = r.n;
    return out;
  }
}
