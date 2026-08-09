import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { AutoShipService } from '../../src/modules/booking-ops/auto-ship.service';
import {
  AUTO_SHIP_SWEEP_INTERVAL_MS,
  AUTO_SHIP_SWEEP_JOB,
} from '../../src/modules/booking-ops/booking-ops.types';
import {
  FakeRedis,
  FnPool,
  INTENT_ID,
  ORDER_1,
  ORDER_2,
  SERVICE_1,
  SHIPMENT_1,
  SHIPMENT_2,
  SHOP_ID,
  mockAudit,
} from './helpers';

/**
 * §9.5.3 auto-ship (A3-03, S-10…S-13): each eligibility rule, the sweep
 * cap, RESTRICTED, no-rebook, and the never-on-webhook guarantee.
 */

const SETTINGS_QUERY = /LEFT JOIN store_settings/;
const CANDIDATES_QUERY = /FROM "order" o\s+JOIN shipment sh/;
const SWEEP_SHOPS_QUERY = /WHERE os\.auto_ship_enabled/;

// 2026-07-31 13:00 UTC = 18:30 Asia/Kolkata.
const NOW = new Date('2026-07-31T13:00:00.000Z');

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    auto_ship_hold_minutes: 30,
    auto_ship_cutoff_time: null as string | null,
    auto_ship_sweep_cap: 500,
    account_state: 'OPERATING',
    timezone: 'Asia/Kolkata',
    ...overrides,
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    order_id: ORDER_1,
    shipment_id: SHIPMENT_1,
    service_id: SERVICE_1,
    created_at_shopify: '2026-07-31T10:00:00.000Z', // 3h before NOW
    payment_mode: 'PREPAID',
    risk_flag: null as string | null,
    awb_normalized: null as string | null,
    ...overrides,
  };
}

function eligibleEnv(opts: {
  queueBooking?: ReturnType<typeof vi.fn>;
  route?: string | null;
  settings?: Record<string, unknown>[];
  candidates?: Record<string, unknown>[];
} = {}) {
  const pool = new FnPool();
  const redis = new FakeRedis();
  const audit = mockAudit();
  const booking = {
    queueBooking:
      opts.queueBooking ??
      vi.fn(async () => ({
        queued: true as const,
        bookingIntentId: INTENT_ID,
        merchantReference: 'ref-1',
        attemptNumber: 1,
        expectedCostBasis: null,
        collectible: '0.00',
      })),
  };
  const routeResolver = {
    resolveServiceId: vi.fn(async (): Promise<string | null> => opts.route ?? SERVICE_1),
  };
  const service = new AutoShipService(
    pool.asPool(),
    redis.asRedis(),
    audit as never,
    booking as never,
    routeResolver as never,
  );
  pool
    .on(SETTINGS_QUERY, opts.settings ?? [settingsRow()])
    .on(CANDIDATES_QUERY, opts.candidates ?? [candidate()]);
  return { pool, redis, audit, booking, routeResolver, service };
}

