import { describe, expect, it, vi } from 'vitest';
import {
  POLL_INTERVAL_MS,
  TrackingPollingService,
} from '../../src/modules/tracking/tracking-polling.service';
import type { AdapterCallerService } from '../../src/modules/courier-framework/adapter-caller.service';
import type { CourierWebhookIngestService } from '../../src/modules/tracking/courier-webhook-ingest.service';
import type { TrackEvent } from '../../src/modules/courier-framework/adapter.types';
import {
  AWB_NORMALIZED,
  COURIER_ACCOUNT_ID,
  FakeRedis,
  FnPool,
  SHIPMENT_ID,
  SHOP_ID,
} from './helpers';

/**
 * §8.5 polling fallback: 2h new / 4h in-transit cohorts, terminal states
 * stop polling, adapter events feed the SAME normalization path (POLL), and
 * per-account sequential quota (S-21 spirit) with a per-shipment cadence
 * throttle.
 */

const COHORT_SQL = /FROM shipment s\s+JOIN courier_account/;

const T0 = new Date('2026-08-01T10:00:00.000Z');

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    shipment_id: SHIPMENT_ID,
    shop_id: SHOP_ID,
    courier_account_id: COURIER_ACCOUNT_ID,
    awb_raw: 'DL12345',
    awb_normalized: AWB_NORMALIZED,
    movement_state: 'NOT_SHIPPED',
    ...overrides,
  };
}

function mk(pool: FnPool, redis: FakeRedis, events: TrackEvent[] = []) {
  const adapterCaller = {
    call: vi.fn().mockImplementation(
      (_shop: string, _account: string, _method: string, invoke: (a: unknown) => Promise<TrackEvent[]>) =>
        invoke({ track: () => Promise.resolve(events) }),
    ),
  };
  const ingest = { ingestPolledEvents: vi.fn().mockResolvedValue([]) };
  const service = new TrackingPollingService(
    pool.asPool(),
    redis.asRedis(),
    adapterCaller as unknown as AdapterCallerService,
    ingest as unknown as CourierWebhookIngestService,
  );
  return { service, adapterCaller, ingest };
}

describe('TrackingPollingService cohorts (§8.5)', () => {
  it('NEW cohort: CONFIRMED shipments still NOT_SHIPPED, polled every 2h', async () => {
    const pool = new FnPool();
    pool.on(COHORT_SQL, [candidate()]);
    const { service } = mk(pool, new FakeRedis());

    const rows = await service.listPollCandidates('NEW');

    expect(rows).toHaveLength(1);
    const call = pool.matching(COHORT_SQL)[0];
    expect(call.params[0]).toEqual(['NOT_SHIPPED']);
    expect(call.sql).toContain("booking_state = 'CONFIRMED'");
    expect(call.sql).toContain('ca.disabled_at IS NULL');
    expect(POLL_INTERVAL_MS.NEW).toBe(2 * 3600_000);
  });

  it('IN_TRANSIT cohort covers every non-terminal movement state, polled every 4h', async () => {
    const pool = new FnPool();
    pool.on(COHORT_SQL, []);
    const { service } = mk(pool, new FakeRedis());

    await service.listPollCandidates('IN_TRANSIT');

    const states = pool.matching(COHORT_SQL)[0].params[0] as string[];
    expect(states).toEqual([
      'IN_TRANSIT',
      'OUT_FOR_DELIVERY',
      'NDR',
      'RTO_INITIATED',
      'RTO_IN_TRANSIT',
      'RTO_OUT_FOR_DELIVERY',
    ]);
    expect(states).not.toContain('NOT_SHIPPED');
    expect(POLL_INTERVAL_MS.IN_TRANSIT).toBe(4 * 3600_000);
  });

  it('stops at terminal states: a terminal row can never enter a cohort', async () => {
    const pool = new FnPool();
    // Defensive filter: even if a query regression leaked a terminal row.
    pool.on(COHORT_SQL, [
      candidate({ movement_state: 'DELIVERED' }),
      candidate({ movement_state: 'RTO_DELIVERED' }),
      candidate({ movement_state: 'LOST_OR_DAMAGED' }),
      candidate({ movement_state: 'CANCELLED_BY_COURIER' }),
      candidate({ movement_state: 'NOT_SHIPPED' }),
    ]);
    const { service } = mk(pool, new FakeRedis());

    const rows = await service.listPollCandidates('NEW');

    expect(rows).toHaveLength(1);
    expect(rows[0].movement_state).toBe('NOT_SHIPPED');
  });
});

describe('TrackingPollingService.runPollSweep', () => {
  const trackEvents: TrackEvent[] = [
    {
      rawStatus: 'Picked Up',
      occurredAt: '2026-08-01T09:00:00.000Z',
      locationText: 'Bengaluru',
      reasonText: null,
      providerEventId: 'evt-p1',
    },
  ];

  it('polls the cohort via adapter track(awb) and feeds the SAME ingest path (POLL)', async () => {
    const pool = new FnPool();
    pool.on(COHORT_SQL, [candidate()]);
    const redis = new FakeRedis();
    const { service, adapterCaller, ingest } = mk(pool, redis, trackEvents);

    const result = await service.runPollSweep('NEW', T0);

    expect(result).toMatchObject({ cohort: 'NEW', candidates: 1, polled: 1, throttled: 0, failed: 0 });
    expect(adapterCaller.call).toHaveBeenCalledWith(
      SHOP_ID,
      COURIER_ACCOUNT_ID,
      'track',
      expect.any(Function),
    );
    // Events enter through the same raw-table + normalization path.
    expect(ingest.ingestPolledEvents).toHaveBeenCalledWith({
      shopId: SHOP_ID,
      courierAccountId: COURIER_ACCOUNT_ID,
      awb: 'DL12345',
      events: trackEvents,
    });
    // The cadence marker was written.
    expect(redis.store.get(`track:poll:NEW:${SHIPMENT_ID}`)).toBe(String(T0.getTime()));
  });

  it('throttles to the cohort cadence: 1h later is throttled, 3h later polls again', async () => {
    const pool = new FnPool();
    pool.on(COHORT_SQL, [candidate()]);
    const redis = new FakeRedis();
    const { service, adapterCaller } = mk(pool, redis, trackEvents);

    await service.runPollSweep('NEW', T0);
    const plus1h = new Date(T0.getTime() + 3600_000);
    const second = await service.runPollSweep('NEW', plus1h);
    expect(second.throttled).toBe(1);
    expect(second.polled).toBe(0);
    expect(adapterCaller.call).toHaveBeenCalledTimes(1);

    const plus3h = new Date(T0.getTime() + 3 * 3600_000);
    const third = await service.runPollSweep('NEW', plus3h);
    expect(third.polled).toBe(1);
    expect(adapterCaller.call).toHaveBeenCalledTimes(2);
  });

  it('a failed poll is reported (ids only) and NOT throttled — it retries next sweep', async () => {
    const pool = new FnPool();
    pool.on(COHORT_SQL, [candidate()]);
    const redis = new FakeRedis();
    const { service, adapterCaller, ingest } = mk(pool, redis);
    adapterCaller.call.mockRejectedValueOnce(new Error('provider timeout'));

    const result = await service.runPollSweep('NEW', T0);

    expect(result.failed).toBe(1);
    expect(result.failedShipmentIds).toEqual([SHIPMENT_ID]);
    expect(ingest.ingestPolledEvents).not.toHaveBeenCalled();
    expect(redis.store.get(`track:poll:NEW:${SHIPMENT_ID}`)).toBeUndefined();
  });
});
