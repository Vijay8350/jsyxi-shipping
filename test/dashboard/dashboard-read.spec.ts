import { describe, expect, it } from 'vitest';
import { DashboardService } from '../../src/modules/dashboard/dashboard.service';
import { DASHBOARD_FRESHNESS_MS } from '../../src/modules/dashboard/dashboard.types';
import { FnPool, SERVICE_A, SERVICE_B, SHOP_ID, SQL } from './helpers';

/**
 * §9.10 dashboard reads: every figure from rollup_hourly_stats (§5.7),
 * cards reading stored rollup values (RV-03), as-of time always displayed
 * (§5.2), test/live view defaulting to live (§9.23).
 */

const NOW = new Date('2026-08-01T10:20:00.000Z');
const COMPUTED = new Date('2026-08-01T10:05:00.000Z');

function cardDim(card: string, count: number, computedAt: Date = COMPUTED) {
  return {
    dimension_json: { kind: 'card', card, test: false },
    metrics_json: { count },
    computed_at: computedAt,
  };
}

function basePool(): FnPool {
  const pool = new FnPool();
  pool
    .on(SQL.shopTz, [{ iana_timezone: 'Asia/Kolkata' }])
    .on(SQL.todayYesterday, [
      { bucket: 'today', booked: 5, delivered: 2 },
      { bucket: 'yesterday', booked: 9, delivered: 7 },
    ])
    .on(SQL.trend, [
      { day: '2026-07-30', booked: 3, delivered: 1 },
      { day: '2026-07-31', booked: 0, delivered: 0 },
      { day: '2026-08-01', booked: 5, delivered: 2 },
    ])
    .on(SQL.serviceNames, [
      { service_id: SERVICE_A, name: 'Delhivery Surface', courier_code: 'DELHIVERY' },
      { service_id: SERVICE_B, name: 'Blue Dart Air', courier_code: 'BLUEDART' },
    ]);
  return pool;
}

