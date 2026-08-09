import { describe, expect, it, vi } from 'vitest';
import { PickupService } from '../../src/modules/booking-ops/pickup.service';
import { DocumentUrlSigner } from '../../src/modules/booking-ops/document-urls';
import {
  COURIER_ACCOUNT_1,
  COURIER_ACCOUNT_2,
  DOCUMENT_ID,
  FnPool,
  MEMBER_ID,
  ORDER_1,
  ORDER_2,
  ORDER_3,
  PICKUP_LOCATION_ID,
  SERVICE_1,
  SERVICE_2,
  SHIPMENT_1,
  SHIPMENT_2,
  SHIPMENT_3,
  SHOP_ID,
  mockAudit,
} from './helpers';

/**
 * §9.5.5 pickup scheduling + manifest (A4-02): service-only grouping, the
 * §3.3 PICKUP_SCHEDULED transition (and its reversal), §13.5 manifest
 * numbering, the document row (§5.4 90-day expiry, INV-19 is_test).
 */

const LOAD_SHIPMENTS = /FROM shipment\s+WHERE shop_id = \$1 AND shipment_id = ANY/;
const CUSTODY_SCHEDULE = /UPDATE shipment\s+SET custody_state = 'PICKUP_SCHEDULED'/;
const CUSTODY_REVERSE = /UPDATE shipment\s+SET custody_state = 'PICKUP_PENDING'/;
const TIMEZONE = /SELECT COALESCE\(ss\.timezone/;
const MANIFEST_COUNT = /SELECT count\(\*\)::int AS n FROM document/;
const ORDER_NUMBERS = /SELECT order_id, shopify_order_number FROM "order"/;
const INSERT_DOCUMENT = /INSERT INTO document\s/;
const INSERT_DOCUMENT_JOB = /INSERT INTO document_job/;

function snapshotFor(paymentMode: string, collectible: string) {
  return {
    formulaInputs: {
      billableWeightKg: '1.000',
      deadWeightKg: '0.540',
      paymentMode,
      collectible,
    },
  };
}

function pickupRow(overrides: Record<string, unknown> = {}) {
  return {
    shipment_id: SHIPMENT_1,
    order_id: ORDER_1,
    service_id: SERVICE_1,
    courier_account_id: COURIER_ACCOUNT_1,
    pickup_location_id: PICKUP_LOCATION_ID,
    awb_normalized: 'AWB001',
    awb_raw: 'AWB001',
    booking_state: 'CONFIRMED',
    custody_state: 'PICKUP_PENDING',
    is_test: false,
    snapshot: snapshotFor('COD', '1250.50'),
    ...overrides,
  };
}

function setup() {
  const pool = new FnPool();
  const audit = mockAudit();
  const scheduled: Array<{ accountId: string; awbs: string[] }> = [];
  const adapterCaller = {
    call: vi.fn(
      async (
        _shopId: string,
        accountId: string,
        _method: string,
        invoke: (a: unknown) => Promise<unknown>,
      ) => {
        const result = (await invoke({
          schedulePickup: async (req: { awbs: string[] }) => {
            scheduled.push({ accountId, awbs: req.awbs });
            return { acknowledged: true, providerPickupId: 'pickup-1' };
          },
        })) as unknown;
        return result;
      },
    ),
  };
  const signer = new DocumentUrlSigner({ get: () => 'test-secret' } as never);
  const store = {
    put: vi.fn(async (_key: string, _bytes: Buffer) => undefined),
    getSignedUrl: vi.fn(async (_key: string, _ttl: number) => ''),
  };
  const service = new PickupService(
    pool.asPool(),
    audit as never,
    adapterCaller as never,
    signer,
    store as never,
  );
  let manifestSeq = 0;
  pool.onFn(MANIFEST_COUNT, () => ({ rows: [{ n: manifestSeq++ }], rowCount: 1 }));
  return { pool, audit, adapterCaller, scheduled, signer, store, service };
}

describe('schedulePickups — grouping by courier SERVICE only (A4-02)', () => {
  it('one adapter call and ONE manifest per service group; custody → PICKUP_SCHEDULED', async () => {
    const { pool, audit, adapterCaller, scheduled, store, service } = setup();
    pool
      .on(LOAD_SHIPMENTS, [
        pickupRow(),
        pickupRow({ shipment_id: SHIPMENT_2, order_id: ORDER_2, awb_normalized: 'AWB002', awb_raw: 'AWB002' }),
        // Different courier account but the SAME service → same group, second call.
        pickupRow({
          shipment_id: SHIPMENT_3,
          order_id: ORDER_3,
          awb_normalized: 'AWB003',
          awb_raw: 'AWB003',
          service_id: SERVICE_2,
          courier_account_id: COURIER_ACCOUNT_2,
          snapshot: snapshotFor('PREPAID', '0.00'),
        }),
      ])
      .on(TIMEZONE, [{ timezone: 'Asia/Kolkata' }])
      .on(ORDER_NUMBERS, [
        { order_id: ORDER_1, shopify_order_number: '#1001' },
        { order_id: ORDER_2, shopify_order_number: '#1002' },
        { order_id: ORDER_3, shopify_order_number: '#1003' },
      ])
      .onFn(INSERT_DOCUMENT, () => ({ rows: [{ document_id: DOCUMENT_ID }], rowCount: 1 }));

    const result = await service.schedulePickups({
      shopId: SHOP_ID,
      shipmentIds: [SHIPMENT_1, SHIPMENT_2, SHIPMENT_3],
      actorId: MEMBER_ID,
    });

    expect(result.skipped).toHaveLength(0);
    expect(result.groups).toHaveLength(2); // grouped by SERVICE only
    const [g1, g2] = result.groups;
    expect(g1.serviceId).toBe(SERVICE_1);
    expect(g1.awbs).toEqual(['AWB001', 'AWB002']);
    expect(g2.serviceId).toBe(SERVICE_2);
    expect(g2.awbs).toEqual(['AWB003']);

    // §13.5: MF-{yyyymmdd}-{seq} per shop per day, incrementing.
    expect(g1.manifestNumber).toMatch(/^MF-\d{8}-0001$/);
    expect(g2.manifestNumber).toMatch(/^MF-\d{8}-0002$/);

    // One schedulePickup call per courier account within each service group.
    expect(adapterCaller.call).toHaveBeenCalledTimes(2);
    expect(scheduled[0]).toEqual({ accountId: COURIER_ACCOUNT_1, awbs: ['AWB001', 'AWB002'] });
    expect(scheduled[1]).toEqual({ accountId: COURIER_ACCOUNT_2, awbs: ['AWB003'] });

    // §3.3: PICKUP_PENDING → PICKUP_SCHEDULED, guarded by the from-state.
    const custody = pool.matching(CUSTODY_SCHEDULE);
    expect(custody).toHaveLength(2);
    expect(custody[0].sql).toContain("custody_state = 'PICKUP_PENDING'");
    expect(custody[0].params[0]).toBe(SHOP_ID); // INV-1
    expect(custody[0].params[1]).toEqual([SHIPMENT_1, SHIPMENT_2]);

    // ONE manifest PDF per service group, shop-scoped object key (INV-1).
    expect(store.put).toHaveBeenCalledTimes(2);
    const [key, bytes] = store.put.mock.calls[0] as [string, Buffer];
    expect(key).toMatch(new RegExp(`^shops/${SHOP_ID}/manifests/\\d{8}/MF-\\d{8}-0001\\.pdf$`));
    const text = bytes.toString('latin1');
    expect(text).toContain(`(Manifest ${g1.manifestNumber}) Tj`);
    expect(text).toContain('(AWB001 | #1001 | 1.000 | COD | 1250.50) Tj');

    // Signed download URL (S-26).
    expect(g1.downloadUrl).toContain(`/documents/${DOCUMENT_ID}/download?expires=`);
    expect(g1.downloadUrl).toContain('&signature=');

    expect(audit.entries.map((e) => e.action)).toEqual(['pickup.scheduled', 'pickup.scheduled']);
  });

  it('the document row carries sha256, bytes, 90-day expiry (§5.4) and inherited is_test; document_job SUCCEEDED', async () => {
    const { pool, service } = setup();
    pool
      .on(LOAD_SHIPMENTS, [
        pickupRow({ is_test: true }),
        pickupRow({ shipment_id: SHIPMENT_2, order_id: ORDER_2, is_test: true }),
      ])
      .on(TIMEZONE, [{ timezone: 'Asia/Kolkata' }])
      .on(ORDER_NUMBERS, [])
      .onFn(INSERT_DOCUMENT, () => ({ rows: [{ document_id: DOCUMENT_ID }], rowCount: 1 }));

    const before = Date.now();
    await service.schedulePickups({
      shopId: SHOP_ID,
      shipmentIds: [SHIPMENT_1, SHIPMENT_2],
      actorId: MEMBER_ID,
    });

    const insert = pool.matching(INSERT_DOCUMENT)[0];
    expect(insert.sql).toContain("'MANIFEST'");
    const [shopId, objectKey, sha256, bytes, expiresAt, isTest] = insert.params as [
      string, string, string, number, string, boolean,
    ];
    expect(shopId).toBe(SHOP_ID);
    expect(objectKey).toContain(`shops/${SHOP_ID}/manifests/`);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bytes).toBeGreaterThan(500);
    // §5.4: manifests live 90 days.
    const expiryMs = Date.parse(expiresAt) - before;
    expect(expiryMs).toBeGreaterThan(89 * 24 * 3600 * 1000);
    expect(expiryMs).toBeLessThanOrEqual(90 * 24 * 3600 * 1000 + 60_000);
    // INV-19: every shipment in the group is test → the manifest is test.
    expect(isTest).toBe(true);

    const job = pool.matching(INSERT_DOCUMENT_JOB)[0];
    expect(job.sql).toContain("'SUCCEEDED'");
    expect(JSON.parse(job.params[3] as string)).toEqual({ total: 2, scheduled: 2 });
    expect(job.params[4]).toBe(DOCUMENT_ID);
  });

  it('a mixed test/live group stays a live document', async () => {
    const { pool, service } = setup();
    pool
      .on(LOAD_SHIPMENTS, [
        pickupRow({ is_test: true }),
        pickupRow({ shipment_id: SHIPMENT_2, order_id: ORDER_2, is_test: false }),
      ])
      .on(TIMEZONE, [{ timezone: 'Asia/Kolkata' }])
      .on(ORDER_NUMBERS, [])
      .onFn(INSERT_DOCUMENT, () => ({ rows: [{ document_id: DOCUMENT_ID }], rowCount: 1 }));
    await service.schedulePickups({
      shopId: SHOP_ID,
      shipmentIds: [SHIPMENT_1, SHIPMENT_2],
      actorId: MEMBER_ID,
    });
    expect(pool.matching(INSERT_DOCUMENT)[0].params[5]).toBe(false);
  });

  it('reports ineligible shipments with their states — never silently (INV-20)', async () => {
    const { pool, service } = setup();
    pool
      .on(LOAD_SHIPMENTS, [
        pickupRow({ custody_state: 'IN_CUSTODY' }),
        pickupRow({ shipment_id: SHIPMENT_2, order_id: ORDER_2, booking_state: 'DRAFT', custody_state: 'NOT_APPLICABLE' }),
      ])
      .on(TIMEZONE, [{ timezone: 'Asia/Kolkata' }]);
    const result = await service.schedulePickups({
      shopId: SHOP_ID,
      shipmentIds: [SHIPMENT_1, SHIPMENT_2, SHIPMENT_3],
      actorId: MEMBER_ID,
    });
    expect(result.groups).toHaveLength(0);
    expect(result.skipped).toEqual([
      { shipmentId: SHIPMENT_1, reason: 'NOT_PICKUP_PENDING', bookingState: 'CONFIRMED', custodyState: 'IN_CUSTODY' },
      { shipmentId: SHIPMENT_2, reason: 'NOT_PICKUP_PENDING', bookingState: 'DRAFT', custodyState: 'NOT_APPLICABLE' },
      { shipmentId: SHIPMENT_3, reason: 'SHIPMENT_NOT_FOUND' },
    ]);
  });

  it('an adapter failure reports the group and leaves custody untouched', async () => {
    const env = setup();
    env.adapterCaller.call = vi.fn(async () => {
      throw new Error('provider timeout');
    });
    env.pool.on(LOAD_SHIPMENTS, [pickupRow()]);
    const result = await env.service.schedulePickups({
      shopId: SHOP_ID,
      shipmentIds: [SHIPMENT_1],
      actorId: MEMBER_ID,
    });
    expect(result.groups).toHaveLength(0);
    expect(result.skipped).toEqual([
      { shipmentId: SHIPMENT_1, reason: 'SCHEDULE_FAILED', detail: 'Error' },
    ]);
    expect(env.pool.matching(CUSTODY_SCHEDULE)).toHaveLength(0);
  });
});

describe('reversePickupScheduled — the §3.3 reverse, for the tracking module', () => {
  it('PICKUP_SCHEDULED → PICKUP_PENDING, guarded and audited (§12)', async () => {
    const { pool, audit, service } = setup();
    pool.on(CUSTODY_REVERSE, [], 2);
    const result = await service.reversePickupScheduled({
      shopId: SHOP_ID,
      shipmentIds: [SHIPMENT_1, SHIPMENT_2],
    });
    expect(result.reversed).toBe(2);
    const update = pool.matching(CUSTODY_REVERSE)[0];
    expect(update.sql).toContain("custody_state = 'PICKUP_SCHEDULED'");
    expect(update.params[0]).toBe(SHOP_ID);
    expect(audit.entries[0]).toMatchObject({
      action: 'pickup.schedule_reversed',
      actorKind: 'SYSTEM',
    });
  });
});
