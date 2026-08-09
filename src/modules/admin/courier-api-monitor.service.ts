import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import {
  TrackingDelayService,
  UnmappedStatusRow,
} from '../tracking/tracking-delay.service';
import { COURIER_API_MONITOR_HOURS } from './admin.constants';

/**
 * §9.13 courier API error monitor: courier_api_call failures aggregated per
 * courier, plus the unmapped-status feed (§3.6) that surfaces raw statuses
 * with no courier_status_map row. Platform-wide, read-only (admin surface);
 * courier_api_call rows are masked summaries by construction (migration 0007,
 * INV-18), so nothing here can leak payloads or credentials.
 */

export interface CourierApiFailureRow {
  courier_code: string;
  method: string;
  outcome: string;
  failures: number;
  shops_affected: number;
  last_seen_at: string;
}

@Injectable()
export class CourierApiMonitorService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly trackingDelay: TrackingDelayService,
  ) {}

  /** Failed / timed-out / circuit-open adapter calls per courier × method. */
  async failuresPerCourier(hours = COURIER_API_MONITOR_HOURS): Promise<CourierApiFailureRow[]> {
    const h = Math.min(Math.max(Math.floor(hours), 1), 720); // ≤ 30 days
    const { rows } = await this.pool.query(
      `SELECT c.code AS courier_code, cac.method, cac.outcome,
              count(*)::int AS failures,
              count(DISTINCT cac.shop_id)::int AS shops_affected,
              max(cac.created_at) AS last_seen_at
         FROM courier_api_call cac
         JOIN courier_account ca ON ca.courier_account_id = cac.courier_account_id
         JOIN courier c ON c.courier_id = ca.courier_id
        WHERE cac.outcome <> 'SUCCESS'
          AND cac.created_at > now() - ($1 || ' hours')::interval
        GROUP BY c.code, cac.method, cac.outcome
        ORDER BY failures DESC, last_seen_at DESC`,
      [String(h)],
    );
    return rows;
  }

  /** §3.6: unmapped raw courier statuses per courier (admin alert feed). */
  async unmappedStatuses(courierId?: string): Promise<UnmappedStatusRow[]> {
    return this.trackingDelay.listUnmappedStatuses(courierId);
  }
}
