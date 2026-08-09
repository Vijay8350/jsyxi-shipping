import { describe, expect, it, vi } from 'vitest';
import { CancellationService } from '../../src/modules/booking/cancellation.service';
import type { CancelShipmentResult } from '../../src/modules/courier-framework/adapter.types';
import {
  COURIER_ACCOUNT_ID,
  FnPool,
  INTENT_ID,
  ORDER_ID,
  SHIPMENT_ID,
  SHOP_ID,
  SUBSCRIPTION_ID,
  mockAudit,
} from './helpers';

/**
 * Pre-pickup cancellation (§3.3, §9.5.5): confirmed → VOID + reversal +
 * collectible release; rejected → revert; the IN_CUSTODY race → flagged, no
 * reversal.
 */

interface CancelStageOptions {
  bookingState?: string;
  custodyState?: string;
  custodyAfterRequest?: string; // what the re-lock sees (the race test)
  isTest?: boolean;
}

function cancelPool(opts: CancelStageOptions = {}) {
  const state = {
    custody: opts.custodyState ?? 'PICKUP_PENDING',
    afterRequest: opts.custodyAfterRequest ?? 'CANCEL_REQUESTED',
  };
  const pool = new FnPool();
  pool.on(/FROM shipment s[\s\S]*?FOR UPDATE/, [
    {
      shipment_id: SHIPMENT_ID,
      shop_id: SHOP_ID,
      order_id: ORDER_ID,
      courier_account_id: COURIER_ACCOUNT_ID,
      booking_state: opts.bookingState ?? 'CONFIRMED',
      custody_state: state.custody,
      awb_normalized: 'DL0087412391',
      awb_raw: 'dl 0087-412 391',
      is_test: opts.isTest ?? false,
      booking_intent_id: INTENT_ID,
    },
  ]);
  pool.on(/SELECT custody_state FROM shipment[\s\S]*?FOR UPDATE/, [
    { custody_state: state.afterRequest },
  ]);
  pool.on(/SET custody_state = 'CANCEL_REQUESTED'/, [{}], 1);
  pool.on(/SET custody_state = 'CANCELLED'/, [{}], 1);
  pool.on(/SET custody_state = 'CANCEL_REJECTED'/, [{}], 1);
  pool.on(/SET custody_state = \$3/, [{}], 1);
  pool.on(/FROM subscription/, [
    { subscription_id: SUBSCRIPTION_ID, cycle_start_at: '2026-07-01T00:00:00.000Z' },
  ]);
  return pool;
}

function makeService(pool: FnPool, cancelResult: CancelShipmentResult | Error) {
  const audit = mockAudit();
  const adapterCaller = {
    call: vi.fn((_s: string, _a: string, _m: string, invoke: (a: unknown) => Promise<unknown>) =>
      invoke({
        cancelShipment: (awb: string) => {
          void awb;
          if (cancelResult instanceof Error) return Promise.reject(cancelResult);
          return Promise.resolve(cancelResult);
        },
      }),
    ),
  };
  const ledger = {
    debit: vi.fn(),
    reverse: vi.fn(() => Promise.resolve({ reversed: true, entryId: 'rev-1' })),
  };
  const derivation = {
    recomputeCodAssignment: vi.fn(() => Promise.resolve({ state: 'UNASSIGNED', changed: true })),
  };
  const svc = new CancellationService(
    pool.asPool(),
    audit as never,
    adapterCaller as never,
    ledger as never,
    derivation as never,
  );
  return { svc, audit, adapterCaller, ledger, derivation };
}

const INPUT = { shopId: SHOP_ID, shipmentId: SHIPMENT_ID, actorId: 'member-1' };

