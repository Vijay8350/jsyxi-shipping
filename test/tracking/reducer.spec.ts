import { describe, expect, it, vi } from 'vitest';
import {
  EVENT_TO_MOVEMENT,
  MovementReducerService,
  decideTransition,
} from '../../src/modules/tracking/movement-reducer.service';
import type { SyncBackService } from '../../src/modules/sync-back/sync-back.service';
import type { TrackingSeams } from '../../src/modules/tracking/tracking-seams';
import type { CarrierEventStatus, MovementState } from '../../src/modules/tracking/tracking.types';
import { EVENT_ID, FnPool, SHIPMENT_ID, SHOP_ID, shipmentRow } from './helpers';

/**
 * The §3.4 reducer: every event → state table row, INV-17 terminal-not-
 * regressed with review flag, §3.3 PICKED_UP custody (incl. the A1-04
 * CANCEL_REQUESTED race), INV-22 version-mismatch re-apply, DELIVERED
 * delivered_at + seams + §8.4 fulfillment enqueue.
 */

const LOAD = /SELECT shipment_id, shop_id, order_id, movement_state/;
const UPDATE = /UPDATE shipment\s+SET movement_state/;
const REVIEW = /UPDATE tracking_event SET review_flag/;

function mk(pool: FnPool) {
  const syncBack = { enqueueFulfillmentEvent: vi.fn().mockResolvedValue(undefined) };
  const seams = { onDelivered: vi.fn().mockResolvedValue(undefined), onNdr: vi.fn().mockResolvedValue(undefined) };
  const reducer = new MovementReducerService(
    pool.asPool(),
    syncBack as unknown as SyncBackService,
    seams as unknown as TrackingSeams,
  );
  return { reducer, syncBack, seams };
}

const OCCURRED = '2026-08-01T12:00:00.000Z';

function apply(
  reducer: MovementReducerService,
  status: CarrierEventStatus,
  occurredAt = OCCURRED,
) {
  return reducer.applyEvent({
    shopId: SHOP_ID,
    shipmentId: SHIPMENT_ID,
    eventId: EVENT_ID,
    status,
    occurredAt,
  });
}

describe('§3.4 event → state table (every row)', () => {
  const table: Array<[CarrierEventStatus, MovementState]> = [
    ['PICKUP_SCHEDULED', 'IN_TRANSIT'],
    ['PICKED_UP', 'IN_TRANSIT'],
    ['IN_TRANSIT', 'IN_TRANSIT'],
    ['OUT_FOR_DELIVERY', 'OUT_FOR_DELIVERY'],
    ['UNDELIVERED_ATTEMPT', 'NDR'],
    ['DELIVERED', 'DELIVERED'],
    ['RTO_INITIATED', 'RTO_INITIATED'],
    ['RTO_IN_TRANSIT', 'RTO_IN_TRANSIT'],
    ['RTO_OUT_FOR_DELIVERY', 'RTO_OUT_FOR_DELIVERY'],
    ['RTO_DELIVERED', 'RTO_DELIVERED'],
    ['LOST_OR_DAMAGED', 'LOST_OR_DAMAGED'],
    ['CANCELLED_BY_COURIER', 'CANCELLED_BY_COURIER'],
  ];

  it.each(table)('%s → %s', (status, expected) => {
    expect(EVENT_TO_MOVEMENT[status]).toBe(expected);
    const d = decideTransition(
      { movement_state: 'NOT_SHIPPED', custody_state: 'IN_CUSTODY', delivered_at: null },
      status,
    );
    expect(d.targetMovement).toBe(expected);
    expect(d.movementChanges).toBe(true);
  });
});

