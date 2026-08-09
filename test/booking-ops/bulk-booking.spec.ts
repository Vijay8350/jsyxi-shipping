import { describe, expect, it, vi } from 'vitest';
import { BulkBookingService } from '../../src/modules/booking-ops/bulk-booking.service';
import {
  BATCH_ID,
  COURIER_ACCOUNT_1,
  FakeRedis,
  FnPool,
  INTENT_ID,
  MEMBER_ID,
  ORDER_1,
  ORDER_2,
  ORDER_3,
  PICKUP_LOCATION_ID,
  RATE_CARD_ID,
  RATE_CARD_VERSION_ID,
  SERVICE_1,
  SERVICE_VERSION_1,
  SHIPMENT_1,
  SHIPMENT_2,
  SHIPMENT_3,
  SHOP_ID,
  mockAudit,
  shipmentCandidate,
  workingValues,
} from './helpers';

/**
 * §9.5.2 bulk booking: validation, §9.4.5 version snapshot, per-order
 * results incl. NEEDS_MANUAL_ASSIGNMENT (INV-20), retry-only-failed, S-21
 * concurrency refusal, §4.5 quote pre-resolution.
 */

const GET_BATCH = /FROM booking_batch\s+WHERE shop_id = \$1 AND batch_id/;
const SNAPSHOT_SERVICES = /FROM merchant_service ms\s+WHERE ms\.shop_id/;
const SNAPSHOT_RATE_CARDS = /FROM rate_card rc/;
const INSERT_BATCH = /INSERT INTO booking_batch/;
const LOAD_SHIPMENTS = /FROM shipment\s+WHERE shop_id = \$1 AND order_id = ANY/;
const WARM_SERVICES = /FROM service s\s+JOIN merchant_service/;
const SET_RUNNING = /UPDATE booking_batch SET state = 'RUNNING'/;
const SET_PROGRESS = /UPDATE booking_batch\s+SET processed/;
const SET_TERMINAL = /UPDATE booking_batch SET state = \$3/;

function batchRow(overrides: Record<string, unknown> = {}) {
  return {
    batch_id: BATCH_ID,
    shop_id: SHOP_ID,
    requested_by: MEMBER_ID,
    state: 'QUEUED',
    total: 3,
    processed: 0,
    succeeded: 0,
    failed: 0,
    results: [],
    version_snapshot: null,
    version: 1,
    created_at: '2026-07-31T10:00:00.000Z',
    updated_at: '2026-07-31T10:00:00.000Z',
    ...overrides,
  };
}

function setup(opts: { queueBooking?: ReturnType<typeof vi.fn> } = {}) {
  const pool = new FnPool();
  const redis = new FakeRedis();
  const audit = mockAudit();
  const booking = {
    queueBooking:
      opts.queueBooking ??
      vi.fn(async () => ({
        queued: true as const,
        bookingIntentId: INTENT_ID,
        merchantReference: 'shop-shipment-1',
        attemptNumber: 1,
        expectedCostBasis: null,
        collectible: '0.00',
      })),
  };
  const quoteCache = {
    getLiveQuote: vi.fn(
      async (
        _db: unknown,
        _args: { request: { paymentMode: string }; billableWeightBand: string | null },
      ) => ({}),
    ),
  };
  const bulkQueue = { enqueueBulkJob: vi.fn(async () => undefined) };
  const service = new BulkBookingService(
    pool.asPool(),
    redis.asRedis(),
    audit as never,
    booking as never,
    quoteCache as never,
    bulkQueue as never,
  );
  return { pool, redis, audit, booking, quoteCache, bulkQueue, service };
}

