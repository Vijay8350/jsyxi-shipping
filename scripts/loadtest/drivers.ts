import {
  buildTrackingWebhookPayload,
  budgetCheck,
  BudgetCheck,
  computeLatencyStats,
  FetchFn,
  hmacSha256Hex,
  pollUntil,
  Queryable,
  RedisLike,
  ScenarioResult,
  sleep,
} from './lib';
import { FixtureShop, LoadTestFixtures } from './fixtures';

/**
 * §5.1 load drivers. Each function drives one capacity line item against the
 * running local stack and returns measured stats plus its §5.1 budget checks
 * (evaluated in lib.ts; run.ts exits non-zero on any breach).
 *
 * Drivers are deliberately dependency-injected (Queryable / RedisLike /
 * FetchFn) so test/loadtest can exercise the measurement loops with
 * recording fakes — no live stack needed for unit tests.
 */

export interface DriverContext {
  db: Queryable;
  redis: RedisLike;
  baseUrl: string;
  fetchFn?: FetchFn;
}

/* -------------------------------------------------------------------------
 * Shared HTTP helpers.
 * ---------------------------------------------------------------------- */

function resolveFetch(ctx: DriverContext): FetchFn {
  const f = ctx.fetchFn ?? (globalThis.fetch as unknown as FetchFn | undefined);
  if (!f) throw new Error('no fetch implementation available (Node 18+ required)');
  return f;
}

function sessionHeaders(shop: FixtureShop): Record<string, string> {
  // SESSION_COOKIE ('jsyxi_session', session.types.ts) — the fixture session
  // row resolves via the DB fallback path in SessionService.
  return { cookie: `jsyxi_session=${encodeURIComponent(shop.sessionToken)}` };
}

