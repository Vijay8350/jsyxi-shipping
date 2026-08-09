import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';

/**
 * §9.7 read models: the S-47 delayed-shipment flag and the §3.6/§9.13
 * unmapped-status monitor feed. Pure queries over existing tables — no new
 * columns (the tracking block adds no migration).
 */

/** S-47: EDD exceeded by more than 24 hours (RW-06). */
export const DELAY_THRESHOLD_MS = 24 * 3600_000;

export interface DelayedShipment {
  shipment_id: string;
  order_id: string;
  awb_normalized: string | null;
  movement_state: string;
  /** The frozen quote's EDD upper bound (snapshot, INV-8 — never current data). */
  edd_to: string;
  booked_at: string | null;
}

export interface UnmappedStatusRow {
  courier_code: string;
  raw_status: string;
  occurrences: number;
  shops_affected: number;
  last_seen_at: string;
}

@Injectable()
export class TrackingDelayService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * S-47 / §9.7: a shipment is delayed when the snapshot quote's EDD
   * (edd_to) is exceeded by more than 24 hours and movement is non-terminal.
   * The §9.10 dashboard delayed card reads this. Shop-scoped (INV-1); test
   * shipments excluded (INV-19). EDD comes from the frozen snapshot (INV-8).
   */
  async listDelayed(shopId: string, now = new Date()): Promise<DelayedShipment[]> {
    const cutoff = new Date(now.getTime() - DELAY_THRESHOLD_MS).toISOString();
    const { rows } = await this.pool.query<DelayedShipment>(
      `SELECT s.shipment_id, s.order_id, s.awb_normalized, s.movement_state,
              s.snapshot -> 'quote' ->> 'eddTo' AS edd_to,
              s.booked_at
         FROM shipment s
        WHERE s.shop_id = $1
          AND s.is_test = false
          AND s.booking_state = 'CONFIRMED'
          AND s.movement_state NOT IN
                ('DELIVERED', 'RTO_DELIVERED', 'LOST_OR_DAMAGED', 'CANCELLED_BY_COURIER')
          AND s.snapshot -> 'quote' ->> 'eddTo' IS NOT NULL
          AND (s.snapshot -> 'quote' ->> 'eddTo')::timestamptz < $2::timestamptz
        ORDER BY (s.snapshot -> 'quote' ->> 'eddTo')::timestamptz ASC`,
      [shopId, cutoff],
    );
    return rows;
  }

  /**
   * §3.6 / §9.13 courier API error monitor: raw statuses with no
   * courier_status_map row, grouped per courier — this is what turns an
   * unmapped status into an admin-visible alert. Platform-wide (admin
   * surface); the merchant-scoped views filter by shop downstream.
   */
  async listUnmappedStatuses(courierId?: string): Promise<UnmappedStatusRow[]> {
    const { rows } = await this.pool.query<UnmappedStatusRow>(
      `SELECT c.code AS courier_code, te.raw_status,
              count(*)::int AS occurrences,
              count(DISTINCT te.shop_id)::int AS shops_affected,
              max(te.received_at) AS last_seen_at
         FROM tracking_event te
         JOIN shipment s ON s.shipment_id = te.shipment_id
         JOIN courier_account ca ON ca.courier_account_id = s.courier_account_id
         JOIN courier c ON c.courier_id = ca.courier_id
        WHERE te.carrier_event_status IS NULL
          AND ($1::uuid IS NULL OR c.courier_id = $1)
        GROUP BY c.code, te.raw_status
        ORDER BY occurrences DESC, last_seen_at DESC`,
      [courierId ?? null],
    );
    return rows;
  }
}
