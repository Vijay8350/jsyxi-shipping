import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { TrackingDelayService } from '../tracking/tracking-delay.service';
import {
  RECON_DISPUTES_PROVIDER,
  ReconDisputesProvider,
} from './recon-disputes';
import {
  CohortMetrics,
  DashboardCardKey,
  DeliveryMetrics,
  RollupDimension,
  RollupMetrics,
  RollupRow,
} from './dashboard.types';

/**
 * The §5.7 hourly rollup writer for `rollup_hourly_stats` (§2.8, migration
 * 0014). All dashboard figures (§9.10) and report inputs are maintained
 * here — render time never touches the base tables (§5.7).
 *
 * Two families of rows:
 *
 *  - SNAPSHOT rows (kinds card / by_* / service_movement): counts of the
 *    current stored conditions (RV-03 — every §9.10 card condition is a
 *    stored column), recomputed wholesale and stamped with the current
 *    hour. The dashboard reads the latest hour's snapshot rows.
 *  - EVENT/COHORT rows (kinds f16_*): attributed to the hour §5.2 assigns
 *    them — booked cohort → booked hour; NDR → first-NDR hour; TAT and
 *    delivery → DELIVERED occurred-at hour. Cohort rows are restated by
 *    `restateWindow` as deliveries land on older cohorts (§5.2: later
 *    corrections restate live dashboards).
 *
 * INV-19 both directions: every query groups by the test flag and writes a
 * live (test=false) and a test (test=true) side separately, so no live
 * figure ever contains a test shipment and the §9.23 test filter has its
 * own explicit side. All queries are shop-scoped (INV-1) and parameterized.
 *
 * This service is a plain injectable — the BullMQ worker in rollup-queue.ts
 * is a thin shell over runHourlySweep, so all of this is unit-testable
 * without Redis.
 */

/** How far back the hourly sweep restates booked cohorts (deliveries and
 *  RTOs keep landing on older cohorts; 45 days covers the slow tail). */
export const COHORT_RESTATEMENT_DAYS = 45;

interface CountRow {
  t: boolean;
  count: number | string;
}

interface GroupedCountRow extends CountRow {
  key: string | null;
}

@Injectable()
export class RollupService {
  private readonly logger = new Logger(RollupService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly delay: TrackingDelayService,
    @Inject(RECON_DISPUTES_PROVIDER)
    private readonly reconDisputes: ReconDisputesProvider,
  ) {}

  /**
   * Compute and UPSERT every rollup row stamped `hourStartUtc` for one
   * shop: the snapshot families (as of `now`) plus the cohort and event
   * rows attributed to [hourStartUtc, hourStartUtc+1h). Idempotent — the
   * UPSERT keys on (shop_id, hour_start_utc, dimension_json).
   */
  async computeHourRollup(
    shopId: string,
    hourStartUtc: Date,
    now: Date = new Date(),
  ): Promise<number> {
    const hourEnd = new Date(hourStartUtc.getTime() + 3600_000);
    const rows: RollupRow[] = [];

    rows.push(...(await this.snapshotCardRows(shopId, hourStartUtc, now)));
    rows.push(...(await this.snapshotDistributionRows(shopId, hourStartUtc)));
    rows.push(...(await this.cohortRows(shopId, hourStartUtc, hourEnd)));
    rows.push(...(await this.ndrRows(shopId, hourStartUtc, hourEnd)));
    rows.push(...(await this.pickupRows(shopId, hourStartUtc, hourEnd)));
    rows.push(...(await this.deliveryRows(shopId, hourStartUtc, hourEnd)));

    await this.upsert(shopId, rows, now);
    return rows.length;
  }

