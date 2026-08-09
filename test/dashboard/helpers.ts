import { Pool } from 'pg';

/**
 * Test doubles for the dashboard specs — the same FnPool pattern as
 * test/tracking / test/gst: regex-matched SQL handlers over a recorded
 * call log.
 */

export const SHOP_ID = '11111111-1111-1111-1111-111111111111';
export const OTHER_SHOP_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
export const SERVICE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const SERVICE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

export interface RecordedCall {
  sql: string;
  params: unknown[];
}

type HandlerResult = { rows: unknown[]; rowCount: number };
type Handler = (sql: string, params: unknown[]) => HandlerResult | undefined;

export class FnPool {
  readonly calls: RecordedCall[] = [];
  private readonly handlers: Array<{ pattern: RegExp; fn: Handler }> = [];

  on(pattern: RegExp, rows: unknown[], rowCount?: number): this {
    this.handlers.push({
      pattern,
      fn: () => ({ rows, rowCount: rowCount ?? rows.length }),
    });
    return this;
  }

  onFn(pattern: RegExp, fn: Handler): this {
    this.handlers.push({ pattern, fn });
    return this;
  }

  readonly query = (sql: string, params?: unknown[]) => {
    this.calls.push({ sql, params: params ?? [] });
    for (const h of this.handlers) {
      if (h.pattern.test(sql)) {
        const r = h.fn(sql, params ?? []);
        if (r) return Promise.resolve({ rows: r.rows as never[], rowCount: r.rowCount });
      }
    }
    return Promise.resolve({ rows: [] as never[], rowCount: 0 });
  };

  readonly connect = () =>
    Promise.resolve({
      query: this.query,
      release: () => undefined,
    });

  matching(pattern: RegExp): RecordedCall[] {
    return this.calls.filter((c) => pattern.test(c.sql));
  }

  asPool(): Pool {
    return this as unknown as Pool;
  }
}

/* Query fingerprints (keep in sync with rollup.service.ts /
 * dashboard.service.ts — that coupling is the point: the tests assert the
 * SQL hits the stored columns and the rollup table, not derived text). */

export const SQL = {
  upsert: /INSERT INTO rollup_hourly_stats/,
  shops: /SELECT shop_id FROM shop/,
  cardNewToBook: /o\.order_state = 'READY'/,
  cardNdr: /nc\.state <> 'CLOSED'/,
  cardPickupPending: /s\.custody_state = 'PICKUP_PENDING'/,
  cardManual: /s\.booking_state = 'NEEDS_MANUAL_ASSIGNMENT'/,
  cardCourier: /ca\.health_state = 'DISCONNECTED'/,
  cardCod: /o\.cod_assignment_state = 'UNASSIGNED'/,
  cardInvoice: /gi\.state = 'ISSUE_PENDING'/,
  byMovement: /GROUP BY s\.is_test, s\.movement_state$/,
  byBooking: /GROUP BY s\.is_test, s\.booking_state$/,
  byPayment: /GROUP BY s\.is_test, o\.payment_mode$/,
  byService: /GROUP BY s\.is_test, s\.service_id$/,
  serviceMovement: /GROUP BY s\.is_test, s\.service_id, s\.movement_state$/,
  cohort: /date_trunc\('hour', s\.booked_at\)/,
  ndrEvents: /nc\.first_ndr_at >= \$2/,
  pickupEvents: /count\(\*\)::int AS picked_up/,
  deliveryEvents: /tat_hours_sum/,
  snapshot: /SELECT max\(r2\.hour_start_utc\)/,
  todayYesterday: /WITH b AS/,
  trend: /generate_series/,
  performance: /'f16_cohort', 'f16_ndr', 'f16_pickup', 'f16_delivery'/,
  shopTz: /SELECT iana_timezone FROM shop/,
  serviceNames: /FROM service s\s+JOIN courier c/,
};
