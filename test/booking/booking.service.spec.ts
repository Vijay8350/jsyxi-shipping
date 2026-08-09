import { describe, expect, it, vi } from 'vitest';
import { BookingService } from '../../src/modules/booking/booking.service';
import type { BookingSnapshot, QueueBookingResult } from '../../src/modules/booking/booking.types';
import {
  COURIER_ACCOUNT_ID,
  FnPool,
  INTENT_ID,
  MERCHANT_SERVICE_ID,
  RATE_CARD_VERSION_ID,
  SERVICE_ID,
  SERVICE_VERSION_ID,
  SHIPMENT_ID,
  SHOP_ID,
  ZONE_MAP_ID,
  mockAudit,
  orderRow,
  pickupRow,
  rateCardQuote,
  selectionRow,
  serviceVersionRow,
  shipmentRow,
  subscriptionRow,
  workingValues,
} from './helpers';

/**
 * queueBooking (§3.2 DRAFT → QUEUED): the guards, the freeze, the intent and
 * the enqueue. Every failure is a structured result (INV-20).
 */

interface StageOptions {
  shipment?: Record<string, unknown> | null;
  order?: Record<string, unknown>;
  accountState?: string;
  selection?: Record<string, unknown> | null;
  chainSelection?: Record<string, unknown>[];
  settings?: { default_chain: string[] | null };
  sub?: Record<string, unknown> | null;
  intentCount?: number;
  siblingCarrier?: boolean;
  profileOverride?: Record<string, unknown> | null;
}

function stagedPool(opts: StageOptions = {}) {
  const pool = new FnPool();
  const shipment = opts.shipment === undefined ? shipmentRow() : opts.shipment;
  pool.on(/FROM shipment[\s\S]*?FOR UPDATE/, shipment ? [shipment] : []);
  pool.on(/FROM "order"[\s\S]*?FOR UPDATE/, [opts.order ?? orderRow()]);
  pool.on(/SELECT account_state FROM shop/, [{ account_state: opts.accountState ?? 'ACTIVE' }]);
  const selection = opts.selection === undefined ? selectionRow() : opts.selection;
  pool.on(/FROM merchant_service ms[\s\S]*?ms\.service_id = \$2/, selection ? [selection] : []);
  pool.on(/FROM order_sync_settings/, [opts.settings ?? { default_chain: null }]);
  pool.on(/FROM merchant_service ms[\s\S]*?ANY\(\$2::uuid\[\]\)/, opts.chainSelection ?? []);
  pool.on(
    /FROM package_profile WHERE/,
    opts.profileOverride ? [opts.profileOverride] : [],
  );
  pool.on(/FROM service_version[\s\S]*?WHERE service_id/, [serviceVersionRow()]);
  pool.on(/FROM pickup_location WHERE/, [pickupRow()]);
  pool.on(
    /collectible > 0 AND awb_normalized IS NOT NULL/,
    opts.siblingCarrier ? [{ shipment_id: 'sibling' }] : [],
  );
  pool.on(/FROM subscription s/, opts.sub === null ? [] : [opts.sub ?? subscriptionRow()]);
  pool.on(/count\(\*\)::int AS n FROM booking_intent/, [{ n: opts.intentCount ?? 0 }]);
  pool.on(/INSERT INTO booking_intent/, [{ booking_intent_id: INTENT_ID }], 1);
  pool.on(/SET booking_state = 'QUEUED'/, [{}], 1);
  // resolveLaneZone (F-4) for the RATE_CARD path.
  pool.on(/FROM commercial_zone_map/, [{ postal_version_id: 'pv1' }]);
  pool.on(/FROM commercial_zone_rule/, [
    { origin_matcher: {}, destination_matcher: {}, zone: 'C', position: 1 },
  ]);
  pool.on(/FROM postal_pincode/, [
    {
      city: 'Ahmedabad',
      district: null,
      state: 'Gujarat',
      region: null,
      is_metro: false,
      is_special: false,
    },
  ]);
  return pool;
}