describe('cancellation (§3.3, §9.5.5)', () => {
  it('courier-confirmed → CANCELLED + VOID + exactly one reversal + collectible release', async () => {
    const pool = cancelPool();
    const { svc, audit, ledger, derivation } = makeService(pool, {
      kind: 'CANCELLED',
      reason: null,
    });
    const result = await svc.requestCancellation(INPUT);
    expect(result).toEqual({ cancelled: true });

    const voidUpdate = pool.matching(/SET custody_state = 'CANCELLED'/)[0];
    expect(voidUpdate?.sql).toContain("booking_state = 'VOID'");
    // §4.7: the Collectible returns to the Order.
    expect(voidUpdate?.sql).toContain("collectible = '0.00'");

    // INV-12: reversal exactly once, courier-confirmed pre-pickup only.
    expect(ledger.reverse).toHaveBeenCalledTimes(1);
    expect(ledger.reverse).toHaveBeenCalledWith({
      shopId: SHOP_ID,
      subscriptionId: SUBSCRIPTION_ID,
      cycleStartAt: '2026-07-01T00:00:00.000Z',
      shipmentId: SHIPMENT_ID,
      bookingIntentId: INTENT_ID,
      courierConfirmedPrePickup: true,
    });
    // §4.7 release derives cod_assignment_state (UNASSIGNED when siblings are booked).
    expect(derivation.recomputeCodAssignment).toHaveBeenCalledWith(SHOP_ID, ORDER_ID);
    const actions = audit.entries.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['booking.cancel_requested', 'booking.cancelled']),
    );
  });

  it('test shipment: cancelled the same way, but never reversed (INV-19)', async () => {
    const pool = cancelPool({ isTest: true });
    const { svc, ledger, derivation } = makeService(pool, { kind: 'CANCELLED', reason: null });
    const result = await svc.requestCancellation(INPUT);
    expect(result).toEqual({ cancelled: true });
    expect(ledger.reverse).not.toHaveBeenCalled();
    expect(derivation.recomputeCodAssignment).toHaveBeenCalled();
  });

  it('courier-rejected → CANCEL_REJECTED → back to the previous state, no reversal', async () => {
    const pool = cancelPool({ custodyState: 'PICKUP_SCHEDULED' });
    const { svc, audit, ledger } = makeService(pool, {
      kind: 'REJECTED',
      reason: 'ALREADY_MANIFESTED',
    });
    const result = await svc.requestCancellation(INPUT);
    expect(result).toMatchObject({
      cancelled: false,
      code: 'CANCEL_REJECTED',
      currentCustody: 'PICKUP_SCHEDULED',
    });
    expect(pool.matching(/SET custody_state = 'CANCEL_REJECTED'/)).toHaveLength(1);
    const revert = pool.matching(/SET custody_state = \$3/)[0];
    expect(revert?.params[2]).toBe('PICKUP_SCHEDULED');
    expect(ledger.reverse).not.toHaveBeenCalled();
    expect(audit.entries.map((e) => e.action)).toContain('booking.cancel_rejected');
  });

  it('the §3.3 race: PICKED_UP while pending → flagged for review, NO reversal, no VOID', async () => {
    const pool = cancelPool({ custodyAfterRequest: 'IN_CUSTODY' });
    const { svc, audit, ledger, derivation } = makeService(pool, {
      kind: 'CANCELLED',
      reason: null,
    });
    const result = await svc.requestCancellation(INPUT);
    expect(result).toMatchObject({
      cancelled: false,
      code: 'CANCEL_PICKUP_RACE',
      flaggedForReview: true,
    });
    expect(ledger.reverse).not.toHaveBeenCalled();
    expect(pool.matching(/SET custody_state = 'CANCELLED'/)).toHaveLength(0);
    expect(derivation.recomputeCodAssignment).not.toHaveBeenCalled();
    expect(audit.entries.map((e) => e.action)).toContain('booking.cancel_pickup_race');
  });

  it('ambiguous cancel outcome → stays CANCEL_REQUESTED, flagged, no reversal', async () => {
    const pool = cancelPool();
    const { svc, audit, ledger } = makeService(pool, {
      kind: 'OUTCOME_UNKNOWN',
      reason: 'timeout',
    });
    const result = await svc.requestCancellation(INPUT);
    expect(result).toMatchObject({
      cancelled: false,
      code: 'CANCEL_OUTCOME_UNKNOWN',
      flaggedForReview: true,
    });
    expect(ledger.reverse).not.toHaveBeenCalled();
    expect(audit.entries.map((e) => e.action)).toContain('booking.cancel_outcome_unknown');
  });

  it('a transport error mid-cancel is treated as ambiguous (§3.2)', async () => {
    const pool = cancelPool();
    const { svc, ledger } = makeService(pool, new Error('socket hang up'));
    const result = await svc.requestCancellation(INPUT);
    expect(result).toMatchObject({ cancelled: false, code: 'CANCEL_OUTCOME_UNKNOWN' });
    expect(ledger.reverse).not.toHaveBeenCalled();
  });

  it('only CONFIRMED shipments can be cancelled (§3.3)', async () => {
    const pool = cancelPool({ bookingState: 'DRAFT' });
    const { svc, adapterCaller } = makeService(pool, { kind: 'CANCELLED', reason: null });
    const result = await svc.requestCancellation(INPUT);
    expect(result).toMatchObject({ cancelled: false, code: 'INVALID_BOOKING_STATE' });
    expect(adapterCaller.call).not.toHaveBeenCalled();
  });

  it('IN_CUSTODY is the point of no return (§3.3)', async () => {
    const pool = cancelPool({ custodyState: 'IN_CUSTODY' });
    const { svc, adapterCaller } = makeService(pool, { kind: 'CANCELLED', reason: null });
    const result = await svc.requestCancellation(INPUT);
    expect(result).toMatchObject({
      cancelled: false,
      code: 'INVALID_CUSTODY_STATE',
      currentCustody: 'IN_CUSTODY',
    });
    expect(adapterCaller.call).not.toHaveBeenCalled();
  });
});
