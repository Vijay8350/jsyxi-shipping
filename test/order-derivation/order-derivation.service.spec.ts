import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { AuditService } from '../../src/audit/audit.service';
import { OrderDerivationService } from '../../src/modules/order-derivation/order-derivation.service';
import { MockTxPool, mockAudit, ORDER_ID, SHOP_ID } from '../order-sync/helpers';
import {
  draftShipmentRow,
  PICKUP_LOCATION_ID,
  PROFILE_SMALL_ID,
  profileRows,
  SHIPMENT_ID,
  validRecipient,
} from './helpers';

function makeService(pool: MockTxPool, audit = mockAudit()) {
  const svc = new OrderDerivationService(pool as unknown as Pool, audit as unknown as AuditService);
  return { svc, audit };
}

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    order_id: ORDER_ID,
    shop_id: SHOP_ID,
    order_state: 'IMPORTED',
    order_amount: '1250.50',
    recipient_snapshot: validRecipient(),
    cod_assignment_state: 'NOT_APPLICABLE',
    ...overrides,
  };
}

function lineRows() {
  return [
    { order_line_id: 'l1', sku: 'TEE-BLK-M', quantity: 2, weight_kg_override: '0.250' },
    { order_line_id: 'l2', sku: null, quantity: 1, weight_kg_override: null },
  ];
}

/** A pool staged for the full evaluateOrder read set. */
function stagedPool(order: Record<string, unknown>, shipments: Record<string, unknown>[]) {
  return new MockTxPool()
    .on(/FROM "order" WHERE order_id/, [order])
    .on(/FROM order_line/, lineRows())
    .on(/FROM package_profile WHERE/, profileRows())
    .on(/FROM package_selection_rule/, [])
    .on(/FROM store_settings/, [{ default_parcel_weight_kg: '0.500' }])
    .on(/FROM order_sync_settings/, [{ cod_gateway_map: ['Cash on Delivery (COD)'] }])
    .on(/FROM shipment WHERE/, shipments)
    .on(/FROM sku_override/, []);
}

describe('OrderDerivationService.evaluateOrder (§9.2.2, §9.2.4, §3.1)', () => {
  it('COD happy path: derives payment, F-15, F-24, F-20 and flips IMPORTED → READY', async () => {
    const pool = stagedPool(orderRow(), [draftShipmentRow()]);
    const { svc, audit } = makeService(pool);
    const outcome = await svc.evaluateOrder(ORDER_ID);

    expect(outcome.evaluated).toBe(true);
    expect(outcome.orderState).toBe('READY');
    expect(outcome.paymentMode).toBe('COD');
    expect(outcome.codOutstanding).toBe('1250.50'); // heuristic: COD gateway, nothing captured
    expect(outcome.codAssignmentState).toBe('NOT_APPLICABLE'); // pre-booking (INV-9)
    expect(outcome.eligibility?.failures).toEqual([]);

    // Order write: §3.5 mode, F-15, §3.24 state and the §3.1 transition —
    // guarded to the unbooked states (INV-17), version-incremented (INV-22).
    const orderUpdate = pool.matching(/UPDATE "order"/)[0];
    expect(orderUpdate?.params).toEqual([
      SHOP_ID,
      ORDER_ID,
      'COD',
      '1250.50',
      'NOT_APPLICABLE',
      'READY',
    ]);
    expect(orderUpdate?.sql).toContain("order_state IN ('IMPORTED', 'INCOMPLETE', 'READY')");
    expect(orderUpdate?.sql).toContain('version = version + 1');

    // Shipment working_values extended additively (§2.9 contract).
    const shipUpdate = pool.matching(/UPDATE shipment/)[0];
    expect(shipUpdate?.params[0]).toBe(SHOP_ID);
    expect(shipUpdate?.params[1]).toBe(SHIPMENT_ID);
    const wv = JSON.parse(shipUpdate?.params[2] as string);
    expect(wv.schemaVersion).toBe(1);
    expect(wv.recipient.name).toBe('Asha Verma'); // base block untouched
    expect(wv.fulfillment.mergePath).toBe('CONSOLIDATED'); // base block untouched
    expect(wv.payment.mode).toBe('COD');
    expect(wv.payment.collectible).toBe('1250.50');
    expect(wv.payment.gatewayNames).toEqual(['Cash on Delivery (COD)']); // preserved
    // F-24: 2 × 0.250 + 1 × 0.000 = 0.500; tare 0.040 once → 0.540.
    expect(wv.weight.deadWeightKg).toBe('0.540');
    expect(wv.weight.usedDefaultParcelWeight).toBe(false);
    expect(wv.weight.lines[1].noWeight).toBe(true); // INV-20 flag
    expect(wv.packageProfile.packageProfileId).toBe(PROFILE_SMALL_ID);
    expect(wv.packageProfile.source).toBe('DEFAULT');
    expect(wv.validation.ready).toBe(true);
    expect(wv.validation.failures).toEqual([]);

    // cod_assignment_state unchanged → no audit (§12 audits every CHANGE).
    expect(audit.entries).toEqual([]);
  });

  it('INCOMPLETE: missing recipient + unmapped gateway stay stored for the UI (§9.2.4)', async () => {
    const noGateways = draftShipmentRow({
      working_values: {
        ...draftShipmentRow().working_values,
        payment: { mode: 'UNRESOLVED', gatewayNames: [], collectible: '0.00' },
      },
    });
    const pool = stagedPool(orderRow({ recipient_snapshot: null }), [noGateways]);
    const { svc } = makeService(pool);
    const outcome = await svc.evaluateOrder(ORDER_ID);

    expect(outcome.orderState).toBe('INCOMPLETE');
    expect(outcome.paymentMode).toBe('UNRESOLVED'); // §3.5 unmapped gateway
    expect(outcome.codOutstanding).toBe('0.00'); // no COD gateway → nothing collectible
    expect(outcome.eligibility?.failures).toEqual([
      'RECIPIENT_NAME',
      'RECIPIENT_ADDRESS',
      'RECIPIENT_PINCODE',
      'RECIPIENT_PHONE',
      'PAYMENT_MODE',
    ]);
    expect(pool.matching(/UPDATE "order"/)[0]?.params[5]).toBe('INCOMPLETE');
    const wv = JSON.parse(pool.matching(/UPDATE shipment/)[0]?.params[2] as string);
    expect(wv.validation.ready).toBe(false);
    expect(wv.validation.failures).toContain('PAYMENT_MODE');
  });

  it('does nothing for a booked or terminal order (§9.2.5, INV-17)', async () => {
    const pool = stagedPool(orderRow({ order_state: 'FULLY_BOOKED' }), [draftShipmentRow()]);
    const { svc } = makeService(pool);
    const outcome = await svc.evaluateOrder(ORDER_ID);
    expect(outcome.evaluated).toBe(false);
    expect(pool.matching(/UPDATE "order"/)).toHaveLength(0);
  });

  it('evaluateAfterUpsert: skips booked orders, evaluates unbooked ones (§9.2.1 seam)', async () => {
    const skipped = new MockTxPool();
    const { svc: svcSkipped } = makeService(skipped);
    await svcSkipped.evaluateAfterUpsert({
      orderId: ORDER_ID,
      orderState: 'FULLY_BOOKED',
      inserted: false,
      linesRewritten: false,
      unbooked: false,
    });
    expect(skipped.calls).toHaveLength(0);

    const pool = stagedPool(orderRow(), [draftShipmentRow()]);
    const { svc } = makeService(pool);
    await svc.evaluateAfterUpsert({
      orderId: ORDER_ID,
      orderState: 'IMPORTED',
      inserted: true,
      linesRewritten: true,
      unbooked: true,
    });
    expect(pool.matching(/UPDATE "order"/)).toHaveLength(1);
  });
});