describe('DashboardService.getDashboard (§9.10)', () => {
  it('reads every action card from its stored rollup value (RV-03)', async () => {
    const pool = basePool();
    pool
      .on(SQL.snapshot, [
        cardDim('new_to_book', 4),
        cardDim('ndr_open', 7),
        cardDim('pickup_pending', 3),
        cardDim('delayed', 11),
        cardDim('manual_assignment', 2),
        cardDim('courier_disconnected', 1),
        cardDim('recon_disputes_open', 9),
        cardDim('cod_unassigned', 5),
        cardDim('invoice_issue_pending', 6),
        {
          dimension_json: { kind: 'by_payment', mode: 'COD', test: false },
          metrics_json: { count: 12 },
          computed_at: COMPUTED,
        },
        {
          dimension_json: { kind: 'by_payment', mode: 'PREPAID', test: false },
          metrics_json: { count: 30 },
          computed_at: COMPUTED,
        },
        {
          dimension_json: {
            kind: 'service_movement',
            serviceId: SERVICE_A,
            state: 'IN_TRANSIT',
            test: false,
          },
          metrics_json: { count: 4 },
          computed_at: COMPUTED,
        },
        {
          dimension_json: {
            kind: 'service_movement',
            serviceId: SERVICE_A,
            state: 'DELIVERED',
            test: false,
          },
          metrics_json: { count: 9 },
          computed_at: new Date('2026-08-01T10:06:00.000Z'),
        },
        {
          dimension_json: {
            kind: 'service_movement',
            serviceId: SERVICE_B,
            state: 'NDR',
            test: false,
          },
          metrics_json: { count: 1 },
          computed_at: COMPUTED,
        },
      ])
      .on(SQL.performance, []);
    const service = new DashboardService(pool.asPool());

    const dash = await service.getDashboard(SHOP_ID, 'live', NOW);

    expect(dash.cards).toEqual({
      new_to_book: 4,
      ndr_open: 7,
      pickup_pending: 3,
      delayed: 11,
      manual_assignment: 2,
      courier_disconnected: 1,
      recon_disputes_open: 9,
      cod_unassigned: 5,
      invoice_issue_pending: 6,
    });
    expect(dash.codVsPrepaid).toEqual({ COD: 12, PREPAID: 30 });
    expect(dash.todayVsYesterday).toEqual({
      today: { booked: 5, delivered: 2 },
      yesterday: { booked: 9, delivered: 7 },
    });
    const matrixA = dash.serviceMatrix.find((r) => r.serviceId === SERVICE_A);
    expect(matrixA?.states).toEqual({ IN_TRANSIT: 4, DELIVERED: 9 });
    expect(matrixA?.serviceName).toBe('Delhivery Surface');
    expect(matrixA?.courierCode).toBe('DELHIVERY');
    expect(dash.trend).toEqual([
      { date: '2026-07-30', booked: 3, delivered: 1 },
      { date: '2026-07-31', booked: 0, delivered: 0 },
      { date: '2026-08-01', booked: 5, delivered: 2 },
    ]);
  });

  it('displays an as-of time and flags staleness beyond 75 minutes (§5.2)', async () => {
    const pool = basePool();
    pool.on(SQL.snapshot, [
      cardDim('new_to_book', 4, new Date('2026-08-01T10:01:00.000Z')),
      cardDim('ndr_open', 7, new Date('2026-08-01T10:06:00.000Z')),
    ]);
    const service = new DashboardService(pool.asPool());

    const fresh = await service.getDashboard(SHOP_ID, 'live', NOW);
    expect(fresh.asOf).toBe('2026-08-01T10:06:00.000Z'); // newest computed_at wins
    expect(fresh.stale).toBe(false);
    expect(NOW.getTime() - Date.parse(fresh.asOf!)).toBeLessThan(DASHBOARD_FRESHNESS_MS);

    const stalePool = basePool();
    stalePool.on(SQL.snapshot, [
      cardDim('new_to_book', 4, new Date(NOW.getTime() - DASHBOARD_FRESHNESS_MS - 60_000)),
    ]);
    const staleDash = await new DashboardService(stalePool.asPool()).getDashboard(
      SHOP_ID,
      'live',
      NOW,
    );
    expect(staleDash.stale).toBe(true);

    const emptyPool = basePool(); // no rollup has ever run
    const empty = await new DashboardService(emptyPool.asPool()).getDashboard(
      SHOP_ID,
      'live',
      NOW,
    );
    expect(empty.asOf).toBeNull();
    expect(empty.stale).toBe(true);
    expect(empty.cards.new_to_book).toBe(0);
  });

  it('serves every figure from rollup_hourly_stats only (§5.7)', async () => {
    const pool = basePool();
    pool.on(SQL.snapshot, [cardDim('new_to_book', 1)]);
    const service = new DashboardService(pool.asPool());

    await service.getDashboard(SHOP_ID, 'live', NOW);

    const nonRollupReads = pool.calls.filter(
      (c) => !SQL.shopTz.test(c.sql) && !SQL.serviceNames.test(c.sql),
    );
    expect(nonRollupReads.length).toBeGreaterThanOrEqual(4); // snapshot, today/yesterday, performance, trend
    for (const call of nonRollupReads) {
      expect(call.sql).toContain('rollup_hourly_stats');
      expect(call.sql).not.toMatch(/FROM shipment|FROM ndr_case|FROM gst_invoice|FROM "order"/);
    }
  });

  it('defaults to the live side and switches every figure with view=test (§9.23)', async () => {
    const livePool = basePool();
    livePool.on(SQL.snapshot, []);
    await new DashboardService(livePool.asPool()).getDashboard(SHOP_ID, 'live', NOW);

    const rollupReads = livePool.calls.filter((c) => c.sql.includes('rollup_hourly_stats'));
    for (const call of rollupReads) {
      expect(call.params).toContain(false);
      expect(call.params).not.toContain(true);
    }

    const testPool = basePool();
    testPool.on(SQL.snapshot, []);
    const dash = await new DashboardService(testPool.asPool()).getDashboard(
      SHOP_ID,
      'test',
      NOW,
    );
    expect(dash.view).toBe('test');
    const testReads = testPool.calls.filter((c) => c.sql.includes('rollup_hourly_stats'));
    for (const call of testReads) {
      expect(call.params).toContain(true);
    }
  });
});