describe('createBatch — validation (§9.5.2, §5.1)', () => {
  it('rejects more than 1,000 orders', async () => {
    const { service, bulkQueue } = setup();
    const orderIds = Array.from({ length: 1001 }, (_, i) => `order-${i}`);
    const result = await service.createBatch({ shopId: SHOP_ID, actorId: MEMBER_ID, orderIds });
    expect(result).toMatchObject({ created: false, code: 'VALIDATION', limit: 1000 });
    expect(bulkQueue.enqueueBulkJob).not.toHaveBeenCalled();
  });

  it('rejects an empty order list', async () => {
    const { service } = setup();
    const result = await service.createBatch({ shopId: SHOP_ID, actorId: MEMBER_ID, orderIds: [] });
    expect(result).toMatchObject({ created: false, code: 'VALIDATION' });
  });

  it('accepts exactly 1,000 orders', async () => {
    const { pool, service } = setup();
    pool.on(SNAPSHOT_SERVICES, []).on(SNAPSHOT_RATE_CARDS, []).on(INSERT_BATCH, [{ batch_id: BATCH_ID }]);
    const orderIds = Array.from({ length: 1000 }, (_, i) => `order-${i}`);
    const result = await service.createBatch({ shopId: SHOP_ID, actorId: MEMBER_ID, orderIds });
    expect(result).toMatchObject({ created: true, total: 1000 });
  });
});

describe('createBatch — §9.4.5 version snapshot + enqueue', () => {
  it('snapshots service + rate-card versions at enqueue and audits', async () => {
    const { pool, redis, audit, bulkQueue, service } = setup();
    pool
      .on(SNAPSHOT_SERVICES, [{ service_id: SERVICE_1, service_version_id: SERVICE_VERSION_1 }])
      .on(SNAPSHOT_RATE_CARDS, [
        { rate_card_id: RATE_CARD_ID, rate_card_version_id: RATE_CARD_VERSION_ID },
      ])
      .on(INSERT_BATCH, [{ batch_id: BATCH_ID }]);

    const result = await service.createBatch({
      shopId: SHOP_ID,
      actorId: MEMBER_ID,
      orderIds: [ORDER_1, ORDER_2],
    });
    expect(result).toMatchObject({ created: true, batchId: BATCH_ID, state: 'QUEUED', total: 2 });

    const insert = pool.matching(INSERT_BATCH)[0];
    expect(insert.params[0]).toBe(SHOP_ID); // INV-1
    expect(insert.params[2]).toBe(2);
    const snapshot = JSON.parse(insert.params[3] as string);
    expect(snapshot.rules).toBeNull(); // rules land later (§9.4)
    expect(snapshot.services).toEqual([
      { serviceId: SERVICE_1, serviceVersionId: SERVICE_VERSION_1 },
    ]);
    expect(snapshot.rateCardVersions).toEqual([
      { rateCardId: RATE_CARD_ID, rateCardVersionId: RATE_CARD_VERSION_ID },
    ]);
    expect(snapshot.capturedAt).toBeTruthy();
    expect(snapshot.retryOf).toBeUndefined();

    expect(bulkQueue.enqueueBulkJob).toHaveBeenCalledWith({
      shopId: SHOP_ID,
      batchId: BATCH_ID,
      orderIds: [ORDER_1, ORDER_2],
      requestedBy: MEMBER_ID,
    });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      action: 'booking_bulk.batch_created',
      objectType: 'booking_batch',
      objectId: BATCH_ID,
    });
    // S-21 slot acquired and held until the worker finishes.
    expect(redis.store.get(`booking-ops:bulk:active:${SHOP_ID}`)).toBe('1');
  });
});

describe('createBatch — S-21 per-shop concurrency quota', () => {
  it('returns a 429-style structured refusal when 2 bulk jobs are active', async () => {
    const { pool, redis, service, bulkQueue } = setup();
    redis.store.set(`booking-ops:bulk:active:${SHOP_ID}`, '2');
    const result = await service.createBatch({
      shopId: SHOP_ID,
      actorId: MEMBER_ID,
      orderIds: [ORDER_1],
    });
    expect(result).toMatchObject({
      created: false,
      code: 'BULK_CONCURRENCY_EXCEEDED',
      limit: 2,
    });
    // The counter is restored and nothing is persisted or enqueued.
    expect(redis.store.get(`booking-ops:bulk:active:${SHOP_ID}`)).toBe('2');
    expect(pool.matching(INSERT_BATCH)).toHaveLength(0);
    expect(bulkQueue.enqueueBulkJob).not.toHaveBeenCalled();
  });
});

