import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import {
  avgTatHours,
  DASHBOARD_CARD_KEYS,
  DASHBOARD_FRESHNESS_MS,
  DashboardCardKey,
  deliveryRate,
  ndrRate,
  RollupDimension,
  RollupMetrics,
  rtoRate,
  ServicePerformanceRow,
  TestView,
  CohortMetrics,
  DeliveryMetrics,
  NdrMetrics,
  PickupMetrics,
  CountMetrics,
} from './dashboard.types';

/**
 * §9.10 dashboard read models. EVERY figure comes from
 * `rollup_hourly_stats` (§5.7 — never per-row subqueries at render); the
 * only non-rollup tables touched are `shop` (the §5.2 display timezone)
 * and `service`/`courier` (global master data for display names — never a
 * figure). Every response carries the as-of time of the rollup rows behind
 * it (§5.2: freshness ≤75 min, always displayed).
 *
 * The action-card counts are rollup rows like everything else — each
 * card's condition is a stored column (RV-03), so the rollup maintains
 * them (kinds 'card') and rendering never re-derives them.
 *
 * Test/live view (§9.23): default live. Live figures come from the
 * test=false rollup side only; INV-19 is therefore structural here, not a
 * filter remembered at render.
 */

export interface DayVolume {
  booked: number;
  delivered: number;
}

export interface TrendPoint {
  /** Shop-local calendar date, YYYY-MM-DD (§5.2). */
  date: string;
  booked: number;
  delivered: number;
}

export interface ServiceMatrixRow {
  serviceId: string | null;
  serviceName: string | null;
  courierCode: string | null;
  /** movement_state (§3.4) → shipment count. */
  states: Record<string, number>;
}

export interface ServicePerformance extends ServicePerformanceRow {
  serviceName: string | null;
  courierCode: string | null;
}

export interface DashboardPayload {
  /** §5.2 as-of: when the rollup rows behind these figures were computed. */
  asOf: string | null;
  /** True when asOf is missing or older than the §5.2 75-minute bound. */
  stale: boolean;
  view: TestView;
  todayVsYesterday: { today: DayVolume; yesterday: DayVolume };
  cards: Record<DashboardCardKey, number>;
  serviceMatrix: ServiceMatrixRow[];
  servicePerformance: ServicePerformance[];
  codVsPrepaid: Record<string, number>;
  trend: TrendPoint[];
}

interface SnapshotRow {
  dimension_json: RollupDimension;
  metrics_json: RollupMetrics;
  computed_at: Date;
}

const SNAPSHOT_KINDS = [
  'card',
  'by_movement',
  'by_booking',
  'by_payment',
  'by_service',
  'service_movement',
];

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 90;

