import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { NdrCaseState, NdrReason } from './ndr.types';

export interface NdrInboxFilters {
  state?: NdrCaseState;
  reason?: NdrReason;
  /** Aging in whole days from first_ndr_at (§3.10), inclusive bounds. */
  agingMinDays?: number;
  agingMaxDays?: number;
  serviceId?: string;
  courierAccountId?: string;
  /** §9.23 test/live filter — default live-only (is_test = false). */
  isTest?: boolean;
  limit?: number;
  offset?: number;
}

export interface NdrInboxRow {
  ndr_case_id: string;
  shipment_id: string;
  awb_normalized: string | null;
  state: NdrCaseState;
  reason_code: NdrReason;
  attempt_count: number;
  first_ndr_at: string;
  last_ndr_at: string;
  /** §3.10: aging measured from first_ndr_at. */
  aging_hours: number;
  /** S-44: now > auto_rto_warn_at while the case is not CLOSED. */
  auto_rto_warn: boolean;
  service_id: string | null;
  service_name: string | null;
  courier_account_id: string | null;
  is_test: boolean;
}

/**
 * §9.8.1 NDR inbox: attempt count, normalized reason, case state and aging
 * with the auto-RTO warning at S-44. Filters: state, reason, aging, Service,
 * courier account and the §9.23 test/live filter (default live-only).
 * Everything is shop-scoped (INV-1).
 */
@Injectable()
export class NdrInboxService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async inbox(shopId: string, filters: NdrInboxFilters): Promise<NdrInboxRow[]> {
    const where: string[] = ['c.shop_id = $1'];
    const params: unknown[] = [shopId];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };

    if (filters.state) add('c.state = ?::ndr_case_state', filters.state);
    if (filters.reason) add('c.reason_code = ?::ndr_reason', filters.reason);
    if (filters.agingMinDays !== undefined) {
      add("c.first_ndr_at <= now() - (? || ' days')::interval", filters.agingMinDays);
    }
    if (filters.agingMaxDays !== undefined) {
      add("c.first_ndr_at >= now() - (? || ' days')::interval", filters.agingMaxDays);
    }
    if (filters.serviceId) add('s.service_id = ?', filters.serviceId);
    if (filters.courierAccountId) add('s.courier_account_id = ?', filters.courierAccountId);
    // §9.23: default live-only; the merchant can always find test parcels.
    add('s.is_test = ?', filters.isTest ?? false);

    params.push(Math.min(filters.limit ?? 100, 500), filters.offset ?? 0);
    const res = await this.pool.query<NdrInboxRow>(
      `SELECT c.ndr_case_id, c.shipment_id, s.awb_normalized,
              c.state, c.reason_code, c.attempt_count,
              c.first_ndr_at, c.last_ndr_at,
              EXTRACT(EPOCH FROM (now() - c.first_ndr_at)) / 3600.0 AS aging_hours,
              (c.state <> 'CLOSED' AND c.auto_rto_warn_at IS NOT NULL
                AND now() > c.auto_rto_warn_at) AS auto_rto_warn,
              s.service_id, sv.name AS service_name,
              s.courier_account_id, s.is_test
         FROM ndr_case c
         JOIN shipment s ON s.shipment_id = c.shipment_id AND s.shop_id = c.shop_id
         LEFT JOIN service sv ON sv.service_id = s.service_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.first_ndr_at ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return res.rows;
  }
}
