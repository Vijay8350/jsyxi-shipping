import { describe, expect, it, vi } from 'vitest';
import { BookingWorkerService } from '../../src/modules/booking/booking-worker.service';
import type {
  CreateShipmentRequest,
  CreateShipmentResult,
  LookupByReferenceResult,
} from '../../src/modules/courier-framework/adapter.types';
import {
  COURIER_ACCOUNT_ID,
  FnPool,
  INTENT_ID,
  ORDER_ID,
  SERVICE_ID,
  SHIPMENT_ID,
  SHOP_ID,
  SUBSCRIPTION_ID,
  mockAudit,
  sampleSnapshot,
} from './helpers';

/**
 * The booking worker (§3.2, §9.5.4): QUEUED → SUBMITTED → CONFIRMED / FAILED
 * / OUTCOME_UNKNOWN, the INV-5 guarantees and both resolutions.
 */

const JOB = {
  shopId: SHOP_ID,
  shipmentId: SHIPMENT_ID,
  bookingIntentId: INTENT_ID,
  merchantReference: `11111111-${SHIPMENT_ID}`,
  serviceId: SERVICE_ID,
  courierAccountId: COURIER_ACCOUNT_ID,
};

interface WorkerStageOptions {
  bookingState?: string;
  intentOutcome?: string;
  expectedCostBasis?: string | null;
  accountMode?: string;
  dupAwb?: boolean;
  subscription?: boolean;
}

function workerPool(opts: WorkerStageOptions = {}) {
  const state = {
    bookingState: opts.bookingState ?? 'QUEUED',
    intentOutcome: opts.intentOutcome ?? 'IN_FLIGHT',
  };
  const pool = new FnPool();
  pool.onFn(/FROM shipment[\s\S]*?FOR UPDATE/, () => ({
    rows: [
      {
        shipment_id: SHIPMENT_ID,
        shop_id: SHOP_ID,
        order_id: ORDER_ID,
        courier_account_id: COURIER_ACCOUNT_ID,
        booking_state: state.bookingState,
        expected_cost_basis:
          opts.expectedCostBasis === undefined ? 'SNAPSHOT_QUOTE' : opts.expectedCostBasis,
        snapshot: sampleSnapshot(),
      },
    ],
    rowCount: 1,
  }));
  pool.onFn(/FROM booking_intent/, () => ({
    rows: [
      {
        booking_intent_id: INTENT_ID,
        outcome: state.intentOutcome,
        merchant_reference: `11111111-${SHIPMENT_ID}`,
        request_digest: 'd'.repeat(64),
      },
    ],
    rowCount: 1,
  }));
  const to =
    (booking: string, intent?: string) => (): { rows: unknown[]; rowCount: number } => {
      state.bookingState = booking;
      if (intent) state.intentOutcome = intent;
      return { rows: [{}], rowCount: 1 };
    };
  pool.onFn(/SET booking_state = 'SUBMITTED'/, to('SUBMITTED'));
  pool.onFn(/SET booking_state = 'FAILED'/, to('FAILED'));
  pool.onFn(/SET booking_state = 'OUTCOME_UNKNOWN'/, to('OUTCOME_UNKNOWN'));
  pool.onFn(/SET booking_state = 'CONFIRMED'/, to('CONFIRMED'));
  pool.onFn(/UPDATE booking_intent/, (sql, params) => {
    if (sql.includes("'UNKNOWN'")) state.intentOutcome = 'UNKNOWN';
    else if (typeof params[1] === 'string') state.intentOutcome = params[1];
    return { rows: [{}], rowCount: 1 };
  });
  pool.on(/pg_advisory_xact_lock/, []);
  pool.on(/awb_normalized = \$3/, opts.dupAwb ? [{ shipment_id: 'other-shipment' }] : []);
  pool.on(/FROM courier_account/, [{ mode: opts.accountMode ?? 'LIVE' }]);
  pool.on(
    /FROM subscription/,
    opts.subscription === false
      ? []
      : [{ subscription_id: SUBSCRIPTION_ID, cycle_start_at: '2026-07-01T00:00:00.000Z' }],
  );
  // loadOutcomeUnknown (no row lock).
  pool.onFn(/SELECT booking_state, courier_account_id FROM shipment/, () => ({
    rows: [{ booking_state: state.bookingState, courier_account_id: COURIER_ACCOUNT_ID }],
    rowCount: 1,
  }));
  return { pool, state };
}

