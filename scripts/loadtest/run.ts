/**
 * §5.1 load-test orchestrator.
 *
 * Usage:
 *   npx tsx scripts/loadtest/run.ts --scenario=all [--scale=laptop] [--cleanup]
 *   (package.json "loadtest": "tsx scripts/loadtest/run.ts" — see the handoff
 *   note; adding it is a shared-file change outside this harness's scope.)
 *
 * Scenarios (--scenario=tracking|bulk|dashboard|outage|all):
 *   tracking   §5.1 150k normalized events/day — webhook ack latency (<100 ms
 *              p99, §8.5) + post-hoc normalization lag.
 *   bulk       §5.1 20 simultaneous 1,000-shipment bulk jobs / 10k shipments
 *              per day — batch completion, per-order success, INV-6 AWB
 *              uniqueness. S-21 per-shop quota (2 concurrent jobs) refusals
 *              are counted: the harness proves one merchant cannot starve
 *              the shared workers by oversubscribing a single shop.
 *   dashboard  §5.1 250 concurrent dashboard actors — read latency (p99 ≤ 1s)
 *              and §5.2 as-of freshness.
 *   outage     §5.1 two-hour provider-outage catch-up (time-compressed) via
 *              the §8.2 circuit breaker (Redis cf:cb:{accountId}) — measures
 *              drain time and re-verifies INV-6.
 *
 * Scales (--scale=laptop|full; laptop is the default):
 *   laptop = 1/100th of the §5.1 envelope, sized for a developer laptop:
 *     25 eps × 60 s tracking (1,500 events = 150k/100), 20 jobs × 10 orders
 *     bulk (200 = 20,000/100) against ONE shop (so S-21 refusals are
 *     exercised), 25 dashboard readers × 60 s, 100-order outage × 30 s.
 *   full = the real envelope and NEEDS real hardware plus tuned workers:
 *     25 eps × 6,000 s tracking (a full 150k day, time-compressed), 20 jobs
 *     × 1,000 orders across 10 shops (2 concurrent each, honoring S-21),
 *     250 dashboard readers × 300 s, 1,000-order outage × 120 s. NOTE: a
 *     true two-hour outage exceeds the booking queue's BullMQ retry window
 *     (attempts=5, exponential from 30 s); beyond ~7.5 min jobs exhaust and
 *     catch-up needs the §8.6 replay path, which this harness only reports.
 *
 * Env: DATABASE_URL (localhost ONLY — hard guard, INV-19: fixtures are
 * LIVE-mode), REDIS_URL, MASTER_KEY_HEX (must match the running app),
 * LOADTEST_BASE_URL (default http://localhost:3000), plus per-scenario
 * LOADTEST_* overrides (see below).
 *
 * Exit codes: 0 = all §5.1 budgets met; 1 = a budget was breached;
 * 2 = usage/config/guard error.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { createFixtures, destroyFixtures, LoadTestFixtures } from './fixtures';
import {
  driveBulkBookings,
  driveDashboardReaders,
  driveOutageCatchup,
  driveTrackingEvents,
  DriverContext,
} from './drivers';
import {
  assertLocalDatabaseUrl,
  exitCodeForResults,
  formatResultTable,
  LoadtestGuardError,
  ScenarioResult,
} from './lib';

type ScenarioName = 'tracking' | 'bulk' | 'dashboard' | 'outage' | 'all';

interface Cli {
  scenario: ScenarioName;
  scale: 'laptop' | 'full';
  cleanup: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { scenario: 'all', scale: 'laptop', cleanup: false, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') cli.help = true;
    else if (arg === '--cleanup') cli.cleanup = true;
    else if (arg.startsWith('--scenario=')) cli.scenario = arg.slice(11) as ScenarioName;
    else if (arg.startsWith('--scale=')) cli.scale = arg.slice(8) as 'laptop' | 'full';
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['tracking', 'bulk', 'dashboard', 'outage', 'all'].includes(cli.scenario)) {
    throw new Error(`unknown --scenario=${cli.scenario}`);
  }
  if (!['laptop', 'full'].includes(cli.scale)) {
    throw new Error(`unknown --scale=${cli.scale}`);
  }
  return cli;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** The two scale profiles (see header). Every number is env-overridable. */
function scaleConfig(scale: 'laptop' | 'full') {
  const base =
    scale === 'full'
      ? { shops: 10, ordersPerShop: 2500, trackingEps: 25, trackingSeconds: 6000,
          bulkJobs: 20, bulkOrdersPerJob: 1000, dashboardConcurrency: 250,
          dashboardSeconds: 300, outageOrders: 1000, outageSeconds: 120 }
      : { shops: 1, ordersPerShop: 1500, trackingEps: 25, trackingSeconds: 60,
          bulkJobs: 20, bulkOrdersPerJob: 10, dashboardConcurrency: 25,
          dashboardSeconds: 60, outageOrders: 100, outageSeconds: 30 };
  return {
    shops: envInt('LOADTEST_SHOPS', base.shops),
    ordersPerShop: envInt('LOADTEST_ORDERS_PER_SHOP', base.ordersPerShop),
    trackingEps: envInt('LOADTEST_TRACKING_EPS', base.trackingEps),
    trackingSeconds: envInt('LOADTEST_TRACKING_SECONDS', base.trackingSeconds),
    bulkJobs: envInt('LOADTEST_BULK_JOBS', base.bulkJobs),
    bulkOrdersPerJob: envInt('LOADTEST_BULK_ORDERS_PER_JOB', base.bulkOrdersPerJob),
    dashboardConcurrency: envInt('LOADTEST_DASHBOARD_CONCURRENCY', base.dashboardConcurrency),
    dashboardSeconds: envInt('LOADTEST_DASHBOARD_SECONDS', base.dashboardSeconds),
    outageOrders: envInt('LOADTEST_OUTAGE_ORDERS', base.outageOrders),
    outageSeconds: envInt('LOADTEST_OUTAGE_SECONDS', base.outageSeconds),
  };
}