  /**
   * Restate the event/cohort families over [fromUtc, toUtc): deliveries
   * landing today update the booked-cohort rows of older hours (F-16.a/c
   * are booked-cohort metrics, §4.10), and late-ingested tracking events
   * backfill their occurred-at hours (§5.2 restatement). Snapshot families
   * are not restated — they describe "now", computed by computeHourRollup.
   */
  async restateWindow(shopId: string, fromUtc: Date, toUtc: Date): Promise<number> {
    const rows: RollupRow[] = [
      ...(await this.cohortRows(shopId, fromUtc, toUtc)),
      ...(await this.ndrRows(shopId, fromUtc, toUtc)),
      ...(await this.pickupRows(shopId, fromUtc, toUtc)),
      ...(await this.deliveryRows(shopId, fromUtc, toUtc)),
    ];
    await this.upsert(shopId, rows, new Date());
    return rows.length;
  }

  /**
   * The plain-injectable body of the hourly repeatable job: for every shop,
   * compute the current hour's snapshot + event rows and restate the
   * trailing cohort window. Per-shop failures are logged (internal IDs
   * only — §5.7 control 4) and never stop the sweep.
   */
  async runHourlySweep(now: Date = new Date()): Promise<{ shops: number; failed: number }> {
    const { rows: shops } = await this.pool.query<{ shop_id: string }>(
      `SELECT shop_id FROM shop`,
    );
    const hourStart = new Date(Math.floor(now.getTime() / 3600_000) * 3600_000);
    const restateFrom = new Date(
      hourStart.getTime() - COHORT_RESTATEMENT_DAYS * 24 * 3600_000,
    );
    let failed = 0;
    for (const { shop_id } of shops) {
      try {
        await this.computeHourRollup(shop_id, hourStart, now);
        await this.restateWindow(shop_id, restateFrom, now);
      } catch (err) {
        failed += 1;
        // §5.7 control 4: internal IDs and error class only.
        this.logger.error(
          `hourly rollup failed for shop ${shop_id}: ${(err as Error).name}`,
        );
      }
    }
    return { shops: shops.length, failed };
  }

  /* ---------------------------------------------------------------- */
  /* Snapshot family: the §9.10 action cards (RV-03 stored conditions) */
  /* ---------------------------------------------------------------- */

