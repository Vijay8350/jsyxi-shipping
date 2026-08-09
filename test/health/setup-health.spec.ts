import { describe, expect, it, vi } from 'vitest';
import {
  GSTIN_RE,
  SetupHealthService,
  evaluateSetupHealth,
} from '../../src/modules/health/setup-health.service';
import {
  SETUP_HEALTH_CATALOG,
  catalogEntry,
} from '../../src/modules/health/setup-health.catalog';
import { SetupHealthScheduler } from '../../src/modules/health/setup-health.scheduler';
import { SetupHealthController } from '../../src/modules/health/setup-health.controller';
import { SHOP_ID } from '../order-sync/helpers';
import {
  FakeHealthPool,
  asPool,
  healthyInput,
  healthyLoadResponder,
  statesOf,
} from './helpers';

/** ADD-29: each checklist item flips OK / MISSING / BROKEN correctly. */

describe('evaluateSetupHealth (ADD-29 checklist)', () => {
  it('all ten items OK on a fully-configured shop', () => {
    const items = evaluateSetupHealth(healthyInput());
    expect(items.map((i) => i.itemKey)).toEqual(
      SETUP_HEALTH_CATALOG.map((c) => c.itemKey),
    );
    expect(items.every((i) => i.state === 'OK')).toBe(true);
  });

  it('pickup_address: MISSING without an active row, BROKEN when incomplete', () => {
    expect(
      statesOf(evaluateSetupHealth(healthyInput({ pickupLocation: null })))
        .pickup_address,
    ).toBe('MISSING');

    const incomplete = healthyInput();
    incomplete.pickupLocation = {
      ...incomplete.pickupLocation!,
      phone: null,
      address_lines: [],
    };
    const item = evaluateSetupHealth(incomplete).find(
      (i) => i.itemKey === 'pickup_address',
    )!;
    expect(item.state).toBe('BROKEN');
    expect(item.detail).toContain('address');
    expect(item.detail).toContain('phone');
  });

  it('gstin: MISSING when unset, BROKEN on a bad format, OK on 15-char GSTIN', () => {
    const noGstin = healthyInput();
    noGstin.pickupLocation = { ...noGstin.pickupLocation!, gstin: null };
    expect(statesOf(evaluateSetupHealth(noGstin)).gstin).toBe('MISSING');

    const badGstin = healthyInput();
    badGstin.pickupLocation = { ...badGstin.pickupLocation!, gstin: 'ABC123' };
    expect(statesOf(evaluateSetupHealth(badGstin)).gstin).toBe('BROKEN');

    expect(GSTIN_RE.test('29ABCDE1234F1Z5')).toBe(true);
    expect(GSTIN_RE.test('29ABCDE1234F1Z')).toBe(false); // 14 chars
    expect(GSTIN_RE.test('29abcde1234F1Z5')).toBe(false); // lowercase PAN
  });

  it('courier_account: MISSING when none connected, BROKEN when none HEALTHY', () => {
    expect(
      statesOf(evaluateSetupHealth(healthyInput({ courierAccounts: [] })))
        .courier_account,
    ).toBe('MISSING');

    const degraded = healthyInput({
      courierAccounts: [
        {
          health_state: 'DEGRADED',
          has_webhook_secret: true,
          last_event_received_at: '2026-08-06T10:00:00Z',
        },
        {
          health_state: 'DISCONNECTED',
          has_webhook_secret: false,
          last_event_received_at: null,
        },
      ],
    });
    const item = evaluateSetupHealth(degraded).find(
      (i) => i.itemKey === 'courier_account',
    )!;
    expect(item.state).toBe('BROKEN');
    expect(item.detail).toContain('2 account(s)');
  });

  it('enabled_service: MISSING when no merchant_service is enabled', () => {
    expect(
      statesOf(evaluateSetupHealth(healthyInput({ enabledServices: [] })))
        .enabled_service,
    ).toBe('MISSING');
  });

  it('rate_cards: MISSING for an enabled RATE_CARD service without a card; LIVE_QUOTE needs none', () => {
    expect(
      statesOf(evaluateSetupHealth(healthyInput({ rateCards: [] })))
        .rate_cards,
    ).toBe('MISSING');

    const liveQuote = healthyInput({
      enabledServices: [
        { service_id: 'svc-2', courier_account_id: 'ca-1', cost_source: 'LIVE_QUOTE' },
      ],
      rateCards: [],
    });
    expect(statesOf(evaluateSetupHealth(liveQuote)).rate_cards).toBe('OK');
  });

  it('default_chain: MISSING when S-22 unset or empty', () => {
    expect(
      statesOf(evaluateSetupHealth(healthyInput({ defaultChain: null })))
        .default_chain,
    ).toBe('MISSING');
    expect(
      statesOf(evaluateSetupHealth(healthyInput({ defaultChain: [] })))
        .default_chain,
    ).toBe('MISSING');
  });

  it('webhook: MISSING without a secret, BROKEN when no recent events', () => {
    const noSecret = healthyInput({
      courierAccounts: [
        {
          health_state: 'HEALTHY',
          has_webhook_secret: false,
          last_event_received_at: null,
        },
      ],
    });
    expect(statesOf(evaluateSetupHealth(noSecret)).webhook).toBe('MISSING');

    const stale = healthyInput({
      courierAccounts: [
        {
          health_state: 'HEALTHY',
          has_webhook_secret: true,
          last_event_received_at: '2026-07-01T00:00:00Z', // > 7 days before NOW
        },
      ],
    });
    expect(statesOf(evaluateSetupHealth(stale)).webhook).toBe('BROKEN');

    const neverReceived = healthyInput({
      courierAccounts: [
        {
          health_state: 'HEALTHY',
          has_webhook_secret: true,
          last_event_received_at: null,
        },
      ],
    });
    expect(statesOf(evaluateSetupHealth(neverReceived)).webhook).toBe(
      'BROKEN',
    );
  });

  it('label_template: MISSING when no row exists', () => {
    expect(
      statesOf(evaluateSetupHealth(healthyInput({ hasLabelTemplate: false })))
        .label_template,
    ).toBe('MISSING');
  });

  it('package_profile: BROKEN when the INV-24 default is absent', () => {
    expect(
      statesOf(
        evaluateSetupHealth(healthyInput({ hasDefaultPackageProfile: false })),
      ).package_profile,
    ).toBe('BROKEN');
  });

  it('plan: MISSING with no subscription, BROKEN unless TRIALING/ACTIVE', () => {
    expect(
      statesOf(evaluateSetupHealth(healthyInput({ subscriptionState: null })))
        .plan,
    ).toBe('MISSING');
    expect(
      statesOf(
        evaluateSetupHealth(healthyInput({ subscriptionState: 'RESTRICTED' })),
      ).plan,
    ).toBe('BROKEN');
    expect(
      statesOf(
        evaluateSetupHealth(healthyInput({ subscriptionState: 'TRIALING' })),
      ).plan,
    ).toBe('OK');
  });
});