describe('MovementReducerService.applyEvent', () => {
  it('applies a transition under the shipment version check (INV-22)', async () => {
    const pool = new FnPool();
    pool.on(LOAD, [shipmentRow({ version: 7 })]);
    pool.on(UPDATE, [], 1);
    const { reducer, syncBack } = mk(pool);

    const outcome = await apply(reducer, 'OUT_FOR_DELIVERY');

    expect(outcome.stateChanged).toBe(true);
    expect(outcome.movementState).toBe('OUT_FOR_DELIVERY');
    const update = pool.matching(UPDATE)[0];
    expect(update.params[6]).toBe(7); // conditional on the version we read
    expect(update.params[2]).toBe('OUT_FOR_DELIVERY');
    expect(syncBack.enqueueFulfillmentEvent).toHaveBeenCalledWith(
      SHOP_ID,
      SHIPMENT_ID,
      'OUT_FOR_DELIVERY',
    );
  });

  it('same-state event is stored but changes nothing and enqueues nothing', async () => {
    const pool = new FnPool();
    pool.on(LOAD, [shipmentRow({ movement_state: 'IN_TRANSIT' })]);
    const { reducer, syncBack } = mk(pool);

    const outcome = await apply(reducer, 'IN_TRANSIT');

    expect(outcome.stateChanged).toBe(false);
    expect(pool.matching(UPDATE)).toEqual([]);
    expect(syncBack.enqueueFulfillmentEvent).not.toHaveBeenCalled();
  });

  it('INV-17: a terminal state is never regressed — event flagged, state untouched', async () => {
    const pool = new FnPool();
    pool.on(LOAD, [shipmentRow({ movement_state: 'DELIVERED', delivered_at: OCCURRED })]);
    const { reducer, syncBack } = mk(pool);

    const outcome = await apply(reducer, 'IN_TRANSIT');

    expect(outcome.stateChanged).toBe(false);
    expect(outcome.reviewFlag).toBe(true);
    expect(outcome.reviewReason).toContain('INV-17');
    // The event row is review-flagged; the shipment is never written.
    expect(pool.matching(REVIEW)[0].params[0]).toBe(EVENT_ID);
    expect(pool.matching(UPDATE)).toEqual([]);
    expect(syncBack.enqueueFulfillmentEvent).not.toHaveBeenCalled();
  });

  it('INV-17: RTO_IN_TRANSIT after DELIVERED is also a regression, not a transition', async () => {
    const pool = new FnPool();
    pool.on(LOAD, [shipmentRow({ movement_state: 'DELIVERED', delivered_at: OCCURRED })]);
    const { reducer } = mk(pool);

    const outcome = await apply(reducer, 'RTO_IN_TRANSIT');

    expect(outcome.stateChanged).toBe(false);
    expect(outcome.reviewFlag).toBe(true);
    expect(pool.matching(UPDATE)).toEqual([]);
  });

  it('a repeat of the same terminal status is stored without a review flag', async () => {
    const pool = new FnPool();
    pool.on(LOAD, [shipmentRow({ movement_state: 'DELIVERED', delivered_at: OCCURRED })]);
    const { reducer } = mk(pool);

    const outcome = await apply(reducer, 'DELIVERED');

    expect(outcome.stateChanged).toBe(false);
    expect(outcome.reviewFlag).toBe(false);
    expect(pool.matching(REVIEW)).toEqual([]);
  });

  it('§3.3: PICKED_UP moves custody PICKUP_PENDING → IN_CUSTODY', async () => {
    const pool = new FnPool();
    pool.on(LOAD, [shipmentRow({ custody_state: 'PICKUP_PENDING' })]);
    pool.on(UPDATE, [], 1);
    const { reducer } = mk(pool);

    const outcome = await apply(reducer, 'PICKED_UP');

    expect(outcome.stateChanged).toBe(true);
    expect(outcome.reviewFlag).toBe(false);
    const update = pool.matching(UPDATE)[0];
    expect(update.params[3]).toBe('IN_CUSTODY'); // custody_target
    expect(update.params[2]).toBe('IN_TRANSIT'); // movement per §3.4
  });

  it('§3.3 race: PICKED_UP while CANCEL_REQUESTED → IN_CUSTODY, review flag, no reversal', async () => {
    const pool = new FnPool();
    pool.on(LOAD, [shipmentRow({ custody_state: 'CANCEL_REQUESTED', movement_state: 'NOT_SHIPPED' })]);
    pool.on(UPDATE, [], 1);
    const { reducer, syncBack } = mk(pool);

    const outcome = await apply(reducer, 'PICKED_UP');

    expect(outcome.stateChanged).toBe(true);
    expect(outcome.reviewFlag).toBe(true);
    expect(outcome.reviewReason).toContain('race');
    expect(outcome.reviewReason).toContain('no entitlement reversal');
    expect(pool.matching(REVIEW)[0].params[0]).toBe(EVENT_ID);
    expect(pool.matching(UPDATE)[0].params[3]).toBe('IN_CUSTODY');
    // Point of no return: no cancellation/VOID write, only the movement write.
    expect(pool.matching(/booking_state/)).toEqual([]);
    expect(syncBack.enqueueFulfillmentEvent).toHaveBeenCalledWith(SHOP_ID, SHIPMENT_ID, 'PICKED_UP');
  });

  it('INV-22: a version mismatch re-reads and re-applies, never last-write-wins', async () => {
    const pool = new FnPool();
    // First read: version 1, NOT_SHIPPED. Concurrent writer wins the update.
    // Second read: version 2, already IN_TRANSIT — re-decide from fresh state.
    let loads = 0;
    pool.onFn(LOAD, () => {
      loads += 1;
      return loads === 1
        ? { rows: [shipmentRow({ version: 1 })], rowCount: 1 }
        : { rows: [shipmentRow({ version: 2, movement_state: 'IN_TRANSIT' })], rowCount: 1 };
    });
    let updates = 0;
    pool.onFn(UPDATE, () => {
      updates += 1;
      return { rows: [], rowCount: updates === 1 ? 0 : 1 };
    });
    const { reducer } = mk(pool);

    const outcome = await apply(reducer, 'IN_TRANSIT');

    expect(loads).toBe(2);
    // One lost conditional update; the re-read shows the fresh state is
    // already IN_TRANSIT, so the re-applied decision writes nothing more.
    expect(updates).toBe(1);
    expect(outcome.stateChanged).toBe(false);
    expect(outcome.movementState).toBe('IN_TRANSIT');
  });

  it('DELIVERED sets delivered_at and fires the recon COD seam (onDelivered)', async () => {
    const pool = new FnPool();
    pool.on(LOAD, [shipmentRow({ movement_state: 'OUT_FOR_DELIVERY', custody_state: 'IN_CUSTODY' })]);
    pool.on(UPDATE, [], 1);
    const { reducer, syncBack, seams } = mk(pool);

    const outcome = await apply(reducer, 'DELIVERED');

    expect(outcome.stateChanged).toBe(true);
    const update = pool.matching(UPDATE)[0];
    expect(update.params[4]).toBe(true); // set_delivered_at
    expect(update.params[5]).toBe(OCCURRED); // delivered_at := occurred-at (§5.2)
    expect(seams.onDelivered).toHaveBeenCalledWith({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_ID,
      occurredAt: OCCURRED,
    });
    expect(syncBack.enqueueFulfillmentEvent).toHaveBeenCalledWith(SHOP_ID, SHIPMENT_ID, 'DELIVERED');
  });

  it('DELIVERED does not overwrite an existing delivered_at', async () => {
    const pool = new FnPool();
    pool.on(LOAD, [
      shipmentRow({ movement_state: 'IN_TRANSIT', delivered_at: '2026-07-01T00:00:00.000Z' }),
    ]);
    pool.on(UPDATE, [], 1);
    const { reducer } = mk(pool);

    await apply(reducer, 'DELIVERED');

    expect(pool.matching(UPDATE)[0].params[4]).toBe(false);
  });

  it('UNDELIVERED_ATTEMPT sets movement NDR and fires the onNdr seam (machine F)', async () => {
    const pool = new FnPool();
    pool.on(LOAD, [shipmentRow({ movement_state: 'OUT_FOR_DELIVERY', custody_state: 'IN_CUSTODY' })]);
    pool.on(UPDATE, [], 1);
    const { reducer, seams } = mk(pool);

    const outcome = await apply(reducer, 'UNDELIVERED_ATTEMPT');

    expect(outcome.stateChanged).toBe(true);
    expect(outcome.movementState).toBe('NDR');
    expect(seams.onNdr).toHaveBeenCalledWith({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_ID,
      carrierEventStatus: 'UNDELIVERED_ATTEMPT',
      occurredAt: OCCURRED,
    });
  });
});
