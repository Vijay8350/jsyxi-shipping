import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';

export type NdrBreakdown = 'service' | 'pincode' | 'reason';
export type RtoBreakdown = 'service' | 'pincode';

export interface NdrRateRow {
  key: string;
  /** Shipments with ≥1 NDR (F-16.b numerator). */
  ndrShipments: number;
  /** Picked-up shipments in the cohort (F-16.b denominator). */
  pickedUpShipments: number;
  /** F-16.b: ndrShipments ÷ pickedUpShipments (null when denominator 0). */
  ndrRate: number | null;
}

export interface RtoRateRow {
  key: string;
  /** RTO Delivered (F-16.c numerator). */
  rtoDelivered: number;
  /** Terminal shipments (F-16.c denominator). */
  terminalShipments: number;
  /** F-16.c: rtoDelivered ÷ terminalShipments (null when denominator 0). */
  rtoRate: number | null;
}

/**
 * §9.8.3 NDR analytics: NDR and RTO breakdowns by Service, pincode and
 * reason, using the F-16.b / F-16.c definitions exactly. Test shipments are
 * excluded everywhere (INV-19). The cohort is shipments booked in the
 * period; "picked up" is evidenced by a PICKED_UP tracking event. The
 * pincode dimension reads the stored recipient snapshot.
 *
 * For the reason breakdown the numerator splits by the case's normalized
 * §3.10 reason while the denominator stays the whole picked-up cohort — a
 * per-reason denominator does not exist, so reason rates read "share of
 * picked-up shipments whose NDR carried this reason".
 */
@Injectable()
export class NdrAnalyticsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** F-16.b NDR rate = shipments with ≥1 NDR ÷ picked-up shipments. */
  async ndrRates(
    shopId: string,
    range: { from: string; to: string },
    breakdown: NdrBreakdown,
  ): Promise<NdrRateRow[]> {
    if (breakdown === 'reason') {
      const res = await this.pool.query<{
        key: string;
        ndr_shipments: string;
        picked_up_shipments: string;
      }>(
        `WITH cohort AS (${COHORT_SQL})
         SELECT nc.reason_code::text AS key,
                COUNT(DISTINCT nc.shipment_id) AS ndr_shipments,
                (SELECT COUNT(*) FROM cohort) AS picked_up_shipments
           FROM ndr_case nc
           JOIN cohort c ON c.shipment_id = nc.shipment_id
          WHERE nc.shop_id = $1
          GROUP BY 1
          ORDER BY 1`,
        [shopId, range.from, range.to],
      );
      return res.rows.map((r) => toNdrRateRow(r.key, r.ndr_shipments, r.picked_up_shipments));
    }

    const keyExpr =
      breakdown === 'service'
        ? "COALESCE(c.service_name, '(unassigned)')"
        : "COALESCE(c.pincode, '(unknown)')";
    const res = await this.pool.query<{
      key: string;
      ndr_shipments: string;
      picked_up_shipments: string;
    }>(
      `WITH cohort AS (${COHORT_SQL})
       SELECT ${keyExpr} AS key,
              COUNT(*) FILTER (WHERE n.shipment_id IS NOT NULL) AS ndr_shipments,
              COUNT(*) AS picked_up_shipments
         FROM cohort c
         LEFT JOIN (
           SELECT DISTINCT shipment_id FROM ndr_case WHERE shop_id = $1
         ) n ON n.shipment_id = c.shipment_id
        GROUP BY 1
        ORDER BY 1`,
      [shopId, range.from, range.to],
    );
    return res.rows.map((r) => toNdrRateRow(r.key, r.ndr_shipments, r.picked_up_shipments));
  }

  /** F-16.c RTO rate = RTO Delivered ÷ terminal shipments. */
  async rtoRates(
    shopId: string,
    range: { from: string; to: string },
    breakdown: RtoBreakdown,
  ): Promise<RtoRateRow[]> {
    const keyExpr =
      breakdown === 'service'
        ? "COALESCE(sv.name, '(unassigned)')"
        : "COALESCE(o.recipient_snapshot->>'pincode', '(unknown)')";
    const res = await this.pool.query<{
      key: string;
      rto_delivered: string;
      terminal_shipments: string;
    }>(
      `SELECT ${keyExpr} AS key,
              COUNT(*) FILTER (WHERE s.movement_state = 'RTO_DELIVERED') AS rto_delivered,
              COUNT(*) AS terminal_shipments
         FROM shipment s
         JOIN "order" o ON o.order_id = s.order_id AND o.shop_id = s.shop_id
         LEFT JOIN service sv ON sv.service_id = s.service_id
        WHERE s.shop_id = $1
          AND s.is_test = false                                    -- INV-19
          AND s.booked_at >= $2::timestamptz
          AND s.booked_at <  $3::timestamptz
          AND s.movement_state IN
              ('DELIVERED', 'RTO_DELIVERED', 'LOST_OR_DAMAGED', 'CANCELLED_BY_COURIER')
        GROUP BY 1
        ORDER BY 1`,
      [shopId, range.from, range.to],
    );
    return res.rows.map((r) => {
      const rto = Number(r.rto_delivered);
      const terminal = Number(r.terminal_shipments);
      return {
        key: r.key,
        rtoDelivered: rto,
        terminalShipments: terminal,
        rtoRate: terminal > 0 ? rto / terminal : null,
      };
    });
  }
}

/** Booked-in-period, picked-up, non-test shipments with the two dimensions. */
const COHORT_SQL = `
  SELECT s.shipment_id, sv.name AS service_name,
         o.recipient_snapshot->>'pincode' AS pincode
    FROM shipment s
    JOIN "order" o ON o.order_id = s.order_id AND o.shop_id = s.shop_id
    LEFT JOIN service sv ON sv.service_id = s.service_id
   WHERE s.shop_id = $1
     AND s.is_test = false                                        -- INV-19
     AND s.booked_at >= $2::timestamptz
     AND s.booked_at <  $3::timestamptz
     AND EXISTS (
           SELECT 1 FROM tracking_event te
            WHERE te.shop_id = $1 AND te.shipment_id = s.shipment_id
              AND te.carrier_event_status = 'PICKED_UP')`;

function toNdrRateRow(key: string, ndr: string, pickedUp: string): NdrRateRow {
  const ndrN = Number(ndr);
  const pickedUpN = Number(pickedUp);
  return {
    key,
    ndrShipments: ndrN,
    pickedUpShipments: pickedUpN,
    ndrRate: pickedUpN > 0 ? ndrN / pickedUpN : null,
  };
}