describe('processBatch — per-order results (INV-20)', () => {
  it('records ✓ queued-with-intent and ✗ exact reasons incl. NEEDS_MANUAL_ASSIGNMENT; terminal PARTIAL', async () => {
    const queueBooking = vi.fn(async (input: { shipmentId: string }) => {
      if (input.shipmentId === SHIPMENT_1) {
        return {
          queued: true as const,
          bookingIntentId: INTENT_ID,
          merchantReference: 'ref-1',
          attemptNumber: 1,
          expectedCostBasis: null,
          collectible: '0.00',
        };
      }
      // NEEDS_MANUAL_ASSIGNMENT outcome (§3.2, RW-22) — reported with reason.
      return {
        queued: false as const,
        code: 'NO_BOOKABLE_SERVICE' as const,
        manualAssignmentReason: 'NO_RULE_AND_NO_DEFAULT_CHAIN' as const,
      };
    });
    const { pool, redis, audit, service } = setup({ queueBooking });
    redis.store.set(`booking-ops:bulk:active:${SHOP_ID}`, '1');
    pool
      .on(GET_BATCH, [batchRow()])
      .on(LOAD_SHIPMENTS, [
        shipmentCandidate(),
        shipmentCandidate({ shipment_id: SHIPMENT_2, order_id: ORDER_2 }),
        // Order 3 is already booked — no bookable shipment.
        shipmentCandidate({ shipment_id: SHIPMENT_3, order_id: ORDER_3, booking_state: 'CONFIRMED' }),
      ])
      .on(WARM_SERVICES, [
        { service_id: SERVICE_1, cost_source: 'RATE_CARD', courier_account_id: COURIER_ACCOUNT_1 },
      ]);

    await service.processBatch({
      shopId: SHOP_ID,
      batchId: BATCH_ID,
      orderIds: [ORDER_1, ORDER_2, ORDER_3],
      requestedBy: MEMBER_ID,
    });

    expect(pool.matching(SET_RUNNING)).toHaveLength(1);
    // Live progress: one write per order with growing counters.
    const progress = pool.matching(SET_PROGRESS);
    expect(progress).toHaveLength(3);
    expect(progress[2].params.slice(2, 5)).toEqual([3, 1, 2]);
    const lastResults = JSON.parse(progress[2].params[5] as string);
    expect(lastResults).toHaveLength(3);
    // ✓ queued-with-intent.
    expect(lastResults[0]).toMatchObject({
      orderId: ORDER_1,
      shipmentId: SHIPMENT_1,
      status: 'QUEUED',
      bookingIntentId: INTENT_ID,
    });
    // ✗ NEEDS_MANUAL_ASSIGNMENT reported with its §3.30 reason (INV-20).
    expect(lastResults[1]).toMatchObject({
      orderId: ORDER_2,
      status: 'FAILED',
      code: 'NO_BOOKABLE_SERVICE',
      manualAssignmentReason: 'NO_RULE_AND_NO_DEFAULT_CHAIN',
    });
    // ✗ already booked — current state visible, never silent.
    expect(lastResults[2]).toMatchObject({
      orderId: ORDER_3,
      status: 'FAILED',
      code: 'NO_BOOKABLE_SHIPMENT',
      currentState: 'CONFIRMED',
    });

    // §3.27: some failed → PARTIAL.
    const terminal = pool.matching(SET_TERMINAL)[0];
    expect(terminal.params[2]).toBe('PARTIAL');
    expect(audit.entries.map((e) => e.action)).toContain('booking_bulk.batch_completed');
    // The S-21 slot is released when the job ends.
    expect(redis.store.get(`booking-ops:bulk:active:${SHOP_ID}`)).toBe('0');
  });

  it('terminates SUCCEEDED when every order queues', async () => {
    const { pool, redis, service } = setup();
    redis.store.set(`booking-ops:bulk:active:${SHOP_ID}`, '1');
    pool
      .on(GET_BATCH, [batchRow({ total: 1 })])
      .on(LOAD_SHIPMENTS, [shipmentCandidate()])
      .on(WARM_SERVICES, [
        { service_id: SERVICE_1, cost_source: 'RATE_CARD', courier_account_id: COURIER_ACCOUNT_1 },
      ]);
    await service.processBatch({
      shopId: SHOP_ID,
      batchId: BATCH_ID,
      orderIds: [ORDER_1],
      requestedBy: MEMBER_ID,
    });
    expect(pool.matching(SET_TERMINAL)[0].params[2]).toBe('SUCCEEDED');
  });

  it('resumes a redriven job without reprocessing recorded orders', async () => {
    const queueBooking = vi.fn(async () => ({
      queued: true as const,
      bookingIntentId: INTENT_ID,
      merchantReference: 'ref-1',
      attemptNumber: 1,
      expectedCostBasis: null,
      collectible: '0.00',
    }));
    const { pool, service } = setup({ queueBooking });
    pool
      .on(GET_BATCH, [
        batchRow({
          state: 'RUNNING',
          processed: 1,
          succeeded: 1,
          results: [
            { orderId: ORDER_1, shipmentId: SHIPMENT_1, status: 'QUEUED', bookingIntentId: INTENT_ID },
          ],
        }),
      ])
      .on(LOAD_SHIPMENTS, [
        shipmentCandidate(),
        shipmentCandidate({ shipment_id: SHIPMENT_2, order_id: ORDER_2 }),
      ])
      .on(WARM_SERVICES, [
        { service_id: SERVICE_1, cost_source: 'RATE_CARD', courier_account_id: COURIER_ACCOUNT_1 },
      ]);
    await service.processBatch({
      shopId: SHOP_ID,
      batchId: BATCH_ID,
      orderIds: [ORDER_1, ORDER_2],
      requestedBy: MEMBER_ID,
    });
    // Only ORDER_2 was (re)processed; no second RUNNING transition.
    expect(queueBooking).toHaveBeenCalledTimes(1);
    expect(pool.matching(SET_RUNNING)).toHaveLength(0);
  });
});

