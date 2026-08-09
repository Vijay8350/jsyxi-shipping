import { describe, expect, it } from 'vitest';
import {
  breakerKey,
  driveBulkBookings,
  driveDashboardReaders,
  driveOutageCatchup,
  driveTrackingEvents,
  DriverContext,
} from '../../scripts/loadtest/drivers';
import { hmacSha256Hex, FetchFn } from '../../scripts/loadtest/lib';
import { LoadTestFixtures } from '../../scripts/loadtest/fixtures';
import { FakeDb, FakeRedis, SHOP } from './helpers';

/**
 * Driver measurement loops with recording fakes — NOT a live load run. Each
 * spec pins one behavior: the §8.5 signing path, the S-21 retry loop, the
 * budget-breach flagging, or the outage breaker toggling.
 */

function fixtures(orderIds: string[] = SHOP.orderIds): LoadTestFixtures {
  return { runId: 't1', shops: [{ ...SHOP, orderIds }] };
}

function okFetch(body: unknown = {}, delayMs = 0): FetchFn & { calls: Array<{ url: string; init?: { headers?: Record<string, string>; body?: string } }> } {
  const calls: Array<{ url: string; init?: { headers?: Record<string, string>; body?: string } }> = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return {
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return Object.assign(fn, { calls });
}

describe('driveTrackingEvents', () => {
  function trackingDb(): FakeDb {
    return new FakeDb()
      .on(/SELECT awb_normalized FROM shipment/, () => ({
        rows: [{ awb_normalized: 'FAKE0000000001' }, { awb_normalized: 'FAKE0000000002' }],
      }))
      .on(/parse_result = 'PENDING'/, () => ({ rows: [{ n: 0 }] }))
      .on(/FROM tracking_event WHERE shop_id/, () => ({ rows: [{ n: 20 }] }));
  }

  it('posts HMAC-signed webhooks to the §8.5 endpoint at the target rate', async () => {
    const db = trackingDb();
    const fetchFn = okFetch({ received: true });
    const ctx: DriverContext = { db, redis: new FakeRedis(), baseUrl: 'http://localhost:3000', fetchFn };

    const res = await driveTrackingEvents(ctx, fixtures().shops[0]!, {
      eventsPerSecond: 20,
      durationSeconds: 1,
      runId: 't1',
    });

    expect(fetchFn.calls.length).toBe(20);
    expect(fetchFn.calls[0]?.url).toBe('http://localhost:3000/hooks/FAKE/lt_test_token');
    // §8.5: the signature is a valid HMAC-SHA256 over the exact raw body.
    const body = fetchFn.calls[0]?.init?.body as string;
    const sig = fetchFn.calls[0]?.init?.headers?.['x-jsyxi-signature'] as string;
    expect(sig).toBe(hmacSha256Hex(SHOP.webhookSecret, body));
    // Unique event ids cycling across the booked AWB pool.
    const ids = new Set(fetchFn.calls.map((c) => JSON.parse(c.init?.body as string).event_id));
    expect(ids.size).toBe(20);

    expect(res.metrics.sent).toBe(20);
    expect(res.metrics.acked).toBe(20);
    expect(res.metrics.errors).toBe(0);
    expect(res.metrics.trackingEvents).toBe(20);
    expect(res.metrics.normalizationLagMs).toBeGreaterThanOrEqual(0);
    expect(res.checks[0]?.ok).toBe(true); // instant fake fetch → p99 < 100 ms
  });

  it('flags the §8.5 budget breach when ack p99 exceeds 100 ms', async () => {
    const db = trackingDb();
    const ctx: DriverContext = {
      db, redis: new FakeRedis(), baseUrl: 'http://localhost:3000',
      fetchFn: okFetch({ received: true }, 150), // 150 ms per ack
    };
    const res = await driveTrackingEvents(ctx, fixtures().shops[0]!, {
      eventsPerSecond: 10,
      durationSeconds: 1,
    });
    expect(res.metrics.ackP99Ms).toBeGreaterThanOrEqual(100);
    expect(res.checks[0]?.check).toBe('webhook ack p99');
    expect(res.checks[0]?.ok).toBe(false);
  });

  it('counts non-200 acks as errors', async () => {
    const db = trackingDb();
    const failFetch: FetchFn = async () => ({
      status: 401,
      json: async () => ({}),
      text: async () => 'unauthorized',
    });
    const ctx: DriverContext = { db, redis: new FakeRedis(), baseUrl: 'http://x', fetchFn: failFetch };
    const res = await driveTrackingEvents(ctx, fixtures().shops[0]!, {
      eventsPerSecond: 5,
      durationSeconds: 1,
    });
    expect(res.metrics.acked).toBe(0);
    expect(res.metrics.errors).toBe(5);
  });

  it('refuses to run without a booked AWB pool', async () => {
    const db = new FakeDb(); // no awb handler → zero rows
    const ctx: DriverContext = { db, redis: new FakeRedis(), baseUrl: 'http://x', fetchFn: okFetch() };
    await expect(
      driveTrackingEvents(ctx, fixtures().shops[0]!, { eventsPerSecond: 1, durationSeconds: 1 }),
    ).rejects.toThrow(/CONFIRMED shipment/);
  });
});

describe('driveBulkBookings', () => {
  function bulkDb(opts: { failed?: number; state?: string } = {}): FakeDb {
    const state = opts.state ?? 'SUCCEEDED';
    return new FakeDb()
      .on(/FROM booking_batch/, () => ({
        rows: [{ state, processed: 10, succeeded: 10 - (opts.failed ?? 0), failed: opts.failed ?? 0 }],
      }))
      .on(/booking_state = ANY/, (params) => ({
        rows: [{ n: (params[1] as string[]).includes('CONFIRMED') ? 20 : 0 }],
      }))
      .on(/GROUP BY awb_normalized/, () => ({ rows: [{ n: 0 }] }));
  }

  it('enqueues the jobs, measures completion and per-order success', async () => {
    const fetchFn = okFetch({ created: true, batchId: 'b-1', state: 'QUEUED', total: 10 });
    const ctx: DriverContext = { db: bulkDb(), redis: new FakeRedis(), baseUrl: 'http://x', fetchFn };
    const res = await driveBulkBookings(ctx, fixtures(['o1', 'o2']), { jobs: 2, ordersPerJob: 1 });

    expect(fetchFn.calls.length).toBe(2);
    expect(fetchFn.calls[0]?.init?.headers?.cookie).toContain('jsyxi_session=');
    expect(JSON.parse(fetchFn.calls[0]?.init?.body as string)).toEqual({ orderIds: ['o1'] });
    expect(res.metrics.jobs).toBe(2);
    expect(res.metrics.jobsSucceeded).toBe(2);
    expect(res.metrics.ordersSucceeded).toBe(20); // 2 batches × 10 (fake row)
    expect(res.metrics.duplicateAwbs).toBe(0);
    expect(res.checks.every((c) => c.ok)).toBe(true);
  });

  it('re-submits on the S-21 429 refusal and counts refusals', async () => {
    let n = 0;
    const flaky: FetchFn = async () => {
      n += 1;
      if (n === 1) return { status: 429, json: async () => ({ code: 'BULK_CONCURRENCY_EXCEEDED' }), text: async () => '' };
      return { status: 201, json: async () => ({ created: true, batchId: `b-${n}` }), text: async () => '' };
    };
    const ctx: DriverContext = { db: bulkDb(), redis: new FakeRedis(), baseUrl: 'http://x', fetchFn: flaky };
    const res = await driveBulkBookings(ctx, fixtures(['o1']), { jobs: 1, ordersPerJob: 1 });
    expect(res.metrics.s21Refusals).toBe(1);
    expect(res.metrics.jobs).toBe(1);
  });

  it('breaches the budget when a batch reports failed orders (INV-20)', async () => {
    const ctx: DriverContext = {
      db: bulkDb({ failed: 3, state: 'PARTIAL' }),
      redis: new FakeRedis(),
      baseUrl: 'http://x',
      fetchFn: okFetch({ created: true, batchId: 'b-1' }),
    };
    const res = await driveBulkBookings(ctx, fixtures(['o1']), { jobs: 1, ordersPerJob: 1 });
    expect(res.metrics.ordersFailed).toBe(3);
    expect(res.checks.find((c) => c.check === 'failed orders')?.ok).toBe(false);
  });
});

describe('driveDashboardReaders', () => {
  it('measures latency and as-of freshness within budget', async () => {
    const fetchFn = okFetch({ asOf: new Date().toISOString(), stale: false });
    const ctx: DriverContext = { db: new FakeDb(), redis: new FakeRedis(), baseUrl: 'http://x', fetchFn };
    const res = await driveDashboardReaders(ctx, fixtures().shops[0]!, { concurrency: 3, durationSeconds: 1 });
    expect(fetchFn.calls.length).toBeGreaterThan(0);
    expect(fetchFn.calls[0]?.url).toBe('http://x/dashboard?view=live');
    expect(fetchFn.calls[0]?.init?.headers?.cookie).toContain('jsyxi_session=');
    expect(res.metrics.reads).toBe(fetchFn.calls.length);
    expect(res.metrics.errors).toBe(0);
    expect(res.metrics.staleResponses).toBe(0);
    expect(res.checks[0]?.ok).toBe(true);
  });

  it('breaches the §5.1 1 s p99 budget on slow reads', async () => {
    const ctx: DriverContext = {
      db: new FakeDb(), redis: new FakeRedis(), baseUrl: 'http://x',
      fetchFn: okFetch({ asOf: null, stale: true }, 1100),
    };
    const res = await driveDashboardReaders(ctx, fixtures().shops[0]!, { concurrency: 2, durationSeconds: 1 });
    expect(res.metrics.p99Ms).toBeGreaterThan(1000);
    expect(res.checks[0]?.ok).toBe(false);
  });
});

describe('driveOutageCatchup', () => {
  function outageDb(): FakeDb {
    return new FakeDb()
      .on(/FROM booking_batch/, () => ({
        rows: [{ state: 'SUCCEEDED', processed: 1, succeeded: 1, failed: 0 }],
      }))
      .on(/booking_state = ANY/, (params) => ({
        rows: [{ n: (params[1] as string[]).includes('CONFIRMED') ? 1 : 0 }],
      }))
      .on(/GROUP BY awb_normalized/, () => ({ rows: [{ n: 0 }] }));
  }

  it('opens and restores the §8.2 circuit breaker, then verifies INV-6', async () => {
    const redis = new FakeRedis();
    const fetchFn = okFetch({ created: true, batchId: 'b-1' });
    const ctx: DriverContext = { db: outageDb(), redis, baseUrl: 'http://x', fetchFn };

    const res = await driveOutageCatchup(ctx, fixtures().shops[0]!, { orders: 1, outageSeconds: 0 });

    const key = breakerKey(SHOP.courierAccountId);
    expect(key).toBe(`cf:cb:${SHOP.courierAccountId}`);
    // PAUSE: open_until was hset in the future; RESTORE: the key was deleted.
    const pause = redis.hsets.find((h) => h.key === key && h.field === 'open_until');
    expect(Number(pause?.value)).toBeGreaterThan(Date.now());
    expect(redis.deleted).toContain(key);

    expect(res.metrics.confirmed).toBe(1);
    expect(res.metrics.duplicateAwbs).toBe(0);
    expect(res.metrics.drainMs).toBeGreaterThanOrEqual(0);
    expect(res.checks.every((c) => c.ok)).toBe(true);
  });

  it('breaches on any duplicate AWB after catch-up (INV-6)', async () => {
    const redis = new FakeRedis();
    const db = outageDb().on(/GROUP BY awb_normalized/, () => ({ rows: [{ n: 2 }] }));
    // Re-register the drain query AFTER the dupe override so ordering stays right.
    const ctx: DriverContext = {
      db, redis, baseUrl: 'http://x',
      fetchFn: okFetch({ created: true, batchId: 'b-1' }),
    };
    const res = await driveOutageCatchup(ctx, fixtures().shops[0]!, { orders: 1, outageSeconds: 0 });
    expect(res.metrics.duplicateAwbs).toBe(2);
    expect(res.checks.find((c) => c.check.includes('duplicate AWB'))?.ok).toBe(false);
  });
});
