import { describe, expect, it } from 'vitest';
import { RollupService } from '../../src/modules/dashboard/rollup.service';
import { TrackingDelayService } from '../../src/modules/tracking/tracking-delay.service';
import { ReconDisputesProvider } from '../../src/modules/dashboard/recon-disputes';
import { FnPool, OTHER_SHOP_ID, SERVICE_A, SERVICE_B, SHOP_ID, SQL } from './helpers';

/**
 * The hourly rollup writer (§5.7, §2.8): per-dimension rollup math, the
 * (shop_id, hour_start_utc, dimension_json) UPSERT, and INV-19 test
 * exclusion in both directions.
 */

const HOUR = new Date('2026-08-01T10:00:00.000Z');
const NOW = new Date('2026-08-01T10:20:00.000Z');

function delayStub(count: number): TrackingDelayService {
  const rows = Array.from({ length: count }, (_, i) => ({ shipment_id: `s-${i}` }));
  return {
    listDelayed: () => Promise.resolve(rows),
  } as unknown as TrackingDelayService;
}

function reconStub(count: number): ReconDisputesProvider {
  return { countOpenDisputes: () => Promise.resolve(count) };
}

interface UpsertedRow {
  hour: string;
  dimension: Record<string, unknown>;
  metrics: Record<string, unknown>;
}

function upsertedRows(pool: FnPool): UpsertedRow[] {
  const out: UpsertedRow[] = [];
  for (const call of pool.matching(SQL.upsert)) {
    const [, hours, dims, mets] = call.params as [string, string[], string[], string[], string];
    hours.forEach((hour, i) =>
      out.push({
        hour,
        dimension: JSON.parse(dims[i]) as Record<string, unknown>,
        metrics: JSON.parse(mets[i]) as Record<string, unknown>,
      }),
    );
  }
  return out;
}

function findRow(
  rows: UpsertedRow[],
  dimension: Record<string, unknown>,
): UpsertedRow | undefined {
  return rows.find((r) =>
    Object.entries(dimension).every(([k, v]) => r.dimension[k] === v),
  );
}