function makeService(
  pool: FnPool,
  mocks: {
    isBookable?: () => Promise<boolean>;
    estimateCost?: () => Promise<unknown>;
    getLiveQuote?: () => Promise<unknown>;
    allowanceBalance?: () => Promise<{ debits: number; reversals: number; consumed: number }>;
    ruleRoutingEvaluate?: () => Promise<unknown>;
  } = {},
) {
  const audit = mockAudit();
  const ledger = {
    allowanceBalance:
      mocks.allowanceBalance ?? (() => Promise.resolve({ debits: 0, reversals: 0, consumed: 0 })),
  };
  const queue = { enqueueBooking: vi.fn(() => Promise.resolve()) };
  // §9.4.4 routing runs at the head of queueBooking — inert by default here
  // (evaluated: false → the stored-selection / S-22 path proceeds).
  const ruleRouting = {
    evaluateForShipment:
      mocks.ruleRoutingEvaluate ??
      (() => Promise.resolve({ evaluated: false, code: 'INVALID_STATE' as const })),
  };
  const svc = new BookingService(
    pool.asPool(),
    audit as never,
    { isBookable: mocks.isBookable ?? (() => Promise.resolve(true)) } as never,
    {
      estimateCost:
        mocks.estimateCost ??
        (() =>
          Promise.resolve({
            quote: rateCardQuote(),
            rateCardVersionId: RATE_CARD_VERSION_ID,
            zoneMapId: ZONE_MAP_ID,
          })),
    } as never,
    { getLiveQuote: mocks.getLiveQuote ?? (() => Promise.resolve(rateCardQuote())) } as never,
    ledger as never,
    queue as never,
    ruleRouting as never,
  );
  return { svc, audit, queue, ledger, ruleRouting };
}

function queuedSnapshot(pool: FnPool) {
  const upd = pool.matching(/SET booking_state = 'QUEUED'/)[0];
  expect(upd).toBeDefined();
  return { upd, snapshot: JSON.parse(upd?.params[7] as string) as BookingSnapshot };
}

const baseInput = { shopId: SHOP_ID, shipmentId: SHIPMENT_ID, actorId: 'member-1' };