  private async snapshotCardRows(
    shopId: string,
    hourStartUtc: Date,
    now: Date,
  ): Promise<RollupRow[]> {
    const rows: RollupRow[] = [];
    const card = (key: DashboardCardKey, test: boolean, count: number): RollupRow => ({
      hourStartUtc,
      dimension: { kind: 'card', card: key, test },
      metrics: { count },
    });
    /** Emit a live + a test side; a side with no rows counts 0. */
    const split = (counts: CountRow[]): { live: number; test: number } => {
      let live = 0;
      let test = 0;
      for (const r of counts) {
        if (r.t) test = Number(r.count);
        else live = Number(r.count);
      }
      return { live, test };
    };

    // new_to_book — order_state = READY (§3.1) with ≥1 DRAFT shipment (§3.2).
    const newToBook = split(
      (
        await this.pool.query<CountRow>(
          `SELECT o.is_test_order AS t, count(*)::int AS count
             FROM "order" o
            WHERE o.shop_id = $1
              AND o.order_state = 'READY'
              AND EXISTS (
                    SELECT 1 FROM shipment s
                     WHERE s.order_id = o.order_id
                       AND s.booking_state = 'DRAFT'
                       AND s.is_test = o.is_test_order)
            GROUP BY o.is_test_order`,
          [shopId],
        )
      ).rows,
    );
    rows.push(card('new_to_book', false, newToBook.live), card('new_to_book', true, newToBook.test));

    // ndr_open — ndr_case.state ≠ CLOSED (§3.10), test side via the shipment.
    const ndr = split(
      (
        await this.pool.query<CountRow>(
          `SELECT s.is_test AS t, count(*)::int AS count
             FROM ndr_case nc
             JOIN shipment s ON s.shipment_id = nc.shipment_id
            WHERE nc.shop_id = $1
              AND nc.state <> 'CLOSED'
            GROUP BY s.is_test`,
          [shopId],
        )
      ).rows,
    );
    rows.push(card('ndr_open', false, ndr.live), card('ndr_open', true, ndr.test));

    // pickup_pending — custody_state = PICKUP_PENDING (§3.3).
    const pickup = split(
      (
        await this.pool.query<CountRow>(
          `SELECT s.is_test AS t, count(*)::int AS count
             FROM shipment s
            WHERE s.shop_id = $1
              AND s.custody_state = 'PICKUP_PENDING'
            GROUP BY s.is_test`,
          [shopId],
        )
      ).rows,
    );
    rows.push(card('pickup_pending', false, pickup.live), card('pickup_pending', true, pickup.test));

    // delayed — S-47 (EDD exceeded by >24h, RW-06), reusing the tracking
    // module's listDelayed so the card and the §9.7 list never disagree.
    // listDelayed is live-only by definition (INV-19); the test side is 0.
    const delayed = await this.delay.listDelayed(shopId, now);
    rows.push(card('delayed', false, delayed.length), card('delayed', true, 0));

    // manual_assignment — booking_state = NEEDS_MANUAL_ASSIGNMENT (§3.2, RV-03).
    const manual = split(
      (
        await this.pool.query<CountRow>(
          `SELECT s.is_test AS t, count(*)::int AS count
             FROM shipment s
            WHERE s.shop_id = $1
              AND s.booking_state = 'NEEDS_MANUAL_ASSIGNMENT'
            GROUP BY s.is_test`,
          [shopId],
        )
      ).rows,
    );
    rows.push(
      card('manual_assignment', false, manual.live),
      card('manual_assignment', true, manual.test),
    );

    // courier_disconnected — health_state = DISCONNECTED (§3.21). Accounts
    // carry mode, not is_test: TEST-mode accounts are the test side.
    const disconnected = split(
      (
        await this.pool.query<CountRow>(
          `SELECT (ca.mode = 'TEST') AS t, count(*)::int AS count
             FROM courier_account ca
            WHERE ca.shop_id = $1
              AND ca.health_state = 'DISCONNECTED'
            GROUP BY (ca.mode = 'TEST')`,
          [shopId],
        )
      ).rows,
    );
    rows.push(
      card('courier_disconnected', false, disconnected.live),
      card('courier_disconnected', true, disconnected.test),
    );

    // recon_disputes_open — §3.14 counting rule via the provider seam
    // (recon tables land weeks 14–15; see recon-disputes.ts). Recon rows
    // never exist for test shipments (INV-19, §5.3) — the test side is 0.
    const disputes = await this.reconDisputes.countOpenDisputes(shopId);
    rows.push(card('recon_disputes_open', false, disputes), card('recon_disputes_open', true, 0));

    // cod_unassigned — order.cod_assignment_state = UNASSIGNED (§3.24, RW-18).
    const cod = split(
      (
        await this.pool.query<CountRow>(
          `SELECT o.is_test_order AS t, count(*)::int AS count
             FROM "order" o
            WHERE o.shop_id = $1
              AND o.cod_assignment_state = 'UNASSIGNED'
            GROUP BY o.is_test_order`,
          [shopId],
        )
      ).rows,
    );
    rows.push(card('cod_unassigned', false, cod.live), card('cod_unassigned', true, cod.test));

    // invoice_issue_pending — gst_invoice.state = ISSUE_PENDING (§3.12).
    // A test shipment never creates a GST invoice (INV-19) — test side is 0.
    const invoices = split(
      (
        await this.pool.query<CountRow>(
          `SELECT false AS t, count(*)::int AS count
             FROM gst_invoice gi
            WHERE gi.shop_id = $1
              AND gi.state = 'ISSUE_PENDING'`,
          [shopId],
        )
      ).rows,
    );
    rows.push(
      card('invoice_issue_pending', false, invoices.live),
      card('invoice_issue_pending', true, invoices.test),
    );

    return rows;
  }

  /* ---------------------------------------------------------------- */
  /* Snapshot family: distributions (matrix, COD vs prepaid, volumes)  */
  /* ---------------------------------------------------------------- */

