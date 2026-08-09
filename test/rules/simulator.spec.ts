import { describe, expect, it, vi } from 'vitest';
import { RuleSimulatorService } from '../../src/modules/rules/rule-simulator.service';
import { RuleEvaluationService } from '../../src/modules/rules/rule-evaluation.service';
import { QuoteCacheService } from '../../src/modules/booking/quote-cache.service';
import {
  FnPool,
  orderRow,
  rateCardQuote,
  serviceVersionRow,
  shipmentRow,
} from '../booking/helpers';
import { ACCT_1, RULE_ID, SHIPMENT_ID, SHOP_ID, SVC_A, SVC_B } from './helpers';

const MS_ID = '77777777-7777-7777-7777-777777777777';
const ZONE_MAP_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SHIPMENT_B = '33333333-3333-3333-3333-333333333334';
const NOW = new Date('2026-08-02T19:00:00.000Z');

/**
 * §9.4.6 simulator + ADD-17 test-fire. Both must be READ-ONLY: no trace
 * rows, no shipment writes, no booking — the same evaluate core, nothing
 * persisted.
 */

function staged(shipmentsForTestFire: Record<string, unknown>[] = []) {
  const pool = new FnPool();
  pool.on(/is_test = false/, shipmentsForTestFire);
  pool.onFn(/FROM shipment/, (_sql, params) => {
    const id = params[1] as string;
    const row = shipmentsForTestFire.find((s) => s.shipment_id === id);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });
  pool.on(/postal_pincode pp/, [{ state: 'Delhi', city: 'New Delhi' }]);
  pool.on(/FROM postal_pincode WHERE postal_version_id/, [
    { city: 'X', district: 'Y', state: 'Karnataka', region: 'S', is_metro: false, is_special: false },
  ]);
  pool.on(/SELECT merchant_service_id, service_id FROM merchant_service/, [
    { merchant_service_id: MS_ID, service_id: SVC_A },
  ]);
  pool.on(/FROM "order"/, [orderRow()]);
  pool.on(/FROM store_settings/, [{ timezone: 'Asia/Kolkata' }]);
  pool.on(/FROM rule WHERE/, [
    {
      rule_id: RULE_ID,
      shop_id: SHOP_ID,
      name: 'Catch-all',
      pickup_location_id: null,
      is_active: true,
      position: 1,
      action_type: 'PRIORITY_CHAIN',
      excluded_service_ids: [],
      active_from: null,
      active_to: null,
      version: 1,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    },
  ]);
  pool.on(/FROM rule_condition_group/, [{ group_id: 'g1', rule_id: RULE_ID, position: 1 }]);
  pool.on(/FROM rule_condition WHERE/, [
    {
      condition_id: 'c1',
      rule_id: RULE_ID,
      group_id: 'g1',
      field: 'WEIGHT',
      operator: 'GTE',
      value_json: { value: '0' },
    },
  ]);
  pool.on(/FROM rule_action_service/, [
    { action_service_id: 'as1', rule_id: RULE_ID, service_id: SVC_A, position: 1 },
  ]);
  pool.on(/FROM order_sync_settings/, [{ default_chain: null }]);
  pool.on(/FROM pickup_location/, [{ pincode: '380015' }]);
  pool.on(/priority_tiebreak_order/, [
    {
      merchant_service_id: MS_ID,
      courier_account_id: ACCT_1,
      service_id: SVC_A,
      enabled: true,
      priority_tiebreak_order: 0,
      cost_source: 'RATE_CARD',
      service_active: true,
      account_disabled_at: null,
    },
  ]);
  pool.on(/FROM service_version/, [{ service_id: SVC_A, ...serviceVersionRow() }]);
  pool.on(/FROM commercial_zone_map/, [{ postal_version_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd' }]);
  pool.on(/FROM commercial_zone_rule/, [
    { origin_matcher: {}, destination_matcher: {}, zone: 'C', position: 1 },
  ]);

  const merchantServices = { isBookable: vi.fn().mockResolvedValue(true) };
  const estimates = {
    estimateCost: vi.fn().mockResolvedValue({
      quote: rateCardQuote(),
      rateCardVersionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      zoneMapId: ZONE_MAP_ID,
    }),
  };
  const quoteCache = new QuoteCacheService(pool.asPool(), { call: vi.fn() } as never);
  const evaluation = new RuleEvaluationService(
    pool.asPool(),
    merchantServices as never,
    estimates as never,
    quoteCache,
  );
  const simulator = new RuleSimulatorService(pool.asPool(), evaluation);
  return { pool, simulator };
}

function expectReadOnly(pool: FnPool) {
  const writes = pool.calls.filter((c) =>
    /INSERT INTO|UPDATE \w|DELETE FROM|BEGIN|COMMIT/.test(c.sql),
  );
  expect(writes).toEqual([]);
}

describe('§9.4.6 simulate', () => {
  it('returns the full trace for a sample order and persists NOTHING', async () => {
    const { pool, simulator } = staged();
    const result = await simulator.simulate(SHOP_ID, {
      destinationPincode: '560001',
      deadWeightKg: '0.540',
      lengthCm: '25.00',
      widthCm: '20.00',
      heightCm: '10.00',
      paymentMode: 'COD',
      collectible: '1250.50',
      orderAmount: '1250.50',
      codAmount: '1250.50',
      skus: ['TEE-BLK-M'],
      tags: ['summer'],
      checkoutShippingTitle: 'Express',
      checkoutShippingAmount: '50.00',
      itemCount: 2,
      riskFlag: null,
    });
    expect(result.matchedRuleId).toBe(RULE_ID);
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_A });
    expect(result.candidateResults[0].cost).toBe('94.40'); // §9.4.6: cost per candidate
    // ADD-01/02 resolved from the postal master by the sample pincode.
    expect(result.ruleTraces[0].status).toBe('MATCHED');
    expectReadOnly(pool);
  });
});

describe('ADD-17 test-fire', () => {
  it('compares would-match-now vs the service actually used, read-only', async () => {
    const shipments = [
      shipmentRow({ service_id: SVC_A }), // routed the same → unchanged
      shipmentRow({ shipment_id: SHIPMENT_B, service_id: SVC_B }), // would change
    ];
    const { pool, simulator } = staged(shipments);
    const rows = await simulator.testFire(SHOP_ID, 100);
    expect(rows).toHaveLength(2);

    const listQuery = pool.matching(/is_test = false/);
    expect(listQuery).toHaveLength(1);
    expect(listQuery[0].params[1]).toBe(100); // default N

    expect(rows[0]).toMatchObject({
      shipmentId: SHIPMENT_ID,
      wouldMatchRuleId: RULE_ID,
      wouldMatchRuleName: 'Catch-all',
      selectedServiceId: SVC_A,
      actualServiceId: SVC_A,
      changed: false,
    });
    expect(rows[1]).toMatchObject({
      shipmentId: SHIPMENT_B,
      selectedServiceId: SVC_A,
      actualServiceId: SVC_B,
      changed: true,
    });
    expectReadOnly(pool);
  });
});