describe('auto-ship eligibility (§9.5.3)', () => {
  it('books an eligible order via queueBooking as the system actor', async () => {
    const { booking, audit, redis, service } = eligibleEnv();
    const summary = await service.runShopSweep(SHOP_ID, NOW);
    expect(summary.booked).toBe(1);
    expect(summary.outcomes[0]).toMatchObject({ orderId: ORDER_1, booked: true, bookingIntentId: INTENT_ID });
    expect(booking.queueBooking).toHaveBeenCalledWith({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_1,
      actorId: null, // §9.5.3 system actor — F-20 profile, no prompting
    });
    // The summary is the visible surface; one audit row per sweep (§12).
    expect(JSON.parse(redis.store.get(`booking-ops:auto-ship:last:${SHOP_ID}`)!).booked).toBe(1);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ action: 'auto_ship.sweep_completed' });
  });

  it('skips orders newer than the S-11 hold window', async () => {
    const env = eligibleEnv({
      candidates: [candidate({ created_at_shopify: '2026-07-31T12:45:00.000Z' })],
    });
    const summary = await env.service.runShopSweep(SHOP_ID, NOW); // 15 min old < 30
    expect(summary.outcomes[0]).toMatchObject({ booked: false, reason: 'WITHIN_HOLD_WINDOW' });
    expect(env.booking.queueBooking).not.toHaveBeenCalled();
  });

  it('respects the S-12 daily cutoff in shop-local time (§5.2)', async () => {
    const env = eligibleEnv({ settings: [settingsRow({ auto_ship_cutoff_time: '17:00:00' })] });
    const summary = await env.service.runShopSweep(SHOP_ID, NOW); // 18:30 IST > 17:00
    expect(summary.outcomes[0]).toMatchObject({ booked: false, reason: 'AFTER_CUTOFF' });
    expect(env.booking.queueBooking).not.toHaveBeenCalled();

    const env2 = eligibleEnv({ settings: [settingsRow({ auto_ship_cutoff_time: '23:59:00' })] });
    const before = await env2.service.runShopSweep(SHOP_ID, NOW);
    expect(before.booked).toBe(1);
  });

  it('skips orders with a Shopify risk flag (§8.1)', async () => {
    const env = eligibleEnv({ candidates: [candidate({ risk_flag: 'HIGH' })] });
    const summary = await env.service.runShopSweep(SHOP_ID, NOW);
    expect(summary.outcomes[0]).toMatchObject({ booked: false, reason: 'SHOPIFY_RISK_FLAG' });
    expect(env.booking.queueBooking).not.toHaveBeenCalled();
  });

  it('skips orders that are neither paid (prepaid) nor confirmed COD', async () => {
    const env = eligibleEnv({ candidates: [candidate({ payment_mode: 'UNRESOLVED' })] });
    const summary = await env.service.runShopSweep(SHOP_ID, NOW);
    expect(summary.outcomes[0]).toMatchObject({ booked: false, reason: 'PAYMENT_MODE_UNRESOLVED' });

    const env2 = eligibleEnv({ candidates: [candidate({ payment_mode: 'COD' })] });
    const cod = await env2.service.runShopSweep(SHOP_ID, NOW);
    expect(cod.booked).toBe(1);
  });

  it('never rebooks a shipment with an active AWB', async () => {
    const env = eligibleEnv({ candidates: [candidate({ awb_normalized: 'AWB123' })] });
    const summary = await env.service.runShopSweep(SHOP_ID, NOW);
    expect(summary.outcomes[0]).toMatchObject({ booked: false, reason: 'ACTIVE_AWB' });
    expect(env.booking.queueBooking).not.toHaveBeenCalled();
  });

  it('never runs while the account is RESTRICTED (§3.11)', async () => {
    const env = eligibleEnv({ settings: [settingsRow({ account_state: 'RESTRICTED' })] });
    const summary = await env.service.runShopSweep(SHOP_ID, NOW);
    expect(summary.booked).toBe(0);
    expect(summary.outcomes).toHaveLength(0);
    // It never even reads candidates.
    expect(env.pool.matching(CANDIDATES_QUERY)).toHaveLength(0);
    expect(env.booking.queueBooking).not.toHaveBeenCalled();
  });

  it('skips when no route resolves (S-22 unset — the rules-engine seam)', async () => {
    const env = eligibleEnv({ route: null });
    env.routeResolver.resolveServiceId = vi.fn(async () => null);
    const summary = await env.service.runShopSweep(SHOP_ID, NOW);
    expect(summary.outcomes[0]).toMatchObject({ booked: false, reason: 'NO_ROUTE' });
    expect(env.booking.queueBooking).not.toHaveBeenCalled();
  });

  it('books up to the S-13 per-sweep cap; above-cap waits for the next sweep', async () => {
    const env = eligibleEnv({
      settings: [settingsRow({ auto_ship_sweep_cap: 1 })],
      candidates: [candidate(), candidate({ order_id: ORDER_2, shipment_id: SHIPMENT_2 })],
    });
    const summary = await env.service.runShopSweep(SHOP_ID, NOW);
    expect(summary.booked).toBe(1);
    expect(summary.outcomes[1]).toMatchObject({
      orderId: ORDER_2,
      booked: false,
      reason: 'SWEEP_CAP_REACHED',
    });
    expect(env.booking.queueBooking).toHaveBeenCalledTimes(1);
  });

  it('keeps queueBooking failures visible with their exact reason (INV-20)', async () => {
    const queueBooking = vi.fn(async () => ({
      queued: false as const,
      code: 'NO_BOOKABLE_SERVICE' as const,
      manualAssignmentReason: 'NO_RULE_AND_NO_DEFAULT_CHAIN' as const,
    }));
    const { service } = eligibleEnv({ queueBooking });
    const summary = await service.runShopSweep(SHOP_ID, NOW);
    expect(summary.outcomes[0]).toMatchObject({
      booked: false,
      reason: 'BOOKING_BLOCKED',
      detail: 'NO_BOOKABLE_SERVICE:NO_RULE_AND_NO_DEFAULT_CHAIN',
    });
  });

  it('only candidates that are READY + DRAFT + no booking in progress are read (SQL guards)', async () => {
    const { pool, service } = eligibleEnv();
    await service.runShopSweep(SHOP_ID, NOW);
    const sql = pool.matching(CANDIDATES_QUERY)[0].sql;
    expect(sql).toContain("o.order_state = 'READY'"); // INV-7 passes (machine A)
    expect(sql).toContain("sh.booking_state = 'DRAFT'");
    expect(sql).toContain('sh.awb_normalized IS NULL');
    expect(sql).toContain("'QUEUED', 'SUBMITTED', 'OUTCOME_UNKNOWN'"); // no manual booking in progress
  });
});

describe('runSweep — the scheduled entry point (§9.5.3)', () => {
  it('sweeps only auto-ship-enabled, non-restricted shops, under a per-shop lock', async () => {
    const env = eligibleEnv();
    env.pool.on(SWEEP_SHOPS_QUERY, [{ shop_id: SHOP_ID }]);
    const summaries = await env.service.runSweep(NOW);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].booked).toBe(1);

    // The NX lock is still held → an overlapping sweep skips the shop.
    const again = await env.service.runSweep(NOW);
    expect(again).toHaveLength(0);
  });
});

describe('never on the order webhook (§9.5.3, A3-03)', () => {
  it('the sweep is a 5-minute repeatable BullMQ job, and runSweep has no webhook caller', () => {
    expect(AUTO_SHIP_SWEEP_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(AUTO_SHIP_SWEEP_JOB).toBe('auto-ship:sweep');

    // Structural guard: the only runSweep caller anywhere in src/ is the
    // BullMQ processor — no webhook handler may reference it.
    const srcRoot = join(__dirname, '..', '..', 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) files.push(path);
      }
    };
    walk(srcRoot);
    const callers = files.filter(
      (f) =>
        !f.endsWith('auto-ship.service.ts') &&
        readFileSync(f, 'utf8').includes('runSweep'),
    );
    expect(callers.map((f) => f.replace(/\\/g, '/'))).toEqual([
      expect.stringContaining('auto-ship-queue.ts'),
    ]);
  });
});