describe('DashboardService.getServicePerformance (§9.10, F-16.a–d)', () => {
  it('aggregates the f16_* rollup rows into exact F-16 figures per Service', async () => {
    const pool = new FnPool();
    pool
      .on(SQL.performance, [
        {
          service_id: SERVICE_A,
          dimension_kind: 'f16_cohort',
          metrics_json: {
            booked: 10,
            delivered: 7,
            rto_delivered: 2,
            lost_or_damaged: 1,
            cancelled_by_courier: 0,
            void: 0,
            open: 0,
          },
        },
        {
          service_id: SERVICE_A,
          dimension_kind: 'f16_cohort',
          metrics_json: {
            booked: 5,
            delivered: 1,
            rto_delivered: 0,
            lost_or_damaged: 0,
            cancelled_by_courier: 0,
            void: 1,
            open: 3,
          },
        },
        {
          service_id: SERVICE_A,
          dimension_kind: 'f16_ndr',
          metrics_json: { shipments_with_ndr: 3 },
        },
        {
          service_id: SERVICE_A,
          dimension_kind: 'f16_pickup',
          metrics_json: { picked_up: 12 },
        },
        {
          service_id: SERVICE_A,
          dimension_kind: 'f16_delivery',
          metrics_json: { delivered: 8, tat_count: 4, tat_hours_sum: 100 },
        },
      ])
      .on(SQL.serviceNames, [
        { service_id: SERVICE_A, name: 'Delhivery Surface', courier_code: 'DELHIVERY' },
      ]);
    const service = new DashboardService(pool.asPool());

    const [row] = await service.getServicePerformance(SHOP_ID, 'live', 30, NOW);

    expect(row.serviceId).toBe(SERVICE_A);
    expect(row.booked).toBe(15);
    // Open shipments shown separately — in neither F-16.a term (§4.10).
    expect(row.open).toBe(3);
    expect(row.delivered).toBe(8);
    expect(row.rtoDelivered).toBe(2);
    // Terminal = DELIVERED + RTO_DELIVERED + LOST_OR_DAMAGED + CANCELLED_BY_COURIER.
    expect(row.terminal).toBe(11);
    // F-16.a = 8 ÷ (8 + 2) — the 3 open shipments enter neither term.
    expect(row.deliveryRate).toBe(0.8);
    // F-16.b = 3 ÷ 12.
    expect(row.ndrRate).toBe(0.25);
    // F-16.c = 2 ÷ 11.
    expect(row.rtoRate).toBeCloseTo(2 / 11, 10);
    // F-16.d = 100 ÷ 4 calendar hours.
    expect(row.avgTatHours).toBe(25);
    expect(row.serviceName).toBe('Delhivery Surface');

    // Rollups only, live side, 30-day window.
    const call = pool.matching(SQL.performance)[0];
    expect(call.sql).toContain('rollup_hourly_stats');
    expect(call.params[1]).toBe(false);
    expect(Date.parse(call.params[3] as string) - Date.parse(call.params[2] as string)).toBe(
      30 * 24 * 3600_000,
    );
  });

  it('returns null rates for empty denominators, never fake zeros', async () => {
    const pool = new FnPool();
    pool.on(SQL.performance, [
      {
        service_id: SERVICE_B,
        dimension_kind: 'f16_cohort',
        metrics_json: {
          booked: 4,
          delivered: 0,
          rto_delivered: 0,
          lost_or_damaged: 0,
          cancelled_by_courier: 0,
          void: 0,
          open: 4,
        },
      },
    ]);
    const service = new DashboardService(pool.asPool());

    const [row] = await service.getServicePerformance(SHOP_ID, 'live', 7, NOW);
    expect(row.deliveryRate).toBeNull();
    expect(row.ndrRate).toBeNull();
    expect(row.rtoRate).toBeNull();
    expect(row.avgTatHours).toBeNull();
    expect(row.open).toBe(4);
  });
});

describe('DashboardService.getTrend (§9.10 30-day trend)', () => {
  it('reads the zero-filled daily series from rollups only', async () => {
    const pool = new FnPool();
    pool.on(SQL.shopTz, [{ iana_timezone: 'Asia/Kolkata' }]).on(SQL.trend, [
      { day: '2026-07-03', booked: 2, delivered: 0 },
      { day: '2026-07-04', booked: 0, delivered: 3 },
    ]);
    const service = new DashboardService(pool.asPool());

    const trend = await service.getTrend(SHOP_ID, 'live', 30, undefined, NOW);

    expect(trend).toEqual([
      { date: '2026-07-03', booked: 2, delivered: 0 },
      { date: '2026-07-04', booked: 0, delivered: 3 },
    ]);
    const call = pool.matching(SQL.trend)[0];
    expect(call.sql).toContain('rollup_hourly_stats');
    expect(call.sql).toContain('generate_series'); // zero-filled days
    expect(call.sql).toContain('AT TIME ZONE'); // shop-local days (§5.2)
    expect(call.params[0]).toBe(SHOP_ID);
    expect(call.params[1]).toBe('Asia/Kolkata');
    expect(call.params[2]).toBe(false); // live side by default (§9.23)
    expect(call.params[4]).toBe(30);
  });
});
