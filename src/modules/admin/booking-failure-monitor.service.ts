import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import {
  BOOKING_FAILURE_SPIKE_HOURS,
  BOOKING_FAILURE_WINDOW_MINUTES,
} from './admin.constants';

/**
 * ADD-32 booking failure monitor (§9.13 extension): booking failures grouped
 * by reason code across ALL merchants, platform-wide and read-only, so a
 * spike in one reason on one courier is visible within minutes.
 *
 * Sources (per the ADD-32 definition):
 *   - booking_intent outcome FAILED / UNKNOWN, joined to shipment for the
 *     Shop and courier account (reason code = the outcome);
 *   - shipment booking_state FAILED (reason code 'BOOKING_FAILED');
 *   - shipment manual_assignment_reason distribution while
 *     NEEDS_MANUAL_ASSIGNMENT (§3.30 reason codes).
 * Test shipments are excluded everywhere (INV-19).
 */

export interface BookingFailureRow {
  source: 'BOOKING_INTENT' | 'SHIPMENT_FAILED' | 'MANUAL_ASSIGNMENT';
  reason_code: string;
  courier_code: string | null;
  failures: number;
  shops_affected: number;
  last_seen_at: string;
}

export interface BookingFailureSpikeRow {
  hour_start_utc: string;
  courier_code: string | null;
  reason_code: string;
  failures: number;
}

@Injectable()
export class BookingFailureMonitorService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Failures grouped by reason code × courier within a recent window. */
  async failuresByReason(windowMinutes = BOOKING_FAILURE_WINDOW_MINUTES): Promise<BookingFailureRow[]> {
    const minutes = Math.min(Math.max(Math.floor(windowMinutes), 1), 10080); // ≤ 7 days
    const { rows } = await this.pool.query(
      `SELECT * FROM (
         -- booking_intent outcome FAILED / UNKNOWN (§3.23), via shipment for
         -- shop + courier account. Composite FK: (shipment_id, created_at).
         SELECT 'BOOKING_INTENT'::text AS source,
                bi.outcome::text AS reason_code,
                c.code AS courier_code,
                count(*)::int AS failures,
                count(DISTINCT s.shop_id)::int AS shops_affected,
                max(bi.created_at) AS last_seen_at
           FROM booking_intent bi
           JOIN shipment s
             ON s.shipment_id = bi.shipment_id AND s.created_at = bi.shipment_created_at
           LEFT JOIN courier_account ca ON ca.courier_account_id = s.courier_account_id
           LEFT JOIN courier c ON c.courier_id = ca.courier_id
          WHERE bi.outcome IN ('FAILED', 'UNKNOWN')
            AND bi.created_at > now() - ($1 || ' minutes')::interval
            AND s.is_test = false
          GROUP BY bi.outcome, c.code
         UNION ALL
         -- shipment booking_state FAILED (§3.2), no finer reason stored.
         SELECT 'SHIPMENT_FAILED'::text,
                'BOOKING_FAILED'::text,
                c.code,
                count(*)::int,
                count(DISTINCT s.shop_id)::int,
                max(s.updated_at)
           FROM shipment s
           LEFT JOIN courier_account ca ON ca.courier_account_id = s.courier_account_id
           LEFT JOIN courier c ON c.courier_id = ca.courier_id
          WHERE s.booking_state = 'FAILED'
            AND s.updated_at > now() - ($1 || ' minutes')::interval
            AND s.is_test = false
          GROUP BY c.code
         UNION ALL
         -- §3.30 manual_assignment_reason distribution.
         SELECT 'MANUAL_ASSIGNMENT'::text,
                s.manual_assignment_reason::text,
                c.code,
                count(*)::int,
                count(DISTINCT s.shop_id)::int,
                max(s.updated_at)
           FROM shipment s
           LEFT JOIN courier_account ca ON ca.courier_account_id = s.courier_account_id
           LEFT JOIN courier c ON c.courier_id = ca.courier_id
          WHERE s.booking_state = 'NEEDS_MANUAL_ASSIGNMENT'
            AND s.manual_assignment_reason IS NOT NULL
            AND s.updated_at > now() - ($1 || ' minutes')::interval
            AND s.is_test = false
          GROUP BY s.manual_assignment_reason, c.code
       ) failures
       ORDER BY failures DESC, last_seen_at DESC`,
      [String(minutes)],
    );
    return rows;
  }

  /** Spike view: count by reason × courier by hour for the last N hours. */
  async spikeView(hours = BOOKING_FAILURE_SPIKE_HOURS): Promise<BookingFailureSpikeRow[]> {
    const h = Math.min(Math.max(Math.floor(hours), 1), 168); // ≤ 7 days
    const { rows } = await this.pool.query(
      `SELECT hour_start_utc, courier_code, reason_code, count(*)::int AS failures
         FROM (
           SELECT date_trunc('hour', bi.created_at) AS hour_start_utc,
                  c.code AS courier_code,
                  bi.outcome::text AS reason_code
             FROM booking_intent bi
             JOIN shipment s
               ON s.shipment_id = bi.shipment_id AND s.created_at = bi.shipment_created_at
             LEFT JOIN courier_account ca ON ca.courier_account_id = s.courier_account_id
             LEFT JOIN courier c ON c.courier_id = ca.courier_id
            WHERE bi.outcome IN ('FAILED', 'UNKNOWN')
              AND bi.created_at > now() - ($1 || ' hours')::interval
              AND s.is_test = false
           UNION ALL
           SELECT date_trunc('hour', s.updated_at),
                  c.code,
                  s.manual_assignment_reason::text
             FROM shipment s
             LEFT JOIN courier_account ca ON ca.courier_account_id = s.courier_account_id
             LEFT JOIN courier c ON c.courier_id = ca.courier_id
            WHERE s.booking_state = 'NEEDS_MANUAL_ASSIGNMENT'
              AND s.manual_assignment_reason IS NOT NULL
              AND s.updated_at > now() - ($1 || ' hours')::interval
              AND s.is_test = false
         ) per_event
        GROUP BY hour_start_utc, courier_code, reason_code
        ORDER BY hour_start_utc DESC, failures DESC`,
      [String(h)],
    );
    return rows;
  }
}