function makeWorker(
  pool: FnPool,
  adapterResults: {
    create?: CreateShipmentResult | ((req: CreateShipmentRequest) => CreateShipmentResult);
    lookup?: LookupByReferenceResult;
  },
) {
  const audit = mockAudit();
  const adapterCalls: Array<{ method: string; request?: CreateShipmentRequest; ref?: string }> = [];
  const adapterCaller = {
    call: vi.fn(
      (
        _shop: string,
        _account: string,
        method: string,
        invoke: (adapter: unknown) => Promise<unknown>,
      ) =>
        invoke({
          createShipment: (req: CreateShipmentRequest) => {
            adapterCalls.push({ method, request: req });
            const r = adapterResults.create;
            return Promise.resolve(typeof r === 'function' ? r(req) : r);
          },
          lookupByReference: (ref: string) => {
            adapterCalls.push({ method, ref });
            return Promise.resolve(adapterResults.lookup);
          },
        }),
    ),
  };
  const ledger = {
    debit: vi.fn(() => Promise.resolve({ debited: true, entryId: 'entry-1' })),
    reverse: vi.fn(),
  };
  const derivation = {
    recomputeCodAssignment: vi.fn(() => Promise.resolve({ state: 'ASSIGNED', changed: true })),
  };
  const svc = new BookingWorkerService(
    pool.asPool(),
    audit as never,
    adapterCaller as never,
    ledger as never,
    derivation as never,
  );
  return { svc, audit, adapterCaller, adapterCalls, ledger, derivation };
}

const CONFIRMED: CreateShipmentResult = {
  kind: 'CONFIRMED',
  awb: ' dl 0087-412 391 ',
  confirmedCharge: null,
  failureReasons: [],
};

describe('worker CONFIRMED path (§3.2, INV-6, INV-12, INV-19, §3.25)', () => {
  it('QUEUED → SUBMITTED → CONFIRMED: F-19 AWB, custody, basis, one debit', async () => {
    const { pool } = workerPool();
    const { svc, audit, adapterCalls, ledger, derivation } = makeWorker(pool, {
      create: CONFIRMED,
    });
    await svc.processBooking(JOB);

    // The create request came from the frozen snapshot (INV-8).
    expect(adapterCalls).toHaveLength(1);
    const req = adapterCalls[0]?.request as CreateShipmentRequest;
    expect(req.intent).toEqual({
      bookingIntentId: INTENT_ID,
      requestDigest: 'd'.repeat(64),
      merchantReference: `11111111-${SHIPMENT_ID}`,
    });
    expect(req.recipient.name).toBe('Asha Verma');
    expect(req.collectible).toBe('1250.50');
    expect(req.originPincode).toBe('380015');

    // The CONFIRMED write: F-19 normalization, custody §3.3, basis kept.
    const confirm = pool.matching(/SET booking_state = 'CONFIRMED'/)[0];
    expect(confirm).toBeDefined();
    expect(confirm?.sql).toContain("custody_state = 'PICKUP_PENDING'");
    expect(confirm?.sql).toContain('booked_at = now()');
    expect(confirm?.params).toEqual([
      SHOP_ID,
      SHIPMENT_ID,
      ' dl 0087-412 391 ', // awb_raw preserved
      'DL0087412391', // F-19 normalized
      'SNAPSHOT_QUOTE',
      false, // is_test — LIVE account
      null, // provider_confirmed_charge — only for §3.25 PROVIDER_CONFIRMED_CHARGE
    ]);
    // INV-6: advisory lock on (courier_account_id, awb_normalized).
    const lock = pool.matching(/pg_advisory_xact_lock/)[0];
    expect(lock?.params[0]).toBe(`${COURIER_ACCOUNT_ID}:DL0087412391`);

    // INV-12: exactly one debit for a non-test AWB; intent CONFIRMED.
    expect(ledger.debit).toHaveBeenCalledTimes(1);
    expect(ledger.debit).toHaveBeenCalledWith({
      shopId: SHOP_ID,
      subscriptionId: SUBSCRIPTION_ID,
      cycleStartAt: '2026-07-01T00:00:00.000Z',
      shipmentId: SHIPMENT_ID,
      bookingIntentId: INTENT_ID,
      isTest: false,
    });
    const intentUpdate = pool.matching(/UPDATE booking_intent/)[0];
    expect(intentUpdate?.params[1]).toBe('CONFIRMED');

    expect(derivation.recomputeCodAssignment).toHaveBeenCalledWith(SHOP_ID, ORDER_ID);
    expect(audit.entries.map((e) => e.action)).toContain('booking.confirmed');
    // QUEUED → SUBMITTED happened first (worker transition).
    expect(pool.matching(/SET booking_state = 'SUBMITTED'/)).toHaveLength(1);
  });

  it('INV-19: a TEST-mode account sets is_test and skips the debit', async () => {
    const { pool } = workerPool({ accountMode: 'TEST' });
    const { svc, ledger } = makeWorker(pool, { create: CONFIRMED });
    await svc.processBooking(JOB);
    const confirm = pool.matching(/SET booking_state = 'CONFIRMED'/)[0];
    expect(confirm?.params[5]).toBe(true);
    expect(ledger.debit).not.toHaveBeenCalled();
  });

  it('§3.25: no frozen quote + confirmed charge ⇒ PROVIDER_CONFIRMED_CHARGE', async () => {
    const { pool } = workerPool({ expectedCostBasis: null });
    const { svc } = makeWorker(pool, {
      create: { ...CONFIRMED, confirmedCharge: '150.00' },
    });
    await svc.processBooking(JOB);
    expect(pool.matching(/SET booking_state = 'CONFIRMED'/)[0]?.params[4]).toBe(
      'PROVIDER_CONFIRMED_CHARGE',
    );
  });

  it('§3.25: no quote and no charge ⇒ NONE', async () => {
    const { pool } = workerPool({ expectedCostBasis: null });
    const { svc } = makeWorker(pool, { create: CONFIRMED });
    await svc.processBooking(JOB);
    expect(pool.matching(/SET booking_state = 'CONFIRMED'/)[0]?.params[4]).toBe('NONE');
  });

  it('INV-6: a duplicate AWB is quarantined — never stored, never debited (INV-20)', async () => {
    const { pool } = workerPool({ dupAwb: true });
    const { svc, audit, ledger } = makeWorker(pool, { create: CONFIRMED });
    await svc.processBooking(JOB);
    expect(pool.matching(/SET booking_state = 'CONFIRMED'/)).toHaveLength(0);
    expect(pool.matching(/INSERT INTO dlq_item/)).toHaveLength(1);
    expect(ledger.debit).not.toHaveBeenCalled();
    expect(audit.entries.map((e) => e.action)).toContain('booking.awb_duplicate_quarantined');
  });
});