describe('queueBooking — happy path (§3.2, §2.9, §9.5.4)', () => {
  it('creates the intent, freezes the snapshot at DRAFT → QUEUED, audits and enqueues', async () => {
    const pool = stagedPool();
    const { svc, audit, queue } = makeService(pool);
    const result = (await svc.queueBooking(baseInput)) as Extract<
      QueueBookingResult,
      { queued: true }
    >;

    expect(result.queued).toBe(true);
    // §13.5 merchant reference: first 8 of the shop uuid + shipment id.
    expect(result.merchantReference).toBe(`11111111-${SHIPMENT_ID}`);
    expect(result.attemptNumber).toBe(1);
    expect(result.expectedCostBasis).toBe('SNAPSHOT_QUOTE');
    expect(result.collectible).toBe('1250.50'); // §4.7: first booking claims F-15

    // The intent row: shipment_created_at (partition child), digest, reference.
    const intentInsert = pool.matching(/INSERT INTO booking_intent/)[0];
    expect(intentInsert?.params[0]).toBe(SHIPMENT_ID);
    expect(intentInsert?.params[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(intentInsert?.params[2]).toBe(`11111111-${SHIPMENT_ID}`);
    // shipment_created_at is NOT bound as a parameter: it is selected straight
    // off the shipment row, because a JS Date round-trip drops microseconds and
    // breaks the composite FK to the partition child. Asserting the SQL shape
    // keeps a future refactor from quietly reintroducing the bind.
    expect(intentInsert?.sql).toMatch(/SELECT \$1, created_at, \$2, \$3 FROM shipment/);
    expect(intentInsert?.params).toHaveLength(3);

    // The QUEUED write carries the full §2.9 snapshot.
    const { upd, snapshot } = queuedSnapshot(pool);
    expect(upd?.params.slice(0, 7)).toEqual([
      SHOP_ID,
      SHIPMENT_ID,
      SERVICE_ID,
      SERVICE_VERSION_ID,
      COURIER_ACCOUNT_ID,
      '1250.50',
      'SNAPSHOT_QUOTE',
    ]);
    expect(snapshot.recipient).toMatchObject({ pincode: '560001' });
    expect(snapshot.lines).toHaveLength(1);
    expect(snapshot.pickupLocation).toMatchObject({ gstin: '24AAAAA0000A1Z5' });
    expect(snapshot.weights).toMatchObject({
      deadWeightKg: '0.540',
      volumetricWeightKg: '1.000',
      rawChargeableKg: '1.000',
      billableWeightKg: '1.000',
    });
    expect(snapshot.service).toMatchObject({
      serviceId: SERVICE_ID,
      serviceVersionId: SERVICE_VERSION_ID,
      volumetricDivisor: '5000',
    });
    expect(snapshot.courierAccount).toEqual({ courierAccountId: COURIER_ACCOUNT_ID, mode: 'LIVE' });
    expect(snapshot.rateCardVersionId).toBe(RATE_CARD_VERSION_ID);
    expect(snapshot.zoneMapId).toBe(ZONE_MAP_ID);
    expect(snapshot.zone).toBe('C');
    expect(snapshot.expectedQuote).toMatchObject({ total: '94.40', costSource: 'RATE_CARD' });
    expect(snapshot.shopify).toMatchObject({ orderGid: 'gid://shopify/Order/555000111' });
    expect(snapshot.rule).toBeNull();

    // INV-11: referenced versions sealed idempotently.
    expect(pool.matching(/UPDATE service_version SET is_sealed/)).toHaveLength(1);
    expect(pool.matching(/UPDATE rate_card_version v SET is_sealed/)).toHaveLength(1);
    expect(pool.matching(/UPDATE commercial_zone_map SET is_sealed/)).toHaveLength(1);

    // §12 audit + §5.7 enqueue partitioned per Service.
    expect(audit.entries.map((e) => e.action)).toContain('booking.queued');
    expect(queue.enqueueBooking).toHaveBeenCalledWith({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_ID,
      bookingIntentId: INTENT_ID,
      merchantReference: `11111111-${SHIPMENT_ID}`,
      serviceId: SERVICE_ID,
      courierAccountId: COURIER_ACCOUNT_ID,
    });
  });

  it('applies the §9.5.1 package override: re-tared F-24, MEMBER_OVERRIDE source', async () => {
    const pool = stagedPool({
      profileOverride: {
        package_profile_id: 'pp-2',
        name: 'Medium box',
        length_cm: '30.00',
        width_cm: '24.00',
        height_cm: '12.00',
        tare_kg: '0.100',
      },
    });
    const { svc } = makeService(pool);
    const result = await svc.queueBooking({ ...baseInput, packageProfileId: 'pp-2' });
    expect(result.queued).toBe(true);
    const { snapshot } = queuedSnapshot(pool);
    // 0.540 − 0.040 + 0.100 = 0.600 (§4.2: content weight unchanged).
    expect(snapshot.weights.deadWeightKg).toBe('0.600');
    expect(snapshot.packageProfile).toMatchObject({
      packageProfileId: 'pp-2',
      tareKg: '0.100',
      source: 'MEMBER_OVERRIDE',
    });
    // F-1 = 30×24×12 ÷ 5000 = 1.728 → F-3 = 2.000.
    expect(snapshot.weights.billableWeightKg).toBe('2.000');
  });

  it('books a LIVE_QUOTE service with null rate-card references (§2.9)', async () => {
    const pool = stagedPool({ selection: selectionRow({ cost_source: 'LIVE_QUOTE' }) });
    const { svc } = makeService(pool);
    const result = (await svc.queueBooking(baseInput)) as Extract<
      QueueBookingResult,
      { queued: true }
    >;
    expect(result.queued).toBe(true);
    const { snapshot } = queuedSnapshot(pool);
    expect(snapshot.rateCardVersionId).toBeNull();
    expect(snapshot.zoneMapId).toBeNull();
    expect(snapshot.zone).toBeNull();
    expect(snapshot.expectedQuote).toMatchObject({ costSource: 'LIVE_QUOTE' });
    const quoteInsert = pool.matching(/INSERT INTO quote/)[0];
    expect(quoteInsert?.params[4]).toBe('LIVE_QUOTE');
  });

  it('resolves the S-22 default chain when no service is selected (RW-22)', async () => {
    const pool = stagedPool({
      shipment: shipmentRow({ service_id: null }),
      settings: { default_chain: [MERCHANT_SERVICE_ID] },
      chainSelection: [selectionRow()],
    });
    const { svc } = makeService(pool);
    const result = await svc.queueBooking(baseInput);
    expect(result.queued).toBe(true);
  });

  it('INV-9: a booked sibling carrier ⇒ this shipment books with collectible 0 (§4.7)', async () => {
    const pool = stagedPool({ siblingCarrier: true });
    const { svc } = makeService(pool);
    const result = (await svc.queueBooking(baseInput)) as Extract<
      QueueBookingResult,
      { queued: true }
    >;
    expect(result.collectible).toBe('0.00');
    const { upd } = queuedSnapshot(pool);
    expect(upd?.params[5]).toBe('0.00');
  });
});

describe('queueBooking — guards block with structured reasons (INV-7, §3.11, §9.5.6)', () => {
  function expectNoWrites(pool: FnPool) {
    expect(pool.matching(/INSERT INTO booking_intent/)).toHaveLength(0);
    expect(pool.matching(/SET booking_state = 'QUEUED'/)).toHaveLength(0);
  }

  it('INV-7 recipient blocks', async () => {
    const pool = stagedPool({
      shipment: shipmentRow({ working_values: workingValues({ recipient: null }) }),
    });
    const { svc, queue } = makeService(pool);
    const result = await svc.queueBooking(baseInput);
    expect(result).toMatchObject({ queued: false, code: 'INV_7_BLOCKS' });
    const failures = (result as { failures: string[] }).failures;
    expect(failures).toEqual(
      expect.arrayContaining(['RECIPIENT_NAME', 'RECIPIENT_ADDRESS', 'RECIPIENT_PINCODE', 'RECIPIENT_PHONE']),
    );
    expectNoWrites(pool);
    expect(queue.enqueueBooking).not.toHaveBeenCalled();
  });

  it('INV-7 payment mode UNRESOLVED blocks', async () => {
    const pool = stagedPool({
      shipment: shipmentRow({
        working_values: workingValues({
          payment: { mode: 'UNRESOLVED', gatewayNames: [], collectible: '0.00' },
        }),
      }),
    });
    const { svc } = makeService(pool);
    const result = await svc.queueBooking(baseInput);
    expect(result).toMatchObject({ queued: false, code: 'INV_7_BLOCKS' });
    expect((result as { failures: string[] }).failures).toContain('PAYMENT_MODE');
  });

  it('INV-7 unbookable service blocks (wired isBookable check)', async () => {
    const pool = stagedPool();
    const { svc } = makeService(pool, { isBookable: () => Promise.resolve(false) });
    const result = await svc.queueBooking(baseInput);
    expect(result).toMatchObject({ queued: false, code: 'INV_7_BLOCKS' });
    expect((result as { failures: string[] }).failures).toContain('SERVICE_SERVICEABLE');
    expectNoWrites(pool);
  });

  it('INV-7 missing credentials for the account mode block (wired check)', async () => {
    const pool = stagedPool({
      selection: selectionRow({ account_mode: 'LIVE', has_live_credentials: false }),
    });
    const { svc } = makeService(pool);
    const result = await svc.queueBooking(baseInput);
    expect(result).toMatchObject({ queued: false, code: 'INV_7_BLOCKS' });
    expect((result as { failures: string[] }).failures).toContain('COURIER_CREDENTIALS');
  });

  it('an unserviceable lane blocks with the provider codes (§8.3)', async () => {
    const pool = stagedPool();
    const { svc } = makeService(pool, {
      estimateCost: () =>
        Promise.resolve({
          quote: rateCardQuote({ serviceable: false, failureReasons: ['ZONE_NOT_MATCHED'] }),
          rateCardVersionId: RATE_CARD_VERSION_ID,
          zoneMapId: ZONE_MAP_ID,
        }),
    });
    const result = await svc.queueBooking(baseInput);
    expect(result).toMatchObject({
      queued: false,
      code: 'INV_7_BLOCKS',
      serviceFailureReasons: ['ZONE_NOT_MATCHED'],
    });
  });

  it.each(['RESTRICTED', 'READ_ONLY', 'UNINSTALLED'])(
    '§3.11 account state %s blocks booking',
    async (accountState) => {
      const pool = stagedPool({ accountState });
      const { svc } = makeService(pool);
      const result = await svc.queueBooking(baseInput);
      expect(result).toMatchObject({ queued: false, code: 'ACCOUNT_STATE_BLOCKED' });
      expectNoWrites(pool);
    },
  );

  it('§9.5.6 insufficient entitlement blocks with approvalNeeded, no debit path', async () => {
    const pool = stagedPool();
    const { svc, queue } = makeService(pool, {
      allowanceBalance: () => Promise.resolve({ debits: 50, reversals: 0, consumed: 50 }),
    });
    const result = await svc.queueBooking(baseInput);
    expect(result).toMatchObject({
      queued: false,
      code: 'ENTITLEMENT_INSUFFICIENT',
      approvalNeeded: true,
      allowance: 50,
      consumed: 50,
    });
    expectNoWrites(pool);
    expect(queue.enqueueBooking).not.toHaveBeenCalled();
  });

  it('§9.5.6 overage permitted (capped amount) allows the booking', async () => {
    const pool = stagedPool({ sub: subscriptionRow({ capped_amount: '1000.00' }) });
    const { svc } = makeService(pool, {
      allowanceBalance: () => Promise.resolve({ debits: 55, reversals: 0, consumed: 55 }),
    });
    const result = await svc.queueBooking(baseInput);
    expect(result.queued).toBe(true);
  });

  it('invalid state blocks with the current state (§3.2)', async () => {
    const pool = stagedPool({ shipment: shipmentRow({ booking_state: 'CONFIRMED' }) });
    const { svc } = makeService(pool);
    const result = await svc.queueBooking(baseInput);
    expect(result).toMatchObject({
      queued: false,
      code: 'INVALID_STATE',
      currentState: 'CONFIRMED',
    });
  });

  it('INV-22: a version mismatch rejects with the current version', async () => {
    const pool = stagedPool();
    const { svc } = makeService(pool);
    const result = await svc.queueBooking({ ...baseInput, expectedVersion: 99 });
    expect(result).toMatchObject({
      queued: false,
      code: 'VERSION_CONFLICT',
      currentVersion: 3,
    });
    expectNoWrites(pool);
  });

  it('S-22 unset ⇒ NEEDS_MANUAL_ASSIGNMENT with NO_RULE_AND_NO_DEFAULT_CHAIN (RW-22)', async () => {
    const pool = stagedPool({
      shipment: shipmentRow({ service_id: null }),
      settings: { default_chain: null },
    });
    const { svc, audit } = makeService(pool);
    const result = await svc.queueBooking(baseInput);
    expect(result).toMatchObject({
      queued: false,
      code: 'NO_BOOKABLE_SERVICE',
      manualAssignmentReason: 'NO_RULE_AND_NO_DEFAULT_CHAIN',
    });
    const transition = pool.matching(/SET booking_state = 'NEEDS_MANUAL_ASSIGNMENT'/)[0];
    expect(transition).toBeDefined();
    expect(transition?.sql).toContain("'NO_RULE_AND_NO_DEFAULT_CHAIN'");
    expect(audit.entries.map((e) => e.action)).toContain('booking.needs_manual_assignment');
  });
});

describe('queueBooking — retry after FAILED (§9.5.4, §2.9)', () => {
  it('creates a NEW intent and a NEW snapshot; the freeze stays only at DRAFT → QUEUED', async () => {
    const pool = stagedPool({
      shipment: shipmentRow({ booking_state: 'FAILED' }),
      intentCount: 1,
    });
    const { svc } = makeService(pool);
    const result = (await svc.queueBooking(baseInput)) as Extract<
      QueueBookingResult,
      { queued: true }
    >;

    expect(result.attemptNumber).toBe(2);
    expect(result.merchantReference).toBe(`11111111-${SHIPMENT_ID}-2`);

    // FAILED → DRAFT first (no snapshot), then DRAFT → QUEUED (the freeze).
    const toDraft = pool.matching(/SET booking_state = 'DRAFT'/)[0];
    expect(toDraft).toBeDefined();
    expect(toDraft?.params).toEqual([SHOP_ID, SHIPMENT_ID, 'FAILED']);
    expect(toDraft?.sql).not.toContain('snapshot');
    const toQueued = pool.matching(/SET booking_state = 'QUEUED'/)[0];
    expect(toQueued?.sql).toContain('snapshot = $8');
    const parsed = JSON.parse(toQueued?.params[7] as string) as { frozenAt: string };
    expect(parsed.frozenAt).toBeTruthy();
  });
});