  private async snapshotDistributionRows(
    shopId: string,
    hourStartUtc: Date,
  ): Promise<RollupRow[]> {
    const rows: RollupRow[] = [];
    const push = (
      t: boolean,
      key: string | null,
      count: number,
      make: (key: string | null, test: boolean) => RollupDimension,
    ) =>
      rows.push({
        hourStartUtc,
        dimension: make(key, t),
        metrics: { count },
      });

    // by_movement — §3.4 movement states across all shipments.
    const movement = await this.pool.query<GroupedCountRow>(
      `SELECT s.is_test AS t, s.movement_state AS key, count(*)::int AS count
         FROM shipment s
        WHERE s.shop_id = $1
        GROUP BY s.is_test, s.movement_state`,
      [shopId],
    );
    for (const r of movement.rows) {
      push(r.t, r.key, Number(r.count), (key, test) => ({
        kind: 'by_movement',
        state: key ?? 'NOT_SHIPPED',
        test,
      }));
    }

    // by_booking — §3.2 booking states across all shipments.
    const booking = await this.pool.query<GroupedCountRow>(
      `SELECT s.is_test AS t, s.booking_state AS key, count(*)::int AS count
         FROM shipment s
        WHERE s.shop_id = $1
        GROUP BY s.is_test, s.booking_state`,
      [shopId],
    );
    for (const r of booking.rows) {
      push(r.t, r.key, Number(r.count), (key, test) => ({
        kind: 'by_booking',
        state: key ?? 'DRAFT',
        test,
      }));
    }

    // by_payment — COD vs Prepaid volumes (§9.10): booked (CONFIRMED)
    // shipments by the order's §3.5 payment mode.
    const payment = await this.pool.query<GroupedCountRow>(
      `SELECT s.is_test AS t, o.payment_mode AS key, count(*)::int AS count
         FROM shipment s
         JOIN "order" o ON o.order_id = s.order_id
        WHERE s.shop_id = $1
          AND s.booking_state = 'CONFIRMED'
        GROUP BY s.is_test, o.payment_mode`,
      [shopId],
    );
    for (const r of payment.rows) {
      push(r.t, r.key, Number(r.count), (key, test) => ({
        kind: 'by_payment',
        mode: key ?? 'UNRESOLVED',
        test,
      }));
    }

    // by_service — booked-shipment volume per Service.
    const byService = await this.pool.query<GroupedCountRow>(
      `SELECT s.is_test AS t, s.service_id::text AS key, count(*)::int AS count
         FROM shipment s
        WHERE s.shop_id = $1
          AND s.booking_state = 'CONFIRMED'
        GROUP BY s.is_test, s.service_id`,
      [shopId],
    );
    for (const r of byService.rows) {
      push(r.t, r.key, Number(r.count), (key, test) => ({
        kind: 'by_service',
        serviceId: key,
        test,
      }));
    }

    // service_movement — the §9.10 Service × status matrix.
    const matrix = await this.pool.query<{ t: boolean; service_id: string | null; state: string; count: number | string }>(
      `SELECT s.is_test AS t, s.service_id::text AS service_id,
              s.movement_state AS state, count(*)::int AS count
         FROM shipment s
        WHERE s.shop_id = $1
          AND s.booking_state = 'CONFIRMED'
        GROUP BY s.is_test, s.service_id, s.movement_state`,
      [shopId],
    );
    for (const r of matrix.rows) {
      rows.push({
        hourStartUtc,
        dimension: {
          kind: 'service_movement',
          serviceId: r.service_id,
          state: r.state,
          test: r.t,
        },
        metrics: { count: Number(r.count) },
      });
    }

    return rows;
  }

  /* ---------------------------------------------------------------- */
  /* Event/cohort family: the F-16 inputs, §5.2 hour attribution       */
  /* ---------------------------------------------------------------- */