describe('RollupService.computeHourRollup (§5.7, §2.8)', () => {
  it('rolls up every §9.10 action card from its stored condition (RV-03), live + test sides', async () => {
    const pool = new FnPool();
    pool
      .on(SQL.cardNewToBook, [
        { t: false, count: 4 },
        { t: true, count: 1 },
      ])
      .on(SQL.cardNdr, [{ t: false, count: 7 }])
      .on(SQL.cardPickupPending, [{ t: false, count: 3 }])
      .on(SQL.cardManual, [{ t: false, count: 2 }])
      .on(SQL.cardCourier, [{ t: false, count: 1 }])
      .on(SQL.cardCod, [{ t: false, count: 5 }])
      .on(SQL.cardInvoice, [{ t: false, count: 6 }]);
    const service = new RollupService(pool.asPool(), delayStub(11), reconStub(9));

    await service.computeHourRollup(SHOP_ID, HOUR, NOW);

    const rows = upsertedRows(pool);
    // Nine cards × two sides (live/test) = 18 card rows.
    const cardRows = rows.filter((r) => r.dimension.kind === 'card');
    expect(cardRows).toHaveLength(18);

    expect(findRow(rows, { kind: 'card', card: 'new_to_book', test: false })?.metrics.count).toBe(4);
    expect(findRow(rows, { kind: 'card', card: 'new_to_book', test: true })?.metrics.count).toBe(1);
    expect(findRow(rows, { kind: 'card', card: 'ndr_open', test: false })?.metrics.count).toBe(7);
    expect(findRow(rows, { kind: 'card', card: 'ndr_open', test: true })?.metrics.count).toBe(0);
    expect(findRow(rows, { kind: 'card', card: 'pickup_pending', test: false })?.metrics.count).toBe(3);
    expect(findRow(rows, { kind: 'card', card: 'manual_assignment', test: false })?.metrics.count).toBe(2);
    expect(findRow(rows, { kind: 'card', card: 'courier_disconnected', test: false })?.metrics.count).toBe(1);
    expect(findRow(rows, { kind: 'card', card: 'cod_unassigned', test: false })?.metrics.count).toBe(5);
    expect(findRow(rows, { kind: 'card', card: 'invoice_issue_pending', test: false })?.metrics.count).toBe(6);
    // delayed comes from the tracking module's S-47 listDelayed; recon from the provider seam.
    expect(findRow(rows, { kind: 'card', card: 'delayed', test: false })?.metrics.count).toBe(11);
    expect(findRow(rows, { kind: 'card', card: 'delayed', test: true })?.metrics.count).toBe(0);
    expect(findRow(rows, { kind: 'card', card: 'recon_disputes_open', test: false })?.metrics.count).toBe(9);
    expect(findRow(rows, { kind: 'card', card: 'recon_disputes_open', test: true })?.metrics.count).toBe(0);

    // Every card row is stamped with the computed hour.
    for (const r of cardRows) expect(r.hour).toBe(HOUR.toISOString());
  });

  it('asserts each card query reads its STORED column, never derived text (RV-03)', async () => {
    const pool = new FnPool();
    const service = new RollupService(pool.asPool(), delayStub(0), reconStub(0));
    await service.computeHourRollup(SHOP_ID, HOUR, NOW);

    expect(pool.matching(SQL.cardNewToBook)[0].sql).toContain("o.order_state = 'READY'");
    expect(pool.matching(SQL.cardNewToBook)[0].sql).toContain("s.booking_state = 'DRAFT'");
    expect(pool.matching(SQL.cardNdr)[0].sql).toContain("nc.state <> 'CLOSED'");
    expect(pool.matching(SQL.cardPickupPending)[0].sql).toContain("s.custody_state = 'PICKUP_PENDING'");
    expect(pool.matching(SQL.cardManual)[0].sql).toContain("s.booking_state = 'NEEDS_MANUAL_ASSIGNMENT'");
    expect(pool.matching(SQL.cardCourier)[0].sql).toContain("ca.health_state = 'DISCONNECTED'");
    expect(pool.matching(SQL.cardCod)[0].sql).toContain('o.cod_assignment_state = \'UNASSIGNED\'');
    expect(pool.matching(SQL.cardInvoice)[0].sql).toContain("gi.state = 'ISSUE_PENDING'");
  });

  it('excludes test shipments from live figures and keeps a separate test side (INV-19)', async () => {
    const pool = new FnPool();
    const service = new RollupService(pool.asPool(), delayStub(0), reconStub(0));
    await service.computeHourRollup(SHOP_ID, HOUR, NOW);

    // Every base-table figure query groups by the test flag so the live
    // side is structurally test-free (INV-19, both directions).
    const figureQueries = [
      ...pool.matching(SQL.cardNewToBook),
      ...pool.matching(SQL.cardNdr),
      ...pool.matching(SQL.cardPickupPending),
      ...pool.matching(SQL.cardManual),
      ...pool.matching(SQL.cardCod),
      ...pool.matching(SQL.byMovement),
      ...pool.matching(SQL.byBooking),
      ...pool.matching(SQL.byPayment),
      ...pool.matching(SQL.byService),
      ...pool.matching(SQL.serviceMovement),
      ...pool.matching(SQL.cohort),
      ...pool.matching(SQL.ndrEvents),
      ...pool.matching(SQL.pickupEvents),
      ...pool.matching(SQL.deliveryEvents),
    ];
    expect(figureQueries.length).toBeGreaterThanOrEqual(14);
    for (const call of figureQueries) {
      expect(call.sql).toMatch(/is_test/);
    }
    // No figure query ever uses a derived text expression for the card
    // conditions (spot-check: no LIKE / ILIKE anywhere in the rollup SQL).
    for (const call of pool.calls) {
      expect(call.sql).not.toMatch(/ILIKE/i);
    }
  });

  it('computes the F-16 booked cohort per dimension with exact metric mapping', async () => {
    const pool = new FnPool();
    pool.on(SQL.cohort, [
      {
        hour_start_utc: HOUR,
        t: false,
        service_id: SERVICE_A,
        booked: 10,
        delivered: 7,
        rto_delivered: 2,
        lost_or_damaged: 1,
        cancelled_by_courier: 0,
        void: 0,
        open: 0,
      },
      {
        hour_start_utc: HOUR,
        t: true,
        service_id: SERVICE_A,
        booked: 3,
        delivered: 1,
        rto_delivered: 0,
        lost_or_damaged: 0,
        cancelled_by_courier: 0,
        void: 0,
        open: 2,
      },
    ]);
    const service = new RollupService(pool.asPool(), delayStub(0), reconStub(0));
    await service.computeHourRollup(SHOP_ID, HOUR, NOW);

    const rows = upsertedRows(pool);
    const live = findRow(rows, { kind: 'f16_cohort', serviceId: SERVICE_A, test: false });
    expect(live?.metrics).toEqual({
      booked: 10,
      delivered: 7,
      rto_delivered: 2,
      lost_or_damaged: 1,
      cancelled_by_courier: 0,
      void: 0,
      open: 0,
    });
    // The cohort SQL is booked-cohort math: FILTERs on the stored
    // movement states, booked_at hour attribution (§5.2).
    const sql = pool.matching(SQL.cohort)[0].sql;
    expect(sql).toContain("count(*) FILTER (WHERE s.movement_state = 'DELIVERED')");
    expect(sql).toContain("count(*) FILTER (WHERE s.movement_state = 'RTO_DELIVERED')");
    expect(sql).toContain("date_trunc('hour', s.booked_at)");
    // Open = booked, not VOID, not in any terminal §3.4 state.
    expect(sql).toContain(
      "'DELIVERED', 'RTO_DELIVERED', 'LOST_OR_DAMAGED', 'CANCELLED_BY_COURIER'",
    );
  });

  it('computes F-16.b/d event inputs attributed per §5.2', async () => {
    const pool = new FnPool();
    pool
      .on(SQL.ndrEvents, [
        { hour_start_utc: HOUR, t: false, service_id: SERVICE_A, shipments_with_ndr: 4 },
      ])
      .on(SQL.pickupEvents, [
        { hour_start_utc: HOUR, t: false, service_id: SERVICE_A, picked_up: 12 },
      ])
      .on(SQL.deliveryEvents, [
        {
          hour_start_utc: HOUR,
          t: false,
          service_id: SERVICE_B,
          delivered: 5,
          tat_count: 4,
          tat_hours_sum: 100.5,
        },
      ]);
    const service = new RollupService(pool.asPool(), delayStub(0), reconStub(0));
    await service.computeHourRollup(SHOP_ID, HOUR, NOW);

    const rows = upsertedRows(pool);
    expect(
      findRow(rows, { kind: 'f16_ndr', serviceId: SERVICE_A, test: false })?.metrics,
    ).toEqual({ shipments_with_ndr: 4 });
    expect(
      findRow(rows, { kind: 'f16_pickup', serviceId: SERVICE_A, test: false })?.metrics,
    ).toEqual({ picked_up: 12 });
    expect(
      findRow(rows, { kind: 'f16_delivery', serviceId: SERVICE_B, test: false })?.metrics,
    ).toEqual({ delivered: 5, tat_count: 4, tat_hours_sum: 100.5 });

    // F-16.b numerator counts DISTINCT shipments with ≥1 NDR at the
    // first-NDR hour (§5.2 attribution).
    expect(pool.matching(SQL.ndrEvents)[0].sql).toContain('count(DISTINCT nc.shipment_id)');
    // F-16.d: calendar hours from PICKED_UP to DELIVERED occurred-at.
    const deliverySql = pool.matching(SQL.deliveryEvents)[0].sql;
    expect(deliverySql).toContain("te.carrier_event_status = 'PICKED_UP'");
    expect(deliverySql).toContain("te.carrier_event_status = 'DELIVERED'");
    expect(deliverySql).toContain('EXTRACT(EPOCH FROM (d.delivered_at - fp.picked_at)) / 3600.0');
  });

  it('UPSERTs keyed (shop_id, hour_start_utc, dimension_json), shop-scoped (INV-1)', async () => {
    const pool = new FnPool();
    const service = new RollupService(pool.asPool(), delayStub(0), reconStub(0));
    await service.computeHourRollup(SHOP_ID, HOUR, NOW);

    const upserts = pool.matching(SQL.upsert);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].sql).toContain(
      'ON CONFLICT (shop_id, hour_start_utc, dimension_json) DO UPDATE',
    );
    expect(upserts[0].sql).toContain('metrics_json = EXCLUDED.metrics_json');
    expect(upserts[0].params[0]).toBe(SHOP_ID);
    // Every base-table query carries the shop scope as $1.
    for (const call of pool.calls) {
      if (SQL.upsert.test(call.sql)) continue;
      expect(call.params[0]).toBe(SHOP_ID);
    }
  });
});

