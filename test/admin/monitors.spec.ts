import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { BookingFailureMonitorService } from '../../src/modules/admin/booking-failure-monitor.service';
import { CourierApiMonitorService } from '../../src/modules/admin/courier-api-monitor.service';
import { TrackingDelayService } from '../../src/modules/tracking/tracking-delay.service';
import { makePool, poolCalls } from './helpers';

/**
 * ADD-32 booking failure monitor + §9.13 courier API error monitor:
 * grouping math — the right sources, windows, group-bys and exclusions.
 */

describe('BookingFailureMonitorService.failuresByReason (ADD-32)', () => {
  it('unions the three sources with per-source reason codes and courier join', async () => {
    const { pool } = makePool(() => ({ rows: [], rowCount: 0 }));
    const svc = new BookingFailureMonitorService(pool as unknown as Pool);
    await svc.failuresByReason(120);
    const call = poolCalls(pool)[0];

    // Source 1: booking_intent FAILED / UNKNOWN joined to shipment via the
    // composite FK, courier via courier_account.
    expect(call.sql).toContain('FROM booking_intent bi');
    expect(call.sql).toContain("bi.outcome IN ('FAILED', 'UNKNOWN')");
    expect(call.sql).toContain('ON s.shipment_id = bi.shipment_id AND s.created_at = bi.shipment_created_at');
    // Source 2: shipment booking_state FAILED.
    expect(call.sql).toContain("s.booking_state = 'FAILED'");
    expect(call.sql).toContain("'BOOKING_FAILED'");
    // Source 3: §3.30 manual_assignment_reason distribution.
    expect(call.sql).toContain("s.booking_state = 'NEEDS_MANUAL_ASSIGNMENT'");
    expect(call.sql).toContain('s.manual_assignment_reason IS NOT NULL');
    // Grouping math: failures + shops_affected + recency per reason × courier.
    expect(call.sql.match(/UNION ALL/g)).toHaveLength(2);
    expect(call.sql).toContain('count(DISTINCT s.shop_id)::int AS shops_affected');
    // Platform-wide across ALL merchants (no shop_id WHERE filter), windowed,
    // test shipments excluded (INV-19).
    expect(call.sql).not.toMatch(/WHERE[^)]*shop_id = \$/);
    expect(call.sql).toContain('s.is_test = false');
    expect(call.params).toEqual(['120']);
    expect(call.sql).toContain("($1 || ' minutes')::interval");
  });

  it('clamps the window to at most 7 days', async () => {
    const { pool } = makePool(() => ({ rows: [], rowCount: 0 }));
    const svc = new BookingFailureMonitorService(pool as unknown as Pool);
    await svc.failuresByReason(999999);
    expect(poolCalls(pool)[0].params).toEqual(['10080']);
  });
});

describe('BookingFailureMonitorService.spikeView (ADD-32 spike view)', () => {
  it('groups count by reason × courier by hour over the last 24h by default', async () => {
    const { pool } = makePool(() => ({ rows: [], rowCount: 0 }));
    const svc = new BookingFailureMonitorService(pool as unknown as Pool);
    await svc.spikeView();
    const call = poolCalls(pool)[0];
    expect(call.sql).toContain("date_trunc('hour', bi.created_at)");
    expect(call.sql).toContain('GROUP BY hour_start_utc, courier_code, reason_code');
    expect(call.sql).toContain("($1 || ' hours')::interval");
    expect(call.params).toEqual(['24']);
  });
});

describe('CourierApiMonitorService (§9.13)', () => {
  it('aggregates non-SUCCESS courier_api_call outcomes per courier × method', async () => {
    const { pool } = makePool(() => ({ rows: [], rowCount: 0 }));
    const tracking = { listUnmappedStatuses: async () => [] };
    const svc = new CourierApiMonitorService(
      pool as unknown as Pool,
      tracking as unknown as TrackingDelayService,
    );
    await svc.failuresPerCourier(48);
    const call = poolCalls(pool)[0];
    expect(call.sql).toContain('FROM courier_api_call cac');
    expect(call.sql).toContain("cac.outcome <> 'SUCCESS'");
    expect(call.sql).toContain('GROUP BY c.code, cac.method, cac.outcome');
    expect(call.params).toEqual(['48']);
  });

  it('delegates the unmapped-status feed to the tracking read model (§3.6)', async () => {
    const { pool } = makePool();
    const rows = [{ courier_code: 'dtdc', raw_status: 'bag received', occurrences: 9, shops_affected: 2, last_seen_at: 'x' }];
    const tracking = { listUnmappedStatuses: async (courierId?: string) => (courierId === 'c1' ? rows : []) };
    const svc = new CourierApiMonitorService(
      pool as unknown as Pool,
      tracking as unknown as TrackingDelayService,
    );
    expect(await svc.unmappedStatuses('c1')).toBe(rows);
  });
});