  /** F-16.a/c booked cohort, attributed to the booked hour (§5.2). */
  private async cohortRows(shopId: string, fromUtc: Date, toUtc: Date): Promise<RollupRow[]> {
    const { rows } = await this.pool.query<
      { hour_start_utc: Date; t: boolean; service_id: string | null } & Record<
        keyof CohortMetrics,
        number | string
      >
    >(
      `SELECT date_trunc('hour', s.booked_at) AS hour_start_utc,
              s.is_test AS t,
              s.service_id::text AS service_id,
              count(*)::int AS booked,
              count(*) FILTER (WHERE s.movement_state = 'DELIVERED')::int AS delivered,
              count(*) FILTER (WHERE s.movement_state = 'RTO_DELIVERED')::int AS rto_delivered,
              count(*) FILTER (WHERE s.movement_state = 'LOST_OR_DAMAGED')::int AS lost_or_damaged,
              count(*) FILTER (WHERE s.movement_state = 'CANCELLED_BY_COURIER')::int AS cancelled_by_courier,
              count(*) FILTER (WHERE s.booking_state = 'VOID')::int AS void,
              count(*) FILTER (WHERE s.booking_state <> 'VOID'
                                 AND s.movement_state NOT IN
                                   ('DELIVERED', 'RTO_DELIVERED', 'LOST_OR_DAMAGED', 'CANCELLED_BY_COURIER')
                              )::int AS open
         FROM shipment s
        WHERE s.shop_id = $1
          AND s.booked_at >= $2
          AND s.booked_at < $3
        GROUP BY 1, 2, 3`,
      [shopId, fromUtc.toISOString(), toUtc.toISOString()],
    );
    return rows.map((r) => ({
      hourStartUtc: new Date(r.hour_start_utc),
      dimension: { kind: 'f16_cohort', serviceId: r.service_id, test: r.t },
      metrics: {
        booked: Number(r.booked),
        delivered: Number(r.delivered),
        rto_delivered: Number(r.rto_delivered),
        lost_or_damaged: Number(r.lost_or_damaged),
        cancelled_by_courier: Number(r.cancelled_by_courier),
        void: Number(r.void),
        open: Number(r.open),
      } satisfies CohortMetrics,
    }));
  }

  /** F-16.b numerator: shipments with ≥1 NDR, at the first-NDR hour (§5.2). */
  private async ndrRows(shopId: string, fromUtc: Date, toUtc: Date): Promise<RollupRow[]> {
    const { rows } = await this.pool.query<{
      hour_start_utc: Date;
      t: boolean;
      service_id: string | null;
      shipments_with_ndr: number | string;
    }>(
      `SELECT date_trunc('hour', nc.first_ndr_at) AS hour_start_utc,
              s.is_test AS t,
              s.service_id::text AS service_id,
              count(DISTINCT nc.shipment_id)::int AS shipments_with_ndr
         FROM ndr_case nc
         JOIN shipment s ON s.shipment_id = nc.shipment_id
        WHERE nc.shop_id = $1
          AND nc.first_ndr_at >= $2
          AND nc.first_ndr_at < $3
        GROUP BY 1, 2, 3`,
      [shopId, fromUtc.toISOString(), toUtc.toISOString()],
    );
    return rows.map((r) => ({
      hourStartUtc: new Date(r.hour_start_utc),
      dimension: { kind: 'f16_ndr', serviceId: r.service_id, test: r.t },
      metrics: { shipments_with_ndr: Number(r.shipments_with_ndr) },
    }));
  }

  /** F-16.b denominator: first PICKED_UP occurred-at per shipment (§5.2). */
  private async pickupRows(shopId: string, fromUtc: Date, toUtc: Date): Promise<RollupRow[]> {
    const { rows } = await this.pool.query<{
      hour_start_utc: Date;
      t: boolean;
      service_id: string | null;
      picked_up: number | string;
    }>(
      `WITH first_pick AS (
         SELECT te.shipment_id, min(te.occurred_at) AS picked_at
           FROM tracking_event te
          WHERE te.shop_id = $1
            AND te.carrier_event_status = 'PICKED_UP'
            AND te.occurred_at < $3
          GROUP BY te.shipment_id
       )
       SELECT date_trunc('hour', fp.picked_at) AS hour_start_utc,
              s.is_test AS t,
              s.service_id::text AS service_id,
              count(*)::int AS picked_up
         FROM first_pick fp
         JOIN shipment s ON s.shipment_id = fp.shipment_id
        WHERE s.shop_id = $1
          AND fp.picked_at >= $2
          AND fp.picked_at < $3
        GROUP BY 1, 2, 3`,
      [shopId, fromUtc.toISOString(), toUtc.toISOString()],
    );
    return rows.map((r) => ({
      hourStartUtc: new Date(r.hour_start_utc),
      dimension: { kind: 'f16_pickup', serviceId: r.service_id, test: r.t },
      metrics: { picked_up: Number(r.picked_up) },
    }));
  }

