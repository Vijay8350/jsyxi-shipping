import { REPORT_CATALOGUE } from '../report-catalogue';
import {
  applyAttributionFrame,
  applySharedFilters,
  applyTestExclusion,
  money2,
  Where,
} from '../report-filters';
import { ReportData, ReportGenerator } from '../reports.types';

interface RtoRow {
  awb: string | null;
  rto_initiated_at: string | null;
  reason: string | null;
  rto_charge: string | null;
  rto_delivered_at: string | null;
}

/**
 * §11 RTO — shipments in RTO. Grain: Shipments; attribution:
 * RTO-initiated-at (§5.2), the first RTO_INITIATED tracking event.
 *
 * rto_charge is F-12 (§4.4), computed from the frozen booking snapshot
 * (INV-10), never current rate data:
 *  - RATE_CARD: the snapshot's rate card version gives rto_basis / rto_pct /
 *    fuel_pct / gst_pct; the base is the snapshot's F-5 component; fuel and
 *    GST apply on the same terms as forward (A2-10), rounded half-up per
 *    component (INV-15 — NUMERIC ROUND is half-up). PERCENT_OF_BASE_FREIGHT
 *    F-8 components are not re-derived here; the recon engine (§4.8) is the
 *    exact F-12 authority when it lands.
 *  - LIVE_QUOTE: the snapshot quote's rto_rule, interpreted identically on
 *    the snapshot's F-5 component (§4.4).
 *  - No rto_rule / no quote → NULL: there is no RTO expectation (§4.4).
 */
const F5_COMPONENT = `(
  SELECT NULLIF(c ->> 'amount', '')::numeric
    FROM jsonb_array_elements(s.snapshot -> 'expectedQuote' -> 'components') c
   WHERE c ->> 'code' = 'F-5'
   LIMIT 1
)`;

const RTO_BASE = `CASE
  WHEN COALESCE(rcv.rto_basis::text, s.snapshot -> 'expectedQuote' -> 'rtoRule' ->> 'basis') = 'PERCENT_OF_FORWARD'
    THEN ROUND(${F5_COMPONENT} * COALESCE(rcv.rto_pct,
           NULLIF(s.snapshot -> 'expectedQuote' -> 'rtoRule' ->> 'pct', '')::numeric), 2)
  ELSE ${F5_COMPONENT}
END`;

const RTO_CHARGE = `CASE
  WHEN ${F5_COMPONENT} IS NULL THEN NULL
  WHEN rcv.rto_basis IS NULL AND s.snapshot -> 'expectedQuote' -> 'rtoRule' IS NULL THEN NULL
  WHEN rcv.rto_basis IS NULL
    THEN ${RTO_BASE}  -- LIVE_QUOTE: provider rule, no versioned fuel/GST split
  ELSE (${RTO_BASE} + ROUND(${RTO_BASE} * rcv.fuel_pct, 2))
       + ROUND((${RTO_BASE} + ROUND(${RTO_BASE} * rcv.fuel_pct, 2)) * rcv.gst_pct, 2)
END`;

export const generateRto: ReportGenerator = async (q, ctx): Promise<ReportData> => {
  const w = new Where();
  w.add(`s.shop_id = ${w.param(ctx.shopId)}::uuid`);
  w.add(`ri.rto_initiated_at IS NOT NULL`);
  applyTestExclusion(w, 's.is_test', ctx.filters.includeTest);
  applyAttributionFrame(w, 'ri.rto_initiated_at', ctx.filters, ctx.timezone, ctx.asOf);
  applySharedFilters(w, ctx.filters, {
    serviceId: 's.service_id',
    courierAccountId: 's.courier_account_id',
    status: 's.movement_state',
  });
  const asOf = w.param(ctx.asOf.toISOString());

  const { rows } = await q.query<RtoRow>(
    `SELECT s.awb_normalized AS awb,
            ri.rto_initiated_at::text,
            ri.reason,
            ${money2(RTO_CHARGE)} AS rto_charge,
            rd.rto_delivered_at::text
       FROM shipment s
       LEFT JOIN rate_card_version rcv
         ON rcv.rate_card_version_id = NULLIF(s.snapshot ->> 'rateCardVersionId', '')::uuid
       JOIN LATERAL (
         SELECT min(te.occurred_at) AS rto_initiated_at,
                (SELECT te2.reason_text FROM tracking_event te2
                  WHERE te2.shipment_id = s.shipment_id
                    AND te2.carrier_event_status = 'RTO_INITIATED'
                    AND te2.occurred_at <= ${asOf}::timestamptz
                  ORDER BY te2.occurred_at ASC LIMIT 1) AS reason
           FROM tracking_event te
          WHERE te.shipment_id = s.shipment_id
            AND te.carrier_event_status = 'RTO_INITIATED'
            AND te.occurred_at <= ${asOf}::timestamptz
       ) ri ON true
       LEFT JOIN LATERAL (
         SELECT max(te.occurred_at) AS rto_delivered_at
           FROM tracking_event te
          WHERE te.shipment_id = s.shipment_id
            AND te.carrier_event_status = 'RTO_DELIVERED'
            AND te.occurred_at <= ${asOf}::timestamptz
       ) rd ON true
       ${w.sql()}
      ORDER BY ri.rto_initiated_at ASC`,
    w.values(),
  );

  return {
    columns: REPORT_CATALOGUE.RTO.columns,
    rows: rows.map((r) => [r.awb, r.rto_initiated_at, r.reason, r.rto_charge, r.rto_delivered_at]),
  };
};