describe('SetupHealthService.compute (persistence)', () => {
  it('upserts every item shop-scoped; ON CONFLICT keeps first_detected_at, bumps updated_at', async () => {
    const pool = new FakeHealthPool(healthyLoadResponder);
    const svc = new SetupHealthService(asPool(pool));
    await svc.compute(SHOP_ID);

    const inserts = pool.matching(/INSERT INTO setup_health_item/);
    expect(inserts).toHaveLength(SETUP_HEALTH_CATALOG.length);
    for (const call of inserts) {
      expect(call.params[0]).toBe(SHOP_ID); // INV-1
      // The conflict clause updates state/detail/updated_at — never
      // first_detected_at.
      expect(call.sql).toContain('ON CONFLICT (shop_id, item_key) DO UPDATE');
      expect(call.sql).toContain('updated_at = now()');
      expect(call.sql).not.toContain('first_detected_at = EXCLUDED');
    }
    // Stale catalog keys are swept, shop-scoped.
    const del = pool.matching(/DELETE FROM setup_health_item/)[0];
    expect(del?.params[0]).toBe(SHOP_ID);
  });

  it('first_detected_at is preserved across recomputes while state and updated_at move', async () => {
    let input = healthyLoadResponder;
    const pool = new FakeHealthPool((sql) => input(sql));
    const svc = new SetupHealthService(asPool(pool));

    await svc.compute(SHOP_ID); // healthy — pickup_address OK
    const firstRun = pool.stored.get(`${SHOP_ID}:pickup_address`)!;
    expect(firstRun.state).toBe('OK');

    // Break the pickup address and recompute: state flips, first_detected_at
    // stays, updated_at advances.
    input = (sql) =>
      /FROM pickup_location/.test(sql)
        ? [
            {
              name: 'Main Warehouse',
              address_lines: [],
              city: 'Bengaluru',
              state: 'Karnataka',
              pincode: '560001',
              phone: null,
              gstin: '29ABCDE1234F1Z5',
            },
          ]
        : healthyLoadResponder(sql);
    await svc.compute(SHOP_ID);
    const secondRun = pool.stored.get(`${SHOP_ID}:pickup_address`)!;
    expect(secondRun.state).toBe('BROKEN');
    expect(secondRun.first).toBe(firstRun.first);
    expect(secondRun.updated > firstRun.updated).toBe(true);
  });
});