/** The tracking driver normalizes against real AWBs — book a small pool
 *  first when the shop has no CONFIRMED shipments yet. */
async function ensureBookedPool(
  ctx: DriverContext,
  fixtures: LoadTestFixtures,
  poolSize: number,
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const shop of fixtures.shops) {
    const { rows } = await ctx.db.query(
      `SELECT count(*)::int AS n FROM shipment
        WHERE shop_id = $1 AND booking_state = 'CONFIRMED'`,
      [shop.shopId],
    );
    if (Number(rows[0]?.n ?? 0) >= poolSize) continue;
    const jobs = Math.ceil(poolSize / 10);
    const res = await driveBulkBookings(ctx, fixtures, { jobs, ordersPerJob: 10 });
    // Not a §5.1 bulk run — just AWB pool preparation for the tracking drive.
    results.push({ ...res, scenario: 'bulk-pool', checks: [] });
    break; // one pool run covers the (single-shop) tracking fixture
  }
  return results;
}

async function main(): Promise<number> {
  let cli: Cli;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  if (cli.help) {
    console.log('npx tsx scripts/loadtest/run.ts --scenario=tracking|bulk|dashboard|outage|all [--scale=laptop|full] [--cleanup]');
    return 0;
  }

  const databaseUrl = process.env.DATABASE_URL ?? '';
  // HARD GUARD (INV-19): never against a non-local database.
  assertLocalDatabaseUrl(databaseUrl);
  const masterKeyHex = process.env.MASTER_KEY_HEX ?? '';
  if (!masterKeyHex) {
    console.error('MASTER_KEY_HEX is required (fixtures encrypt credentials with the app envelope format)');
    return 2;
  }
  const cfg = scaleConfig(cli.scale);
  const baseUrl = (process.env.LOADTEST_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

  const pool = new Pool({ connectionString: databaseUrl });
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const ctx: DriverContext = { db: pool, redis, baseUrl };
  console.log(
    `loadtest: scenario=${cli.scenario} scale=${cli.scale} shops=${cfg.shops} ` +
      `orders/shop=${cfg.ordersPerShop} base=${baseUrl}`,
  );

  const results: ScenarioResult[] = [];
  let fixtures: LoadTestFixtures | null = null;
  try {
    fixtures = await createFixtures(pool, {
      shopCount: cfg.shops,
      ordersPerShop: cfg.ordersPerShop,
      masterKeyHex,
    });
    console.log(`fixtures ready: run=${fixtures.runId}`);

    const wants = (s: ScenarioName) => cli.scenario === 'all' || cli.scenario === s;

    // Bulk first when running 'all': it also produces the CONFIRMED AWB pool
    // the tracking scenario normalizes against.
    if (wants('bulk')) {
      results.push(
        await driveBulkBookings(ctx, fixtures, {
          jobs: cfg.bulkJobs,
          ordersPerJob: cfg.bulkOrdersPerJob,
        }),
      );
    }
    if (wants('tracking')) {
      results.push(...(await ensureBookedPool(ctx, fixtures, 50)));
      results.push(
        await driveTrackingEvents(ctx, fixtures.shops[0]!, {
          eventsPerSecond: cfg.trackingEps,
          durationSeconds: cfg.trackingSeconds,
          runId: fixtures.runId,
        }),
      );
    }
    if (wants('dashboard')) {
      results.push(
        await driveDashboardReaders(ctx, fixtures.shops[0]!, {
          concurrency: cfg.dashboardConcurrency,
          durationSeconds: cfg.dashboardSeconds,
        }),
      );
    }
    if (wants('outage')) {
      results.push(
        await driveOutageCatchup(ctx, fixtures.shops[0]!, {
          orders: cfg.outageOrders,
          outageSeconds: cfg.outageSeconds,
        }),
      );
    }
  } finally {
    if (cli.cleanup && fixtures) {
      const errors = await destroyFixtures(pool, fixtures.runId);
      if (errors.length > 0) {
        console.warn(`cleanup: ${errors.length} statement(s) failed (best-effort): ${errors[0]}`);
      }
    }
    redis.disconnect();
    await pool.end();
  }

  console.log('\n' + formatResultTable(results));
  const code = exitCodeForResults(results);
  if (code !== 0) {
    console.error('\nLOADTEST FAIL: a §5.1 budget was breached');
  } else {
    console.log('\nLOADTEST PASS: all §5.1 budgets met');
  }
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof LoadtestGuardError) {
      console.error(`GUARD: ${err.message}`);
    } else {
      console.error(`loadtest failed: ${(err as Error).message}`);
    }
    process.exit(2);
  });
