import { describe, expect, it } from 'vitest';
import {
  DELAY_THRESHOLD_MS,
  TrackingDelayService,
} from '../../src/modules/tracking/tracking-delay.service';
import { COURIER_ID, FnPool, SHIPMENT_ID, SHOP_ID } from './helpers';

/**
 * S-47 delayed shipments (EDD exceeded by >24h, non-terminal) and the
 * §3.6/§9.13 unmapped-status monitor feed.
 */

const DELAYED_SQL = /SELECT s\.shipment_id, s\.order_id, s\.awb_normalized/;
const UNMAPPED_SQL = /FROM tracking_event te\s+JOIN shipment s/;

const NOW = new Date('2026-08-01T18:00:00.000Z');

describe('TrackingDelayService.listDelayed (S-47)', () => {
  it('lists non-terminal live shipments whose snapshot EDD is >24h past', async () => {
    const pool = new FnPool();
    pool.on(DELAYED_SQL, [
      {
        shipment_id: SHIPMENT_ID,
        order_id: 'order-1',
        awb_normalized: 'DL12345',
        movement_state: 'IN_TRANSIT',
        edd_to: '2026-07-30T18:00:00.000Z',
        booked_at: '2026-07-28T10:00:00.000Z',
      },
    ]);
    const service = new TrackingDelayService(pool.asPool());

    const rows = await service.listDelayed(SHOP_ID, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0].shipment_id).toBe(SHIPMENT_ID);
    const call = pool.matching(DELAYED_SQL)[0];
    // Shop-scoped (INV-1) and the S-47 cutoff is exactly now − 24h.
    expect(call.params[0]).toBe(SHOP_ID);
    expect(call.params[1]).toBe(new Date(NOW.getTime() - DELAY_THRESHOLD_MS).toISOString());
    expect(DELAY_THRESHOLD_MS).toBe(24 * 3600_000);
    // EDD from the frozen snapshot (INV-8), terminal states + test excluded.
    expect(call.sql).toContain("snapshot -> 'quote' ->> 'eddTo'");
    expect(call.sql).toContain('is_test = false');
    expect(call.sql).toContain("'DELIVERED', 'RTO_DELIVERED', 'LOST_OR_DAMAGED', 'CANCELLED_BY_COURIER'");
  });
});

describe('TrackingDelayService.listUnmappedStatuses (§3.6 → §9.13 monitor)', () => {
  it('groups unmapped raw statuses per courier for the error monitor', async () => {
    const pool = new FnPool();
    pool.on(UNMAPPED_SQL, [
      {
        courier_code: 'DELHIVERY',
        raw_status: 'Bag Received at Facility',
        occurrences: 17,
        shops_affected: 3,
        last_seen_at: '2026-08-01T11:00:00.000Z',
      },
    ]);
    const service = new TrackingDelayService(pool.asPool());

    const rows = await service.listUnmappedStatuses(COURIER_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0].courier_code).toBe('DELHIVERY');
    const call = pool.matching(UNMAPPED_SQL)[0];
    expect(call.params[0]).toBe(COURIER_ID);
    expect(call.sql).toContain('te.carrier_event_status IS NULL');
  });

  it('passes a NULL courier filter for the platform-wide admin view', async () => {
    const pool = new FnPool();
    pool.on(UNMAPPED_SQL, []);
    const service = new TrackingDelayService(pool.asPool());

    await service.listUnmappedStatuses();

    expect(pool.matching(UNMAPPED_SQL)[0].params[0]).toBeNull();
  });
});