@Injectable()
export class DashboardService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** §9.10 main payload: cards, matrix, performance, COD/prepaid, trend. */
  async getDashboard(
    shopId: string,
    view: TestView = 'live',
    now: Date = new Date(),
  ): Promise<DashboardPayload> {
    const snapshot = await this.latestSnapshot(shopId, view);
    const tz = await this.shopTimezone(shopId);
    const [todayVsYesterday, servicePerformance, trend] = await Promise.all([
      this.todayVsYesterday(shopId, view, tz, now),
      this.getServicePerformance(shopId, view, DEFAULT_WINDOW_DAYS, now),
      this.getTrend(shopId, view, DEFAULT_WINDOW_DAYS, tz, now),
    ]);

    const cards = Object.fromEntries(
      DASHBOARD_CARD_KEYS.map((k) => [k, 0]),
    ) as Record<DashboardCardKey, number>;
    const codVsPrepaid: Record<string, number> = {};
    const matrixByService = new Map<string | null, Record<string, number>>();
    for (const row of snapshot.rows) {
      const dim = row.dimension_json;
      if (dim.kind === 'card') {
        cards[dim.card] = (row.metrics_json as CountMetrics).count;
      } else if (dim.kind === 'by_payment') {
        codVsPrepaid[dim.mode] = (row.metrics_json as CountMetrics).count;
      } else if (dim.kind === 'service_movement') {
        const states = matrixByService.get(dim.serviceId) ?? {};
        states[dim.state] = (row.metrics_json as CountMetrics).count;
        matrixByService.set(dim.serviceId, states);
      }
    }
    const names = await this.serviceNames([...matrixByService.keys()]);
    const serviceMatrix: ServiceMatrixRow[] = [...matrixByService.entries()].map(
      ([serviceId, states]) => ({
        serviceId,
        serviceName: serviceId ? (names.get(serviceId)?.name ?? null) : null,
        courierCode: serviceId ? (names.get(serviceId)?.courierCode ?? null) : null,
        states,
      }),
    );

    return {
      asOf: snapshot.asOf ? snapshot.asOf.toISOString() : null,
      stale:
        snapshot.asOf === null ||
        now.getTime() - snapshot.asOf.getTime() > DASHBOARD_FRESHNESS_MS,
      view,
      todayVsYesterday,
      cards,
      serviceMatrix,
      servicePerformance,
      codVsPrepaid,
      trend,
    };
  }

  /**
   * §9.10 Service performance, F-16.a–d per Service over the trailing
   * window — aggregated from the f16_* rollup rows only. Open shipments of
   * the booked cohorts are reported separately and enter neither F-16.a
   * term (§4.10).
   */
  async getServicePerformance(
    shopId: string,
    view: TestView = 'live',
    days: number = DEFAULT_WINDOW_DAYS,
    now: Date = new Date(),
  ): Promise<ServicePerformance[]> {
    const windowDays = Math.min(Math.max(1, Math.floor(days)), MAX_WINDOW_DAYS);
    const from = new Date(now.getTime() - windowDays * 24 * 3600_000);
    const { rows } = await this.pool.query<{
      service_id: string | null;
      dimension_kind: string;
      metrics_json: RollupMetrics;
    }>(
      `SELECT r.dimension_json ->> 'serviceId' AS service_id,
              r.dimension_json ->> 'kind'      AS dimension_kind,
              r.metrics_json
         FROM rollup_hourly_stats r
        WHERE r.shop_id = $1
          AND (r.dimension_json ->> 'test')::boolean = $2
          AND r.dimension_json ->> 'kind' IN
                ('f16_cohort', 'f16_ndr', 'f16_pickup', 'f16_delivery')
          AND r.hour_start_utc >= $3
          AND r.hour_start_utc <  $4`,
      [shopId, view === 'test', from.toISOString(), now.toISOString()],
    );

    const acc = new Map<string | null, ServicePerformanceRow>();
    const bucket = (serviceId: string | null): ServicePerformanceRow => {
      let b = acc.get(serviceId);
      if (!b) {
        b = {
          serviceId,
          booked: 0,
          open: 0,
          delivered: 0,
          rtoDelivered: 0,
          terminal: 0,
          pickedUp: 0,
          shipmentsWithNdr: 0,
          deliveryRate: null,
          ndrRate: null,
          rtoRate: null,
          avgTatHours: null,
        };
        acc.set(serviceId, b);
      }
      return b;
    };
    const tatSum = new Map<string | null, { sum: number; count: number }>();

    for (const row of rows) {
      const b = bucket(row.service_id);
      if (row.dimension_kind === 'f16_cohort') {
        const m = row.metrics_json as CohortMetrics;
        b.booked += m.booked;
        b.open += m.open;
        b.delivered += m.delivered;
        b.rtoDelivered += m.rto_delivered;
        // Terminal = every terminal §3.4 state of the cohort (F-16.c denominator).
        b.terminal +=
          m.delivered + m.rto_delivered + m.lost_or_damaged + m.cancelled_by_courier;
      } else if (row.dimension_kind === 'f16_ndr') {
        b.shipmentsWithNdr += (row.metrics_json as NdrMetrics).shipments_with_ndr;
      } else if (row.dimension_kind === 'f16_pickup') {
        b.pickedUp += (row.metrics_json as PickupMetrics).picked_up;
      } else if (row.dimension_kind === 'f16_delivery') {
        const m = row.metrics_json as DeliveryMetrics;
        const t = tatSum.get(row.service_id) ?? { sum: 0, count: 0 };
        t.sum += m.tat_hours_sum;
        t.count += m.tat_count;
        tatSum.set(row.service_id, t);
      }
    }

    for (const b of acc.values()) {
      // §4.10 exact formulas — see dashboard.types.ts.
      b.deliveryRate = deliveryRate(b.delivered, b.rtoDelivered);
      b.ndrRate = ndrRate(b.shipmentsWithNdr, b.pickedUp);
      b.rtoRate = rtoRate(b.rtoDelivered, b.terminal);
      const t = tatSum.get(b.serviceId) ?? { sum: 0, count: 0 };
      b.avgTatHours = avgTatHours(t.sum, t.count);
    }

    const names = await this.serviceNames([...acc.keys()]);
    return [...acc.values()].map((b) => ({
      ...b,
      serviceName: b.serviceId ? (names.get(b.serviceId)?.name ?? null) : null,
      courierCode: b.serviceId ? (names.get(b.serviceId)?.courierCode ?? null) : null,
    }));
  }

  /**
   * §9.10 30-day trend: booked (booked-cohort attribution) and delivered
   * (DELIVERED occurred-at attribution) volumes per shop-local day (§5.2),
   * zero-filled. Rollup rows only.
   */
  async getTrend(
    shopId: string,
    view: TestView = 'live',
    days: number = DEFAULT_WINDOW_DAYS,
    timezone?: string,
    now: Date = new Date(),
  ): Promise<TrendPoint[]> {
    const tz = timezone ?? (await this.shopTimezone(shopId));
    const windowDays = Math.min(Math.max(1, Math.floor(days)), MAX_WINDOW_DAYS);
    const { rows } = await this.pool.query<{
      day: string;
      booked: number | string;
      delivered: number | string;
    }>(
      `WITH days AS (
         SELECT generate_series(
                  date_trunc('day', $4::timestamptz AT TIME ZONE $2)
                    - ($5::int - 1) * interval '1 day',
                  date_trunc('day', $4::timestamptz AT TIME ZONE $2),
                  interval '1 day'
                ) AS day_local
       )
       SELECT to_char(d.day_local, 'YYYY-MM-DD') AS day,
              COALESCE(sum((r.metrics_json ->> 'booked')::int)
                FILTER (WHERE r.dimension_json ->> 'kind' = 'f16_cohort'), 0)::int AS booked,
              COALESCE(sum((r.metrics_json ->> 'delivered')::int)
                FILTER (WHERE r.dimension_json ->> 'kind' = 'f16_delivery'), 0)::int AS delivered
         FROM days d
         LEFT JOIN rollup_hourly_stats r
           ON r.shop_id = $1
          AND (r.dimension_json ->> 'test')::boolean = $3
          AND r.dimension_json ->> 'kind' IN ('f16_cohort', 'f16_delivery')
          AND date_trunc('day', r.hour_start_utc AT TIME ZONE $2) = d.day_local
        GROUP BY d.day_local
        ORDER BY d.day_local`,
      [shopId, tz, view === 'test', now.toISOString(), windowDays],
    );
    return rows.map((r) => ({
      date: r.day,
      booked: Number(r.booked),
      delivered: Number(r.delivered),
    }));
  }

  /* ---------------------------------------------------------------- */

  /**
   * Today vs yesterday in shop-local days (§5.2 half-open [00:00, next
   * 00:00)): booked volume from the booked-cohort rows, delivered volume
   * from the DELIVERED occurred-at rows.
   */
  private async todayVsYesterday(
    shopId: string,
    view: TestView,
    timezone: string,
    now: Date,
  ): Promise<{ today: DayVolume; yesterday: DayVolume }> {
    const { rows } = await this.pool.query<{
      bucket: string;
      booked: number | string | null;
      delivered: number | string | null;
    }>(
      `WITH b AS (
         SELECT date_trunc('day', $3::timestamptz AT TIME ZONE $2)
                  AT TIME ZONE $2 AS today_start
       )
       SELECT CASE WHEN r.hour_start_utc >= (SELECT today_start FROM b)
                   THEN 'today' ELSE 'yesterday' END AS bucket,
              sum((r.metrics_json ->> 'booked')::int)
                FILTER (WHERE r.dimension_json ->> 'kind' = 'f16_cohort') AS booked,
              sum((r.metrics_json ->> 'delivered')::int)
                FILTER (WHERE r.dimension_json ->> 'kind' = 'f16_delivery') AS delivered
         FROM rollup_hourly_stats r
        WHERE r.shop_id = $1
          AND (r.dimension_json ->> 'test')::boolean = $4
          AND r.dimension_json ->> 'kind' IN ('f16_cohort', 'f16_delivery')
          AND r.hour_start_utc >= (SELECT today_start FROM b) - interval '1 day'
          AND r.hour_start_utc <  $3::timestamptz
        GROUP BY 1`,
      [shopId, timezone, now.toISOString(), view === 'test'],
    );
    const result = {
      today: { booked: 0, delivered: 0 },
      yesterday: { booked: 0, delivered: 0 },
    };
    for (const r of rows) {
      const bucket = r.bucket === 'today' ? result.today : result.yesterday;
      bucket.booked = Number(r.booked ?? 0);
      bucket.delivered = Number(r.delivered ?? 0);
    }
    return result;
  }

  /**
   * The latest snapshot hour's rows (cards + distributions). The as-of
   * time (§5.2) is the newest computed_at among them; null when no rollup
   * has run yet (the dashboard renders zeros and stale=true).
   */
  private async latestSnapshot(
    shopId: string,
    view: TestView,
  ): Promise<{ rows: SnapshotRow[]; asOf: Date | null }> {
    const { rows } = await this.pool.query<SnapshotRow>(
      `SELECT r.dimension_json, r.metrics_json, r.computed_at
         FROM rollup_hourly_stats r
        WHERE r.shop_id = $1
          AND (r.dimension_json ->> 'test')::boolean = $2
          AND r.dimension_json ->> 'kind' = ANY ($3::text[])
          AND r.hour_start_utc = (
                SELECT max(r2.hour_start_utc)
                  FROM rollup_hourly_stats r2
                 WHERE r2.shop_id = $1
                   AND (r2.dimension_json ->> 'test')::boolean = $2
                   AND r2.dimension_json ->> 'kind' = 'card')`,
      [shopId, view === 'test', SNAPSHOT_KINDS],
    );
    const asOf = rows.reduce<Date | null>(
      (max, r) => (max === null || r.computed_at > max ? new Date(r.computed_at) : max),
      null,
    );
    return { rows, asOf };
  }

  /** §5.2 display timezone (S-2 / shop default Asia/Kolkata). */
  private async shopTimezone(shopId: string): Promise<string> {
    const { rows } = await this.pool.query<{ iana_timezone: string }>(
      `SELECT iana_timezone FROM shop WHERE shop_id = $1`,
      [shopId],
    );
    return rows[0]?.iana_timezone ?? 'Asia/Kolkata';
  }

  /**
   * Display names from global master data (service/courier are [global]
   * §2 tables, not figures) — the only non-rollup read besides the
   * timezone, and never a counted value.
   */
  private async serviceNames(
    serviceIds: (string | null)[],
  ): Promise<Map<string, { name: string; courierCode: string }>> {
    const ids = serviceIds.filter((id): id is string => id !== null);
    if (ids.length === 0) return new Map();
    const { rows } = await this.pool.query<{
      service_id: string;
      name: string;
      courier_code: string;
    }>(
      `SELECT s.service_id::text AS service_id, s.name, c.code AS courier_code
         FROM service s
         JOIN courier c ON c.courier_id = s.courier_id
        WHERE s.service_id = ANY ($1::uuid[])`,
      [ids],
    );
    return new Map(rows.map((r) => [r.service_id, { name: r.name, courierCode: r.courier_code }]));
  }
}