describe('processBatch — §4.5 quote pre-resolution', () => {
  it('warms each distinct LIVE_QUOTE cache key at most once per job', async () => {
    const { pool, quoteCache, service } = setup();
    const prepaid = workingValues({ payment: { mode: 'PREPAID', gatewayNames: ['razorpay'], collectible: '0.00' } });
    pool
      .on(GET_BATCH, [batchRow({ total: 3 })])
      .on(LOAD_SHIPMENTS, [
        shipmentCandidate(), // COD
        shipmentCandidate({ shipment_id: SHIPMENT_2, order_id: ORDER_2 }), // COD — same key
        shipmentCandidate({ shipment_id: SHIPMENT_3, order_id: ORDER_3, working_values: prepaid }),
      ])
      .on(WARM_SERVICES, [
        { service_id: SERVICE_1, cost_source: 'LIVE_QUOTE', courier_account_id: COURIER_ACCOUNT_1 },
      ])
      .on(/FROM pickup_location\s+WHERE shop_id/, [
        { pickup_location_id: PICKUP_LOCATION_ID, pincode: '380015' },
      ])
      .on(/FROM service_version\s+WHERE service_id = ANY/, [
        {
          service_id: SERVICE_1,
          volumetric_divisor: '5000',
          min_billable_kg: '0.5',
          billable_increment_kg: '0.5',
        },
      ]);

    await service.processBatch({
      shopId: SHOP_ID,
      batchId: BATCH_ID,
      orderIds: [ORDER_1, ORDER_2, ORDER_3],
      requestedBy: MEMBER_ID,
    });

    // Two distinct keys (COD + PREPAID), each fetched exactly once.
    expect(quoteCache.getLiveQuote).toHaveBeenCalledTimes(2);
    const modes = quoteCache.getLiveQuote.mock.calls
      .map((c) => (c[1] as { request: { paymentMode: string } }).request.paymentMode)
      .sort();
    expect(modes).toEqual(['COD', 'PREPAID']);
    const bands = quoteCache.getLiveQuote.mock.calls.map(
      (c) => (c[1] as { billableWeightBand: string | null }).billableWeightBand,
    );
    expect(bands).toEqual(['1.000', '1.000']);
  });

  it('a warm-up failure never blocks the booking stage', async () => {
    const { pool, quoteCache, service } = setup();
    quoteCache.getLiveQuote = vi.fn(async () => {
      throw new Error('circuit open');
    });
    pool
      .on(GET_BATCH, [batchRow({ total: 1 })])
      .on(LOAD_SHIPMENTS, [shipmentCandidate()])
      .on(WARM_SERVICES, [
        { service_id: SERVICE_1, cost_source: 'LIVE_QUOTE', courier_account_id: COURIER_ACCOUNT_1 },
      ])
      .on(/FROM pickup_location\s+WHERE shop_id/, [
        { pickup_location_id: PICKUP_LOCATION_ID, pincode: '380015' },
      ])
      .on(/FROM service_version\s+WHERE service_id = ANY/, [
        { service_id: SERVICE_1, volumetric_divisor: '5000', min_billable_kg: '0.5', billable_increment_kg: '0.5' },
      ]);
    await service.processBatch({
      shopId: SHOP_ID,
      batchId: BATCH_ID,
      orderIds: [ORDER_1],
      requestedBy: MEMBER_ID,
    });
    expect(pool.matching(SET_TERMINAL)[0].params[2]).toBe('SUCCEEDED');
  });
});