describe('OrderDerivationService.recomputeCodAssignment (§3.24, INV-9)', () => {
  it('ASSIGNED: one booked shipment carries the full Collectible — persisted + audited', async () => {
    const pool = new MockTxPool()
      .on(/FROM "order" WHERE shop_id/, [
        { cod_outstanding: '2000.00', cod_assignment_state: 'NOT_APPLICABLE' },
      ])
      .on(/FROM shipment WHERE/, [
        draftShipmentRow({ booking_state: 'CONFIRMED', awb_normalized: 'AWBA', collectible: '2000.00' }),
      ]);
    const { svc, audit } = makeService(pool);
    const result = await svc.recomputeCodAssignment(SHOP_ID, ORDER_ID);

    expect(result).toEqual({ state: 'ASSIGNED', changed: true });
    expect(pool.matching(/UPDATE "order"/)[0]?.params).toEqual([SHOP_ID, ORDER_ID, 'ASSIGNED']);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      action: 'COD_ASSIGNMENT_STATE_CHANGED',
      before: { cod_assignment_state: 'NOT_APPLICABLE' },
      after: { cod_assignment_state: 'ASSIGNED' },
    });
  });

  it('UNASSIGNED: F-15 > 0, booked shipment carries nothing (§4.7 cancellation example)', async () => {
    const pool = new MockTxPool()
      .on(/FROM "order" WHERE shop_id/, [
        { cod_outstanding: '2000.00', cod_assignment_state: 'ASSIGNED' },
      ])
      .on(/FROM shipment WHERE/, [
        draftShipmentRow({ booking_state: 'VOID', awb_normalized: 'AWBA', collectible: '2000.00' }),
        draftShipmentRow({ booking_state: 'CONFIRMED', awb_normalized: 'AWBB', collectible: '0.00' }),
      ]);
    const { svc, audit } = makeService(pool);
    const result = await svc.recomputeCodAssignment(SHOP_ID, ORDER_ID);
    expect(result).toEqual({ state: 'UNASSIGNED', changed: true });
    expect(audit.entries).toHaveLength(1);
  });

  it('no change → no write, no audit', async () => {
    const pool = new MockTxPool()
      .on(/FROM "order" WHERE shop_id/, [
        { cod_outstanding: '0.00', cod_assignment_state: 'NOT_APPLICABLE' },
      ])
      .on(/FROM shipment WHERE/, []);
    const { svc, audit } = makeService(pool);
    const result = await svc.recomputeCodAssignment(SHOP_ID, ORDER_ID);
    expect(result).toEqual({ state: 'NOT_APPLICABLE', changed: false });
    expect(pool.matching(/UPDATE "order"/)).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });
});

describe('pickup location (INV-7, INV-3)', () => {
  it('no pickup location on the shipment → INCOMPLETE with PICKUP_LOCATION', async () => {
    const pool = stagedPool(orderRow(), [draftShipmentRow({ pickup_location_id: null })]);
    const { svc } = makeService(pool);
    const outcome = await svc.evaluateOrder(ORDER_ID);
    expect(outcome.orderState).toBe('INCOMPLETE');
    expect(outcome.eligibility?.failures).toEqual(['PICKUP_LOCATION']);
    expect(PICKUP_LOCATION_ID).toBeTruthy();
  });
});