async function enqueueBulkBatch(
  ctx: DriverContext,
  shop: FixtureShop,
  orderIds: string[],
): Promise<{ status: number; batchId: string | null }> {
  const res = await resolveFetch(ctx)(`${ctx.baseUrl}/booking/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...sessionHeaders(shop) },
    body: JSON.stringify({ orderIds }),
  });
  if (res.status !== 200 && res.status !== 201) return { status: res.status, batchId: null };
  const body = (await res.json()) as { batchId?: string };
  return { status: res.status, batchId: body.batchId ?? null };
}

interface BatchRow {
  state: string;
  processed: number;
  succeeded: number;
  failed: number;
}

async function readBatch(db: Queryable, shopId: string, batchId: string): Promise<BatchRow | null> {
  const { rows } = await db.query(
    `SELECT state, processed, succeeded, failed FROM booking_batch
      WHERE shop_id = $1 AND batch_id = $2`,
    [shopId, batchId],
  );
  return (rows[0] as BatchRow | undefined) ?? null;
}

const TERMINAL_BATCH_STATES = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED'];

/** INV-6: duplicate ACTIVE AWBs must be impossible; any row here is a breach. */
export async function countDuplicateAwbs(db: Queryable, shopId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM (
       SELECT awb_normalized FROM shipment
        WHERE shop_id = $1 AND awb_normalized IS NOT NULL AND booking_state <> 'VOID'
        GROUP BY awb_normalized HAVING count(*) > 1
     ) d`,
    [shopId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function countShipmentsByState(
  db: Queryable,
  shopId: string,
  states: string[],
): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM shipment
      WHERE shop_id = $1 AND booking_state = ANY($2::text[])`,
    [shopId, states],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Wait until no shipment of the shop is still in flight (booking queue
 *  drained). Returns wait ms or null on timeout. */
export async function waitForBookingDrain(
  db: Queryable,
  shopId: string,
  timeoutMs: number,
): Promise<number | null> {
  return pollUntil(
    async () => (await countShipmentsByState(db, shopId, ['QUEUED', 'SUBMITTED'])) === 0,
    { timeoutMs, intervalMs: 500 },
  );
}

/* -------------------------------------------------------------------------
 * §5.1 — 150,000 normalized tracking events/day (platform-wide steady
 * state), ack budget < 100 ms (§8.5). Drives the real ingest path:
 * POST /hooks/FAKE/:token with a valid per-account HMAC.
 * ---------------------------------------------------------------------- */

export interface TrackingDriveOptions {
  eventsPerSecond: number;
  durationSeconds: number;
  /** Post-hoc normalization convergence deadline (§8.5: normalization is
   *  asynchronous after the durable ack). */
  convergenceTimeoutMs?: number;
  /** Max in-flight webhook POSTs (keeps the laptop run honest about its own
   *  client-side saturation). */
  maxInFlight?: number;
  /** Embedded in every synthetic event_id (dedupe keys stay unique per run). */
  runId?: string;
  now?: () => number;
}

const TRACK_STATUSES = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'];

export async function driveTrackingEvents(
  ctx: DriverContext,
  shop: FixtureShop,
  opts: TrackingDriveOptions,
): Promise<ScenarioResult> {
  const fetchFn = resolveFetch(ctx);
  const now = opts.now ?? (() => Date.now());
  const total = Math.max(1, Math.floor(opts.eventsPerSecond * opts.durationSeconds));
  const maxInFlight = opts.maxInFlight ?? 50;

  // Events need a real AWB to normalize against (an unknown AWB lands as
  // AWB_QUARANTINED and produces no tracking_event row). The caller books a
  // pool first (run.ts); here we read whatever is confirmed.
  const { rows: awbRows } = await ctx.db.query(
    `SELECT awb_normalized FROM shipment
      WHERE shop_id = $1 AND awb_normalized IS NOT NULL AND booking_state = 'CONFIRMED'
      ORDER BY booked_at LIMIT 500`,
    [shop.shopId],
  );
  const awbs = awbRows.map((r: { awb_normalized: string }) => r.awb_normalized);
  if (awbs.length === 0) {
    throw new Error('tracking driver needs at least one CONFIRMED shipment (book a pool first)');
  }

  const url = `${ctx.baseUrl}/hooks/FAKE/${shop.webhookUrlToken}`;
  const latencies: number[] = [];
  let sent = 0;
  let acked = 0;
  let errors = 0;
  let inFlight = 0;
  const start = now();
  const intervalMs = 1000 / opts.eventsPerSecond;

  const sendOne = async (seq: number): Promise<void> => {
    const payload = buildTrackingWebhookPayload({
      runId: opts.runId ?? 'lt',
      seq,
      awb: awbs[seq % awbs.length] as string,
      status: TRACK_STATUSES[seq % TRACK_STATUSES.length] as string,
      occurredAt: new Date(now()).toISOString(),
    });
    const body = JSON.stringify(payload);
    const t0 = now();
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-jsyxi-signature': hmacSha256Hex(shop.webhookSecret, body),
        },
        body,
      });
      await res.text(); // drain
      latencies.push(now() - t0);
      if (res.status === 200) acked += 1;
      else errors += 1;
    } catch {
      errors += 1;
    } finally {
      inFlight -= 1;
    }
  };

  // Fixed-rate scheduler: one release every 1000/eps ms, bounded in-flight.
  const pending: Promise<void>[] = [];
  for (let seq = 0; seq < total; seq += 1) {
    const target = start + seq * intervalMs;
    const wait = target - now();
    if (wait > 0) await sleep(wait);
    while (inFlight >= maxInFlight) await sleep(1);
    inFlight += 1;
    sent += 1;
    pending.push(sendOne(seq));
  }
  await Promise.all(pending);
  const wallMs = now() - start;

  // Post-hoc: §8.5 persists raw durably BEFORE the ack; normalization is
  // async. The poll starts after the last send settles, so the time until no
  // PENDING raw rows remain is the normalization lag behind the final ack.
  const pendingTimeout = opts.convergenceTimeoutMs ?? 120_000;
  const lag = await pollUntil(
    async () => {
      const { rows } = await ctx.db.query(
        `SELECT count(*)::int AS n FROM tracking_event_raw
          WHERE shop_id = $1 AND parse_result = 'PENDING'`,
        [shop.shopId],
      );
      return Number(rows[0]?.n ?? 0) === 0;
    },
    { timeoutMs: pendingTimeout, intervalMs: 250 },
  );
  const normalizationLagMs = lag === null ? -1 : lag;

  const { rows: evRows } = await ctx.db.query(
    `SELECT count(*)::int AS n FROM tracking_event WHERE shop_id = $1`,
    [shop.shopId],
  );
  const trackingEvents = Number(evRows[0]?.n ?? 0);

  const stats = computeLatencyStats(latencies);
  const checks: BudgetCheck[] = [
    budgetCheck('tracking', 'webhook ack p99', '< 100 ms (§8.5)', stats.p99Ms, stats.p99Ms < 100, (v) => `${v} ms`),
  ];
  return {
    scenario: 'tracking',
    metrics: {
      sent,
      acked,
      errors,
      throughputEps: wallMs > 0 ? (acked / wallMs) * 1000 : 0,
      ackP50Ms: stats.p50Ms,
      ackP95Ms: stats.p95Ms,
      ackP99Ms: stats.p99Ms,
      normalizationLagMs,
      trackingEvents,
    },
    checks,
  };
}

/* -------------------------------------------------------------------------
 * §5.1 — 20 simultaneous 1,000-shipment bulk jobs (platform-wide) and
 * 10,000 shipments/day. S-21 caps each shop at 2 concurrent bulk jobs:
 * with fewer shops than jobs the driver re-submits refused jobs (429) —
 * the refusal count itself is the evidence that one merchant cannot starve
 * the shared workers.
 * ---------------------------------------------------------------------- */

export interface BulkDriveOptions {
  jobs: number;
  ordersPerJob: number;
  batchTimeoutMs?: number;
  drainTimeoutMs?: number;
  /** Skip waiting for booking-worker CONFIRMED (batch results only). */
  skipDrain?: boolean;
}

export async function driveBulkBookings(
  ctx: DriverContext,
  fixtures: LoadTestFixtures,
  opts: BulkDriveOptions,
): Promise<ScenarioResult> {
  // Round-robin job → shop; each shop's DRAFT orders are consumed in order.
  const pools = fixtures.shops.map((s) => ({ shop: s, remaining: [...s.orderIds] }));
  const start = Date.now();
  let s21Refusals = 0;
  const batches: Array<{ shop: FixtureShop; batchId: string }> = [];

  for (let j = 0; j < opts.jobs; j += 1) {
    const pool = pools[j % pools.length] as (typeof pools)[number];
    const orderIds = pool.remaining.splice(0, opts.ordersPerJob);
    if (orderIds.length === 0) {
      throw new Error(
        `bulk driver: not enough fixture orders for job ${j} (need ${opts.ordersPerJob})`,
      );
    }
    // S-21: at most 2 concurrent jobs per shop — a 429-style structured
    // refusal. Re-submit until accepted; refusals are the quota working.
    for (;;) {
      const res = await enqueueBulkBatch(ctx, pool.shop, orderIds);
      if (res.batchId) {
        batches.push({ shop: pool.shop, batchId: res.batchId });
        break;
      }
      if (res.status === 429) {
        s21Refusals += 1;
        await sleep(500);
        continue;
      }
      throw new Error(`bulk enqueue failed with HTTP ${res.status} (job ${j})`);
    }
  }

  // Wait for every batch to reach a §3.27 terminal state.
  const perBatchTimeout = opts.batchTimeoutMs ?? 15 * 60_000;
  let jobsSucceeded = 0;
  let jobsPartial = 0;
  let jobsFailed = 0;
  let ordersSucceeded = 0;
  let ordersFailed = 0;
  let timedOutBatches = 0;
  for (const { shop, batchId } of batches) {
    const wait = await pollUntil(
      async () => {
        const b = await readBatch(ctx.db, shop.shopId, batchId);
        return b !== null && TERMINAL_BATCH_STATES.includes(b.state);
      },
      { timeoutMs: perBatchTimeout, intervalMs: 500 },
    );
    const b = await readBatch(ctx.db, shop.shopId, batchId);
    if (wait === null || !b) {
      timedOutBatches += 1;
      jobsFailed += 1;
      continue;
    }
    if (b.state === 'SUCCEEDED') jobsSucceeded += 1;
    else if (b.state === 'PARTIAL') jobsPartial += 1;
    else jobsFailed += 1;
    ordersSucceeded += b.succeeded;
    ordersFailed += b.failed;
  }
  const wallMs = Date.now() - start;

  // The batch records per-order QUEUED; the AWB lands asynchronously in the
  // §5.7 booking worker. Wait for the drain, then check INV-6.
  let confirmed = 0;
  let duplicateAwbs = 0;
  let drainTimedOut = 0;
  if (!opts.skipDrain) {
    for (const shop of fixtures.shops) {
      const drained = await waitForBookingDrain(ctx.db, shop.shopId, opts.drainTimeoutMs ?? 10 * 60_000);
      if (drained === null) drainTimedOut += 1;
      confirmed += await countShipmentsByState(ctx.db, shop.shopId, ['CONFIRMED']);
      duplicateAwbs += await countDuplicateAwbs(ctx.db, shop.shopId);
    }
  }

  const checks: BudgetCheck[] = [
    budgetCheck('bulk', 'failed orders', '0 (§5.1, INV-20)', ordersFailed, ordersFailed === 0),
    budgetCheck('bulk', 'failed/timeout batches', '0 (§5.1)', jobsFailed + timedOutBatches, jobsFailed + timedOutBatches === 0),
  ];
  if (!opts.skipDrain) {
    checks.push(
      budgetCheck('bulk', 'duplicate AWBs', '0 (INV-6)', duplicateAwbs, duplicateAwbs === 0),
    );
  }
  return {
    scenario: 'bulk',
    metrics: {
      jobs: batches.length,
      jobsSucceeded,
      jobsPartial,
      jobsFailed,
      timedOutBatches,
      ordersSucceeded,
      ordersFailed,
      s21Refusals,
      confirmedShipments: confirmed,
      duplicateAwbs,
      wallMs,
      ordersPerSecond: wallMs > 0 ? (ordersSucceeded / wallMs) * 1000 : 0,
    },
    checks,
  };
}

/* -------------------------------------------------------------------------
 * §5.1 — 250 concurrent dashboard actors. Measures read latency against the
 * 1 s p99 budget and the as-of freshness the payload carries (§5.2: the
 * 75-minute staleness bound; the payload's own `stale` flag is the app's
 * verdict and is counted, not trusted silently).
 * ---------------------------------------------------------------------- */

export interface DashboardDriveOptions {
  concurrency: number;
  durationSeconds: number;
  now?: () => number;
}

export async function driveDashboardReaders(
  ctx: DriverContext,
  shop: FixtureShop,
  opts: DashboardDriveOptions,
): Promise<ScenarioResult> {
  const fetchFn = resolveFetch(ctx);
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + opts.durationSeconds * 1000;
  const url = `${ctx.baseUrl}/dashboard?view=live`;
  const headers = sessionHeaders(shop);

  const latencies: number[] = [];
  let reads = 0;
  let errors = 0;
  let staleResponses = 0;
  let maxAsOfAgeMs = 0;

  const worker = async (): Promise<void> => {
    while (now() < deadline) {
      const t0 = now();
      try {
        const res = await fetchFn(url, { headers });
        const body = (await res.json()) as { asOf?: string | null; stale?: boolean };
        const latency = now() - t0;
        if (res.status === 200) {
          latencies.push(latency);
          reads += 1;
          if (body.stale) staleResponses += 1;
          if (body.asOf) {
            maxAsOfAgeMs = Math.max(maxAsOfAgeMs, now() - Date.parse(body.asOf));
          }
        } else {
          errors += 1;
        }
      } catch {
        errors += 1;
      }
    }
  };
  const start = now();
  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
  const wallMs = now() - start;

  const stats = computeLatencyStats(latencies);
  const checks: BudgetCheck[] = [
    budgetCheck('dashboard', 'read p99', '≤ 1000 ms (§5.1)', stats.p99Ms, stats.p99Ms <= 1000, (v) => `${v} ms`),
  ];
  return {
    scenario: 'dashboard',
    metrics: {
      concurrency: opts.concurrency,
      reads,
      errors,
      throughputRps: wallMs > 0 ? (reads / wallMs) * 1000 : 0,
      p50Ms: stats.p50Ms,
      p95Ms: stats.p95Ms,
      p99Ms: stats.p99Ms,
      staleResponses,
      maxAsOfAgeMs,
    },
    checks,
  };
}

/* -------------------------------------------------------------------------
 * §5.1 — two-hour provider-outage catch-up (time-compressed locally).
 *
 * Outage simulation uses an EXISTING app-side hook: the §8.2 circuit breaker
 * state lives in Redis at cf:cb:{courier_account_id} (transport-policy.ts).
 * Opening it makes every adapter call fail fast pre-call (CircuitOpenError),
 * which the booking worker rethrows so BullMQ retries the SAME booking
 * intent — no create is issued (INV-5), exactly like a real provider
 * outage. Restoring = deleting the key; the backlog then drains.
 *
 * Note: booking jobs carry attempts=5 with exponential backoff from 30 s
 * (booking-queue.ts). An outage longer than the retry window (~7.5 min)
 * exhausts attempts; those shipments stay SUBMITTED and are reported as
 * such — a real two-hour outage additionally needs the §8.6 replay path,
 * which is outside this harness (see run summary).
 * ---------------------------------------------------------------------- */

export interface OutageDriveOptions {
  orders: number;
  outageSeconds: number;
  drainTimeoutMs?: number;
}

export function breakerKey(courierAccountId: string): string {
  return `cf:cb:${courierAccountId}`;
}

export async function driveOutageCatchup(
  ctx: DriverContext,
  shop: FixtureShop,
  opts: OutageDriveOptions,
): Promise<ScenarioResult> {
  const orderIds = shop.orderIds.slice(0, opts.orders);
  if (orderIds.length === 0) throw new Error('outage driver: no fixture orders left to book');
  const key = breakerKey(shop.courierAccountId);

  // PAUSE: open the breaker well past the planned restore time.
  await ctx.redis.hset(key, 'open_until', String(Date.now() + (opts.outageSeconds + 120) * 1000));

  // Accumulate booking attempts (compressed stand-in for 2h of merchant
  // traffic): with a NONE-cost service, queueBooking performs no adapter
  // call, so batches complete and intents queue while the worker retries.
  const enqueued = await enqueueBulkBatch(ctx, shop, orderIds);
  if (!enqueued.batchId) {
    await ctx.redis.del(key);
    throw new Error(`outage driver: bulk enqueue failed with HTTP ${enqueued.status}`);
  }
  await pollUntil(
    async () => {
      const b = await readBatch(ctx.db, shop.shopId, enqueued.batchId as string);
      return b !== null && TERMINAL_BATCH_STATES.includes(b.state);
    },
    { timeoutMs: 10 * 60_000, intervalMs: 500 },
  );

  // Hold the outage, then RESTORE and measure the catch-up drain.
  await sleep(opts.outageSeconds * 1000);
  const restoredAt = Date.now();
  await ctx.redis.del(key);

  const drain = await waitForBookingDrain(ctx.db, shop.shopId, opts.drainTimeoutMs ?? 15 * 60_000);
  const confirmed = await countShipmentsByState(ctx.db, shop.shopId, ['CONFIRMED']);
  const stuck = await countShipmentsByState(ctx.db, shop.shopId, ['QUEUED', 'SUBMITTED']);
  const failed = await countShipmentsByState(ctx.db, shop.shopId, ['FAILED', 'OUTCOME_UNKNOWN']);
  const duplicateAwbs = await countDuplicateAwbs(ctx.db, shop.shopId);
  const drainMs = drain === null ? -1 : drain;

  const checks: BudgetCheck[] = [
    budgetCheck('outage', 'duplicate AWBs after catch-up', '0 (INV-6)', duplicateAwbs, duplicateAwbs === 0),
    budgetCheck('outage', 'drain completed', 'within timeout', drain === null ? 1 : 0, drain !== null),
  ];
  return {
    scenario: 'outage',
    metrics: {
      attempts: orderIds.length,
      outageSeconds: opts.outageSeconds,
      drainMs,
      confirmed,
      stuckInFlight: stuck,
      failedOrUnknown: failed,
      duplicateAwbs,
    },
    checks,
  };
}