describe('retryFailed — a new batch over only the failed orders', () => {
  it('re-enqueues failed orders with version_snapshot.retryOf set', async () => {
    const { pool, bulkQueue, service } = setup();
    pool
      .on(GET_BATCH, [
        batchRow({
          state: 'PARTIAL',
          results: [
            { orderId: ORDER_1, shipmentId: SHIPMENT_1, status: 'QUEUED', bookingIntentId: INTENT_ID },
            { orderId: ORDER_2, shipmentId: SHIPMENT_2, status: 'FAILED', code: 'INV_7_BLOCKS' },
            {
              orderId: ORDER_3,
              shipmentId: SHIPMENT_3,
              status: 'FAILED',
              code: 'NO_BOOKABLE_SERVICE',
              manualAssignmentReason: 'NO_RULE_AND_NO_DEFAULT_CHAIN',
            },
          ],
        }),
      ])
      .on(SNAPSHOT_SERVICES, [])
      .on(SNAPSHOT_RATE_CARDS, [])
      .on(INSERT_BATCH, [{ batch_id: 'bbbbbbbb-0000-0000-0000-0000000000ff' }]);

    const result = await service.retryFailed({ shopId: SHOP_ID, batchId: BATCH_ID, actorId: MEMBER_ID });
    expect(result).toMatchObject({ created: true, total: 2 });
    const insert = pool.matching(INSERT_BATCH)[0];
    expect(insert.params[2]).toBe(2);
    expect(JSON.parse(insert.params[3] as string).retryOf).toBe(BATCH_ID);
    expect(bulkQueue.enqueueBulkJob).toHaveBeenCalledWith(
      expect.objectContaining({ orderIds: [ORDER_2, ORDER_3] }),
    );
  });

  it('refuses when nothing failed, or the batch is not terminal', async () => {
    const { pool, service } = setup();
    pool.on(GET_BATCH, [
      batchRow({
        state: 'SUCCEEDED',
        results: [{ orderId: ORDER_1, shipmentId: SHIPMENT_1, status: 'QUEUED' }],
      }),
    ]);
    const nothing = await service.retryFailed({ shopId: SHOP_ID, batchId: BATCH_ID, actorId: MEMBER_ID });
    expect(nothing).toMatchObject({ created: false, code: 'NOTHING_TO_RETRY' });

    const pool2 = new FnPool();
    pool2.on(GET_BATCH, [batchRow({ state: 'RUNNING' })]);
    const env2 = setup();
    const service2 = new BulkBookingService(
      pool2.asPool(),
      env2.redis.asRedis(),
      env2.audit as never,
      env2.booking as never,
      env2.quoteCache as never,
      env2.bulkQueue as never,
    );
    const running = await service2.retryFailed({ shopId: SHOP_ID, batchId: BATCH_ID, actorId: MEMBER_ID });
    expect(running).toMatchObject({ created: false, code: 'NOT_TERMINAL' });
  });
});