describe('RollupService.restateWindow (§5.2 restatement)', () => {
  it('restates cohort and event rows over a trailing window', async () => {
    const pool = new FnPool();
    pool.on(SQL.cohort, [
      {
        hour_start_utc: new Date('2026-07-30T08:00:00.000Z'),
        t: false,
        service_id: SERVICE_A,
        booked: 6,
        delivered: 5,
        rto_delivered: 1,
        lost_or_damaged: 0,
        cancelled_by_courier: 0,
        void: 0,
        open: 0,
      },
    ]);
    const service = new RollupService(pool.asPool(), delayStub(0), reconStub(0));
    const from = new Date('2026-07-02T00:00:00.000Z');

    await service.restateWindow(SHOP_ID, from, NOW);

    // Restatement touches the event/cohort families only — no snapshot queries.
    expect(pool.matching(SQL.cardNdr)).toHaveLength(0);
    expect(pool.matching(SQL.byMovement)).toHaveLength(0);
    for (const sql of [SQL.cohort, SQL.ndrEvents, SQL.pickupEvents, SQL.deliveryEvents]) {
      const calls = pool.matching(sql);
      expect(calls).toHaveLength(1);
      expect(calls[0].params[1]).toBe(from.toISOString());
      expect(calls[0].params[2]).toBe(NOW.toISOString());
    }
    // The older cohort row is restated under ITS OWN booked hour.
    const rows = upsertedRows(pool);
    const cohort = findRow(rows, { kind: 'f16_cohort', serviceId: SERVICE_A, test: false });
    expect(cohort?.hour).toBe('2026-07-30T08:00:00.000Z');
    expect(cohort?.metrics.delivered).toBe(5);
  });
});