describe('worker FAILED / OUTCOME_UNKNOWN (§3.2, INV-5)', () => {
  it('FAILED: structured provider reasons, intent FAILED, no debit', async () => {
    const { pool } = workerPool();
    const { svc, audit, ledger } = makeWorker(pool, {
      create: { kind: 'FAILED', awb: null, confirmedCharge: null, failureReasons: ['PINCODE_NOT_SERVICEABLE'] },
    });
    await svc.processBooking(JOB);
    expect(pool.matching(/SET booking_state = 'FAILED'/)).toHaveLength(1);
    const failed = audit.entries.find((e) => e.action === 'booking.failed');
    expect((failed?.after as { failureReasons: string[] }).failureReasons).toEqual([
      'PINCODE_NOT_SERVICEABLE',
    ]);
    expect(ledger.debit).not.toHaveBeenCalled();
  });

  it('OUTCOME_UNKNOWN: no second create and no debit, ever (INV-5)', async () => {
    const { pool, state } = workerPool();
    const { svc, adapterCaller, ledger } = makeWorker(pool, {
      create: { kind: 'OUTCOME_UNKNOWN', awb: null, confirmedCharge: null, failureReasons: [] },
    });
    await svc.processBooking(JOB);
    expect(state.bookingState).toBe('OUTCOME_UNKNOWN');
    expect(state.intentOutcome).toBe('UNKNOWN');
    expect(ledger.debit).not.toHaveBeenCalled();

    // A duplicate job delivery must not issue a second create.
    await svc.processBooking(JOB);
    expect(adapterCaller.call).toHaveBeenCalledTimes(1);
    expect(ledger.debit).not.toHaveBeenCalled();
  });

  it('a settled intent makes a re-delivered job a no-op', async () => {
    const { pool } = workerPool({ bookingState: 'CONFIRMED', intentOutcome: 'CONFIRMED' });
    const { svc, adapterCaller } = makeWorker(pool, { create: CONFIRMED });
    await svc.processBooking(JOB);
    expect(adapterCaller.call).not.toHaveBeenCalled();
  });
});