  /**
   * F-16.d TAT (calendar hours, PICKED_UP → DELIVERED occurred-at) plus the
   * delivered count, attributed to the DELIVERED occurred-at hour (§5.2).
   */
  private async deliveryRows(shopId: string, fromUtc: Date, toUtc: Date): Promise<RollupRow[]> {
    const { rows } = await this.pool.query<{
      hour_start_utc: Date;
      t: boolean;
      service_id: string | null;
      delivered: number | string;
      tat_count: number | string;
      tat_hours_sum: number | string | null;
    }>(
      `WITH first_pick AS (
         SELECT te.shipment_id, min(te.occurred_at) AS picked_at
           FROM tracking_event te
          WHERE te.shop_id = $1
            AND te.carrier_event_status = 'PICKED_UP'
            AND te.occurred_at < $3
          GROUP BY te.shipment_id
       ),
       deliveries AS (
         SELECT te.shipment_id, min(te.occurred_at) AS delivered_at
           FROM tracking_event te
          WHERE te.shop_id = $1
            AND te.carrier_event_status = 'DELIVERED'
            AND te.occurred_at >= $2
            AND te.occurred_at < $3
          GROUP BY te.shipment_id
       )
       SELECT date_trunc('hour', d.delivered_at) AS hour_start_utc,
              s.is_test AS t,
              s.service_id::text AS service_id,
              count(*)::int AS delivered,
              count(fp.shipment_id)::int AS tat_count,
              COALESCE(
                sum(EXTRACT(EPOCH FROM (d.delivered_at - fp.picked_at)) / 3600.0),
                0
              )::float8 AS tat_hours_sum
         FROM deliveries d
         JOIN shipment s ON s.shipment_id = d.shipment_id
         LEFT JOIN first_pick fp ON fp.shipment_id = d.shipment_id
        WHERE s.shop_id = $1
        GROUP BY 1, 2, 3`,
      [shopId, fromUtc.toISOString(), toUtc.toISOString()],
    );
    return rows.map((r) => ({
      hourStartUtc: new Date(r.hour_start_utc),
      dimension: { kind: 'f16_delivery', serviceId: r.service_id, test: r.t },
      metrics: {
        delivered: Number(r.delivered),
        tat_count: Number(r.tat_count),
        tat_hours_sum: Number(r.tat_hours_sum ?? 0),
      } satisfies DeliveryMetrics,
    }));
  }

  /* ---------------------------------------------------------------- */

  /**
   * UPSERT keyed (shop_id, hour_start_utc, dimension_json) (§2.8). One
   * multi-row INSERT via unnest; recompute of the same hour overwrites
   * metrics and computed_at (idempotent, §5.2 restatement).
   */
  private async upsert(shopId: string, rows: RollupRow[], computedAt: Date): Promise<void> {
    if (rows.length === 0) return;
    const hours: string[] = [];
    const dimensions: string[] = [];
    const metrics: string[] = [];
    for (const r of rows) {
      hours.push(r.hourStartUtc.toISOString());
      dimensions.push(JSON.stringify(r.dimension));
      metrics.push(JSON.stringify(r.metrics satisfies RollupMetrics));
    }
    await this.pool.query(
      `INSERT INTO rollup_hourly_stats
         (shop_id, hour_start_utc, dimension_json, metrics_json, computed_at)
       SELECT $1::uuid, u.hr, u.dim, u.met, $5::timestamptz
         FROM unnest($2::timestamptz[], $3::jsonb[], $4::jsonb[]) AS u(hr, dim, met)
       ON CONFLICT (shop_id, hour_start_utc, dimension_json) DO UPDATE
         SET metrics_json = EXCLUDED.metrics_json,
             computed_at  = EXCLUDED.computed_at`,
      [shopId, hours, dimensions, metrics, computedAt.toISOString()],
    );
  }
}