describe('SetupHealthService.getChecklist (ADD-30)', () => {
  it('returns catalog labels + deep links per item; completed only when all OK', async () => {
    const pool = new FakeHealthPool(healthyLoadResponder);
    const svc = new SetupHealthService(asPool(pool));

    const checklist = await svc.getChecklist(SHOP_ID); // computes on demand
    expect(checklist.completed).toBe(true);
    expect(checklist.items).toHaveLength(SETUP_HEALTH_CATALOG.length);
    for (const item of checklist.items) {
      const cat = catalogEntry(item.itemKey);
      expect(item.label).toBe(cat.label);
      expect(item.fixPath).toBe(cat.fixPath);
      expect(item.fixPath).toMatch(/^\//);
      expect(item.firstDetectedAt).not.toBeNull();
    }

    // Break one item → completed flips false and the item carries its link.
    const brokenPool = new FakeHealthPool((sql) =>
      /FROM subscription/.test(sql) ? [] : healthyLoadResponder(sql),
    );
    const brokenSvc = new SetupHealthService(asPool(brokenPool));
    const broken = await brokenSvc.getChecklist(SHOP_ID);
    expect(broken.completed).toBe(false);
    const plan = broken.items.find((i) => i.itemKey === 'plan')!;
    expect(plan.state).toBe('MISSING');
    expect(plan.fixPath).toBe('/settings/billing');
  });
});

describe('SetupHealthScheduler (hourly sweep)', () => {
  function makeScheduler() {
    // Same pattern as test/order-sync/sweep.spec.ts: skip the constructor
    // (which would build a real BullMQ Queue) and inject a mock queue.
    const queue = {
      upsertJobScheduler: vi.fn(async () => ({})),
      removeJobScheduler: vi.fn(async () => true),
      add: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    };
    const scheduler = Object.create(
      SetupHealthScheduler.prototype,
    ) as SetupHealthScheduler;
    Object.defineProperty(scheduler, 'queue', { value: queue });
    Object.defineProperty(scheduler, 'logger', {
      value: { log: vi.fn(), error: vi.fn() },
    });
    return { scheduler, queue };
  }

  it('schedules an hourly per-shop job; UNINSTALLED shops are removed (§5.5)', async () => {
    const { scheduler, queue } = makeScheduler();
    const result = await scheduler.syncSchedules([
      { shop_id: 'shop-a', account_state: 'ACTIVE' },
      { shop_id: 'shop-b', account_state: 'TRIALING' },
      { shop_id: 'shop-c', account_state: 'UNINSTALLED' },
    ]);
    expect(result).toEqual({ scheduled: 2, removed: 1 });
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'shop-recompute:shop-a',
      { every: 3_600_000 },
      { name: 'shop-recompute', data: { shopId: 'shop-a' } },
    );
    expect(queue.removeJobScheduler).toHaveBeenCalledWith(
      'shop-recompute:shop-c',
    );
  });

  it('enqueueRecompute adds an immediate one-off job (recompute on demand)', async () => {
    const { scheduler, queue } = makeScheduler();
    await scheduler.enqueueRecompute('shop-a');
    expect(queue.add).toHaveBeenCalledWith('shop-recompute', {
      shopId: 'shop-a',
    });
  });
});

describe('SetupHealthController (ADD-30 surface)', () => {
  it('GET /setup/health returns the checklist for the session shop (INV-1)', async () => {
    const checklist = { completed: true, items: [] };
    const health = {
      getChecklist: vi.fn(async () => checklist),
      compute: vi.fn(async () => []),
    };
    const controller = new SetupHealthController(health as never);
    const req = {
      session: { shopId: SHOP_ID, memberId: 'm1', role: 'VIEWER' },
    } as never;

    expect(await controller.getHealth(req)).toBe(checklist);
    expect(health.getChecklist).toHaveBeenCalledWith(SHOP_ID);

    await controller.recompute(req);
    expect(health.compute).toHaveBeenCalledWith(SHOP_ID);
    expect(health.getChecklist).toHaveBeenCalledTimes(2);
  });
});