describe('OUTCOME_UNKNOWN resolution (§9.5.4, §3.23)', () => {
  it('lookupByReference found ⇒ RESOLVED_CONFIRMED completes the CONFIRMED path', async () => {
    const { pool } = workerPool({ bookingState: 'OUTCOME_UNKNOWN', intentOutcome: 'UNKNOWN' });
    const { svc, audit, adapterCalls, ledger } = makeWorker(pool, {
      lookup: { found: true, awb: 'abc-123 x' },
    });
    const result = await svc.resolveOutcomeUnknown(SHOP_ID, SHIPMENT_ID);
    expect(result).toMatchObject({ resolved: true, outcome: 'RESOLVED_CONFIRMED' });
    expect(adapterCalls[0]).toMatchObject({
      method: 'lookupByReference',
      ref: `11111111-${SHIPMENT_ID}`,
    });
    const confirm = pool.matching(/SET booking_state = 'CONFIRMED'/)[0];
    expect(confirm?.params[3]).toBe('ABC123X');
    expect(pool.matching(/UPDATE booking_intent/)[0]?.params[1]).toBe('RESOLVED_CONFIRMED');
    expect(ledger.debit).toHaveBeenCalledTimes(1);
    expect(audit.entries.map((e) => e.action)).toContain('booking.outcome_unknown_resolved');
  });

  it('lookupByReference not found ⇒ RESOLVED_FAILED → FAILED (retry re-enters DRAFT)', async () => {
    const { pool } = workerPool({ bookingState: 'OUTCOME_UNKNOWN', intentOutcome: 'UNKNOWN' });
    const { svc, audit, ledger } = makeWorker(pool, {
      lookup: { found: false, awb: null },
    });
    const result = await svc.resolveOutcomeUnknown(SHOP_ID, SHIPMENT_ID);
    expect(result).toEqual({ resolved: true, outcome: 'RESOLVED_FAILED' });
    expect(pool.matching(/SET booking_state = 'FAILED'/)).toHaveLength(1);
    expect(pool.matching(/UPDATE booking_intent/)[0]?.params[1]).toBe('RESOLVED_FAILED');
    expect(ledger.debit).not.toHaveBeenCalled();
    expect(audit.entries.map((e) => e.action)).toContain('booking.outcome_unknown_resolved');
  });

  it('Operator resolution: CONFIRMED with an AWB (§3.2, audited)', async () => {
    const { pool } = workerPool({ bookingState: 'OUTCOME_UNKNOWN', intentOutcome: 'UNKNOWN' });
    const { svc, audit } = makeWorker(pool, {});
    const result = await svc.resolveOutcomeUnknownByOperator(SHOP_ID, SHIPMENT_ID, 'member-9', {
      outcome: 'CONFIRMED',
      awb: 'DL999',
    });
    expect(result).toMatchObject({ resolved: true, outcome: 'RESOLVED_CONFIRMED' });
    const resolved = audit.entries.find((e) => e.action === 'booking.outcome_unknown_resolved');
    expect(resolved?.actorKind).toBe('MEMBER');
    expect(resolved?.actorId).toBe('member-9');
  });

  it('Operator resolution: FAILED releases the shipment for retry', async () => {
    const { pool } = workerPool({ bookingState: 'OUTCOME_UNKNOWN', intentOutcome: 'UNKNOWN' });
    const { svc, ledger } = makeWorker(pool, {});
    const result = await svc.resolveOutcomeUnknownByOperator(SHOP_ID, SHIPMENT_ID, 'member-9', {
      outcome: 'FAILED',
    });
    expect(result).toEqual({ resolved: true, outcome: 'RESOLVED_FAILED' });
    expect(pool.matching(/SET booking_state = 'FAILED'/)).toHaveLength(1);
    expect(ledger.debit).not.toHaveBeenCalled();
  });

  it('resolution refuses a shipment that is not OUTCOME_UNKNOWN', async () => {
    const { pool } = workerPool({ bookingState: 'CONFIRMED', intentOutcome: 'CONFIRMED' });
    const { svc } = makeWorker(pool, {});
    const result = await svc.resolveOutcomeUnknown(SHOP_ID, SHIPMENT_ID);
    expect(result).toMatchObject({ resolved: false, code: 'INVALID_STATE' });
  });
});
