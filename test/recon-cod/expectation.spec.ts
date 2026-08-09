import { describe, expect, it } from 'vitest';
import { CodExpectationService } from '../../src/modules/recon-cod/cod-expectation.service';
import { CodSettingsService } from '../../src/modules/recon-cod/cod-settings.service';
import { CodReconTrackingSeam } from '../../src/modules/recon-cod/cod-recon-tracking-seam';
import {
  FnPool,
  mockAudit,
  shipmentRow,
  expectedRow,
  SQL,
  SHOP_ID,
  SHIPMENT_ID,
  EXPECTED_ID,
} from './helpers';

/**
 * §9.17.3 expectation creation (INV-19 both directions, INV-8 snapshot
 * collectible, F-21 due date) and §4.7 RTO_UNCOLLECTED.
 */

function mk(pool: FnPool) {
  const audit = mockAudit();
  const settings = new CodSettingsService(pool.asPool(), audit as never);
  const service = new CodExpectationService(pool.asPool(), settings, audit as never);
  const seam = new CodReconTrackingSeam(service);
  return { service, seam, audit };
}

const DELIVERED_AT = '2026-08-01T10:00:00.000Z'; // 15:30 IST → local 2026-08-01

describe('createOnDelivered (§9.17.3)', () => {
  it('creates an AWAITING expectation for a collectible-bearing non-test shipment, SYSTEM-audited', async () => {
    const pool = new FnPool();
    pool.on(SQL.shipmentForExpectation, [shipmentRow()]);
    pool.on(SQL.effectiveDueDays, [{ due_days: 7 }]);
    pool.on(SQL.storeTimezone, [{ timezone: 'Asia/Kolkata' }]);
    pool.on(SQL.insertExpected, [{ expected_id: EXPECTED_ID }]);
    const { seam, audit } = mk(pool);

    await seam.onDelivered({ shopId: SHOP_ID, shipmentId: SHIPMENT_ID, occurredAt: DELIVERED_AT });

    const inserts = pool.matching(SQL.insertExpected);
    expect(inserts).toHaveLength(1);
    const p = inserts[0].params;
    expect(p[0]).toBe(SHOP_ID);
    expect(p[1]).toBe(SHIPMENT_ID);
    expect(p[2]).toBe('1000.00'); // expected_amount = the Collectible
    expect(p[3]).toBe(DELIVERED_AT); // delivered_at = the DELIVERED occurred-at
    expect(p[4]).toBe('2026-08-08'); // F-21: 2026-08-01 + 7 (S-30 default)
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      actorKind: 'SYSTEM',
      action: 'recon_cod.expected.create',
      objectType: 'recon_cod_expected',
      objectId: EXPECTED_ID,
    });
  });

  it('INV-19: a test shipment gets NO expectation (both directions)', async () => {
    const pool = new FnPool();
    pool.on(SQL.shipmentForExpectation, [shipmentRow({ is_test: true })]);
    const { seam, audit } = mk(pool);

    await seam.onDelivered({ shopId: SHOP_ID, shipmentId: SHIPMENT_ID, occurredAt: DELIVERED_AT });

    expect(pool.matching(SQL.insertExpected)).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it('collectible = 0 (prepaid docket, §4.7) gets NO expectation', async () => {
    const pool = new FnPool();
    pool.on(SQL.shipmentForExpectation, [
      shipmentRow({ collectible: '0.0000', snapshot: { formulaInputs: { collectible: '0.00' } } }),
    ]);
    const { seam, audit } = mk(pool);

    await seam.onDelivered({ shopId: SHOP_ID, shipmentId: SHIPMENT_ID, occurredAt: DELIVERED_AT });

    expect(pool.matching(SQL.insertExpected)).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it('INV-8: the Collectible comes from the frozen snapshot, not the live column', async () => {
    const pool = new FnPool();
    pool.on(SQL.shipmentForExpectation, [
      shipmentRow({ collectible: '450.0000', snapshot: { formulaInputs: { collectible: '500.00' } } }),
    ]);
    pool.on(SQL.effectiveDueDays, [{ due_days: 7 }]);
    pool.on(SQL.storeTimezone, [{ timezone: 'Asia/Kolkata' }]);
    pool.on(SQL.insertExpected, [{ expected_id: EXPECTED_ID }]);
    const { seam } = mk(pool);

    await seam.onDelivered({ shopId: SHOP_ID, shipmentId: SHIPMENT_ID, occurredAt: DELIVERED_AT });

    expect(pool.matching(SQL.insertExpected)[0].params[2]).toBe('500.00');
  });

  it('idempotent re-delivery: shipment_id UNIQUE conflict → no row, no audit', async () => {
    const pool = new FnPool();
    pool.on(SQL.shipmentForExpectation, [shipmentRow()]);
    pool.on(SQL.effectiveDueDays, [{ due_days: 7 }]);
    pool.on(SQL.storeTimezone, [{ timezone: 'Asia/Kolkata' }]);
    pool.on(SQL.insertExpected, [], 0); // ON CONFLICT DO NOTHING
    const { seam, audit } = mk(pool);

    const result = await seam.onDelivered({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_ID,
      occurredAt: DELIVERED_AT,
    });

    expect(result).toBeUndefined(); // seam returns void
    expect(audit.entries).toHaveLength(0);
  });

  it('F-21: courier-account override (10 days) beats the shop default (7)', async () => {
    const pool = new FnPool();
    pool.on(SQL.shipmentForExpectation, [shipmentRow()]);
    pool.on(SQL.effectiveDueDays, [{ due_days: 10 }]); // COALESCE(account, shop) resolved in SQL
    pool.on(SQL.storeTimezone, [{ timezone: 'Asia/Kolkata' }]);
    pool.on(SQL.insertExpected, [{ expected_id: EXPECTED_ID }]);
    const { seam } = mk(pool);

    await seam.onDelivered({ shopId: SHOP_ID, shipmentId: SHIPMENT_ID, occurredAt: DELIVERED_AT });

    expect(pool.matching(SQL.insertExpected)[0].params[4]).toBe('2026-08-11');
  });

  it('F-21 is shop-local: a 19:00Z delivery is already the next day in IST', async () => {
    const pool = new FnPool();
    pool.on(SQL.shipmentForExpectation, [shipmentRow()]);
    pool.on(SQL.effectiveDueDays, [{ due_days: 7 }]);
    pool.on(SQL.storeTimezone, [{ timezone: 'Asia/Kolkata' }]);
    pool.on(SQL.insertExpected, [{ expected_id: EXPECTED_ID }]);
    const { seam } = mk(pool);

    await seam.onDelivered({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_ID,
      occurredAt: '2026-08-01T19:00:00.000Z', // 2026-08-02 00:30 IST
    });

    expect(pool.matching(SQL.insertExpected)[0].params[4]).toBe('2026-08-09');
  });
});

describe('markRtoUncollected (§4.7)', () => {
  it('RTO movement flips an existing expectation to RTO_UNCOLLECTED, audited', async () => {
    const pool = new FnPool();
    pool.on(SQL.selectExpectedByShipment, [expectedRow({ state: 'AWAITING' })]);
    pool.on(SQL.updateExpectedRto, [{ expected_id: EXPECTED_ID }]);
    const { seam, audit } = mk(pool);

    await seam.onRtoInitiated({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_ID,
      movementState: 'RTO_INITIATED',
      occurredAt: '2026-08-03T00:00:00.000Z',
    });

    const updates = pool.matching(SQL.updateExpectedRto);
    expect(updates).toHaveLength(1);
    expect(updates[0].params[0]).toBe(EXPECTED_ID);
    expect(audit.entries[0]).toMatchObject({
      actorKind: 'SYSTEM',
      action: 'recon_cod.expected.rto_uncollected',
      before: { state: 'AWAITING' },
      after: { state: 'RTO_UNCOLLECTED' },
    });
    // §4.7: the write is RTO_UNCOLLECTED — the string SHORT never appears.
    expect(updates[0].sql).not.toContain('SHORT');
  });

  it('onTerminalMovement(RTO_DELIVERED) flips too', async () => {
    const pool = new FnPool();
    pool.on(SQL.selectExpectedByShipment, [expectedRow({ state: 'TALLIED' })]);
    pool.on(SQL.updateExpectedRto, [{ expected_id: EXPECTED_ID }]);
    const { seam } = mk(pool);

    await seam.onTerminalMovement({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_ID,
      movementState: 'RTO_DELIVERED',
      occurredAt: '2026-08-06T00:00:00.000Z',
    });

    expect(pool.matching(SQL.updateExpectedRto)).toHaveLength(1);
  });

  it('already RTO_UNCOLLECTED (terminal, §3.15) → no-op, no audit', async () => {
    const pool = new FnPool();
    pool.on(SQL.selectExpectedByShipment, [expectedRow({ state: 'RTO_UNCOLLECTED' })]);
    const { seam, audit } = mk(pool);

    await seam.onRtoInitiated({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_ID,
      movementState: 'RTO_IN_TRANSIT',
      occurredAt: '2026-08-03T00:00:00.000Z',
    });

    expect(pool.matching(SQL.updateExpectedRto)).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it('no expectation row (RTO before any DELIVERED) → nothing to flip (§9.17.3)', async () => {
    const pool = new FnPool();
    pool.on(SQL.selectExpectedByShipment, []);
    const { seam, audit } = mk(pool);

    await seam.onRtoInitiated({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_ID,
      movementState: 'RTO_OUT_FOR_DELIVERY',
      occurredAt: '2026-08-03T00:00:00.000Z',
    });

    expect(pool.matching(SQL.updateExpectedRto)).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it('non-RTO movement states are ignored', async () => {
    const pool = new FnPool();
    const { seam } = mk(pool);

    await seam.onRtoInitiated({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_ID,
      movementState: 'IN_TRANSIT',
      occurredAt: '2026-08-03T00:00:00.000Z',
    });

    expect(pool.calls).toHaveLength(0);
  });
});