describe('RollupService.runHourlySweep (the plain body of the BullMQ job)', () => {
  it('fans out per shop and restates the trailing cohort window', async () => {
    const pool = new FnPool();
    pool.on(SQL.shops, [{ shop_id: SHOP_ID }, { shop_id: OTHER_SHOP_ID }]);
    const service = new RollupService(pool.asPool(), delayStub(0), reconStub(0));

    const result = await service.runHourlySweep(NOW);

    expect(result).toEqual({ shops: 2, failed: 0 });
    // Two shops × (current-hour compute + window restatement) = 4 cohort queries.
    expect(pool.matching(SQL.cohort)).toHaveLength(4);
    const shops = new Set(pool.matching(SQL.cohort).map((c) => c.params[0]));
    expect(shops).toEqual(new Set([SHOP_ID, OTHER_SHOP_ID]));
    // The restatement window reaches back COHORT_RESTATEMENT_DAYS.
    const windows = pool.matching(SQL.cohort).map((c) => ({
      from: Date.parse(c.params[1] as string),
      to: Date.parse(c.params[2] as string),
    }));
    const restated = windows.filter((w) => w.to - w.from > 24 * 3600_000);
    expect(restated).toHaveLength(2);
    for (const w of restated) {
      expect(w.to - w.from).toBeGreaterThanOrEqual(30 * 24 * 3600_000);
    }
    // The hourly compute stamps the hour containing `now`.
    const hours = new Set(
      upsertedRows(pool)
        .filter((r) => r.dimension.kind === 'card')
        .map((r) => r.hour),
    );
    expect(hours).toEqual(new Set(['2026-08-01T10:00:00.000Z']));
  });

  it('logs and continues when one shop fails (per-shop isolation)', async () => {
    const pool = new FnPool();
    pool.on(SQL.shops, [{ shop_id: SHOP_ID }, { shop_id: OTHER_SHOP_ID }]);
    pool.onFn(SQL.cardNdr, (_sql, params) => {
      if (params[0] === OTHER_SHOP_ID) throw new Error('boom');
      return undefined;
    });
    const service = new RollupService(pool.asPool(), delayStub(0), reconStub(0));

    const result = await service.runHourlySweep(NOW);

    expect(result).toEqual({ shops: 2, failed: 1 });
    // The healthy shop still computed its cards.
    const liveShopCards = upsertedRows(pool).filter(
      (r) => r.dimension.kind === 'card',
    );
    expect(liveShopCards.length).toBe(18);
  });
});
