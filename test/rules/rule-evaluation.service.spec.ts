import { describe, expect, it, vi } from 'vitest';
import { RuleEvaluationService } from '../../src/modules/rules/rule-evaluation.service';
import { QuoteCacheService } from '../../src/modules/booking/quote-cache.service';
import { evaluate } from '../../src/modules/rules/evaluate';
import {
  FnPool,
  orderRow,
  rateCardQuote,
  serviceVersionRow,
  shipmentRow,
  workingValues,
} from '../booking/helpers';
import {
  ACCT_1,
  RULE_ID,
  SHIPMENT_ID,
  SHOP_ID,
  SVC_A,
  ZONE_ID,
} from './helpers';

const MS_ID = '77777777-7777-7777-7777-777777777777';
const ZONE_MAP_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const POSTAL_VERSION_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const NOW = new Date('2026-08-02T19:00:00.000Z');

/**
 * RuleEvaluationService — the loader around the pure core. Proves operand
 * provenance: ADD-01/02 from the postal master (NOT the address string),
 * ADD-04 from cod_outstanding (F-15), IN_SAVED_ZONE inlining, S-22 mapping,
 * and the §4.5 cache serving ADD-05/ADD-10 without an uncached call.
 */

function ruleRow(over: Record<string, unknown> = {}) {
  return {
    rule_id: RULE_ID,
    shop_id: SHOP_ID,
    name: 'COD rule',
    pickup_location_id: null,
    is_active: true,
    position: 1,
    action_type: 'PRIORITY_CHAIN',
    excluded_service_ids: [],
    active_from: null,
    active_to: null,
    version: 2,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

function candidateRow(over: Record<string, unknown> = {}) {
  return {
    merchant_service_id: MS_ID,
    courier_account_id: ACCT_1,
    service_id: SVC_A,
    enabled: true,
    priority_tiebreak_order: 0,
    cost_source: 'RATE_CARD',
    service_active: true,
    account_disabled_at: null,
    ...over,
  };
}

interface StageOpts {
  costSource?: string;
  conditionRows?: Record<string, unknown>[];
  defaultChain?: string[] | null;
  quoteCacheRow?: Record<string, unknown> | null;
}

function staged(opts: StageOpts = {}) {
  const pool = new FnPool();
  // More specific patterns first (FnPool matches in registration order).
  pool.on(/postal_pincode pp/, [{ state: 'Delhi', city: 'New Delhi' }]); // postal master
  pool.on(/FROM postal_pincode WHERE postal_version_id/, [
    { city: 'X', district: 'Y', state: 'Karnataka', region: 'S', is_metro: false, is_special: false },
  ]);
  pool.on(/SELECT merchant_service_id, service_id FROM merchant_service/, [
    { merchant_service_id: MS_ID, service_id: SVC_A },
  ]);
  pool.on(/FROM shipment/, [shipmentRow({ service_id: null })]);
  pool.on(/FROM "order"/, [
    orderRow({
      checkout_shipping_title: 'Express',
      checkout_shipping_amount: '50.00',
      risk_flag: 'HIGH',
    }),
  ]);
  pool.on(/FROM store_settings/, [{ timezone: 'Asia/Kolkata' }]);
  pool.on(/FROM rule WHERE/, [ruleRow()]);
  pool.on(/FROM rule_condition_group/, [
    { group_id: 'g1', rule_id: RULE_ID, position: 1 },
  ]);
  pool.on(
    /FROM rule_condition WHERE/,
    opts.conditionRows ?? [
      {
        condition_id: 'c1',
        rule_id: RULE_ID,
        group_id: 'g1',
        field: 'PINCODE',
        operator: 'IN_SAVED_ZONE',
        value_json: { zoneId: ZONE_ID },
      },
      {
        condition_id: 'c2',
        rule_id: RULE_ID,
        group_id: 'g1',
        field: 'DEST_STATE',
        operator: 'IN_LIST',
        value_json: { list: ['Delhi'] },
      },
    ],
  );
  pool.on(/FROM rule_action_service/, [
    { action_service_id: 'as1', rule_id: RULE_ID, service_id: SVC_A, position: 1 },
  ]);
  pool.on(/FROM saved_zone/, [{ saved_zone_id: ZONE_ID, pincodes: ['560001'] }]);
  pool.on(
    /FROM order_sync_settings/,
    [{ default_chain: opts.defaultChain === undefined ? null : opts.defaultChain }],
  );
  pool.on(/FROM pickup_location/, [{ pincode: '380015' }]);
  pool.on(/priority_tiebreak_order/, [
    candidateRow({ cost_source: opts.costSource ?? 'RATE_CARD' }),
  ]);
  pool.on(/FROM service_version/, [
    { service_id: SVC_A, ...serviceVersionRow() },
  ]);
  pool.on(/FROM commercial_zone_map/, [{ postal_version_id: POSTAL_VERSION_ID }]);
  pool.on(/FROM commercial_zone_rule/, [
    { origin_matcher: {}, destination_matcher: {}, zone: 'C', position: 1 },
  ]);
  pool.on(/FROM quote/, opts.quoteCacheRow ? [opts.quoteCacheRow] : []);

  const merchantServices = { isBookable: vi.fn().mockResolvedValue(true) };
  const estimates = {
    estimateCost: vi.fn().mockResolvedValue({
      quote: rateCardQuote(),
      rateCardVersionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      zoneMapId: ZONE_MAP_ID,
    }),
  };
  const adapterCaller = { call: vi.fn() };
  const quoteCache = new QuoteCacheService(pool.asPool(), adapterCaller as never);
  const svc = new RuleEvaluationService(
    pool.asPool(),
    merchantServices as never,
    estimates as never,
    quoteCache,
  );
  return { pool, svc, merchantServices, estimates, adapterCaller };
}

describe('operand provenance', () => {
  it('resolves order facts from working values + order columns + postal master', async () => {
    const { pool, svc } = staged();
    const loaded = await svc.loadForShipment(pool.asPool(), SHOP_ID, SHIPMENT_ID, NOW);
    expect(loaded).not.toBeNull();
    const o = loaded!.input.order;

    // F-24 from the working weight block; F-17/F-15 from the order columns.
    expect(o.deadWeightKg).toBe('0.540');
    expect(o.orderAmount).toBe('1250.50');
    expect(o.codAmount).toBe('1250.50'); // ADD-04: cod_outstanding (F-15)
    expect(o.paymentMode).toBe('COD');
    expect(o.destinationPincode).toBe('560001');

    // ADD-01/02: from the postal master — the working recipient's address
    // strings are 'Karnataka'/'Bengaluru', NOT 'Delhi'/'New Delhi'.
    expect(o.destState).toBe('Delhi');
    expect(o.destCity).toBe('New Delhi');
    const postalQuery = pool.matching(/postal_pincode pp/);
    expect(postalQuery[0].params[0]).toBe('560001'); // by pincode, not by address

    // ADD-06/07/11 from the order columns; ADD-08 sums allocated quantities.
    expect(o.checkoutShippingTitle).toBe('Express');
    expect(o.checkoutShippingAmount).toBe('50.00');
    expect(o.riskFlag).toBe('HIGH');
    expect(o.itemCount).toBe(2);
    expect(o.skus).toEqual(['TEE-BLK-M']);
    expect(o.tags).toEqual(['summer']);
    expect(o.products).toEqual(['Cotton Tee']);
  });

  it('inlines IN_SAVED_ZONE pincodes and maps S-22 merchant-service ids', async () => {
    const { pool, svc } = staged({ defaultChain: [MS_ID] });
    const loaded = await svc.loadForShipment(pool.asPool(), SHOP_ID, SHIPMENT_ID, NOW);
    const ruleDef = loaded!.input.rules[0];
    const zoneCond = ruleDef.groups[0].conditions.find((c) => c.operator === 'IN_SAVED_ZONE')!;
    expect(zoneCond.value.pincodes).toEqual(['560001']);
    expect(zoneCond.value.zoneId).toBe(ZONE_ID);
    expect(loaded!.input.defaultChainServiceIds).toEqual([SVC_A]);
    expect(loaded!.input.shopTimezone).toBe('Asia/Kolkata');
  });

  it('loads RATE_CARD candidate facts: estimate, per-card zone, per-service volumetric', async () => {
    const { pool, svc, estimates, merchantServices } = staged();
    const loaded = await svc.loadForShipment(pool.asPool(), SHOP_ID, SHIPMENT_ID, NOW);
    const c = loaded!.input.candidates.find((x) => x.serviceId === SVC_A)!;
    expect(estimates.estimateCost).toHaveBeenCalledOnce();
    expect(merchantServices.isBookable).toHaveBeenCalledWith(SHOP_ID, ACCT_1, SVC_A);
    expect(c.quote?.total).toBe('94.40');
    expect(c.zone).toBe('C'); // F-4 against the rate card's zone map (ADD-03)
    expect(c.volumetricWeightKg).toBe('1.000'); // F-1: 25×20×10 cm ÷ 5000
    expect(c.bookable).toBe(true);

    // The full run selects the candidate (pincode in saved zone, state Delhi).
    const result = evaluate(loaded!.input);
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_A });
  });

  it('every loader query is shop-scoped (INV-1)', async () => {
    const { pool, svc } = staged();
    await svc.loadForShipment(pool.asPool(), SHOP_ID, SHIPMENT_ID, NOW);
    const shopScoped = pool.calls.filter((c) => /\bFROM\b|\bJOIN\b/.test(c.sql));
    for (const call of shopScoped) {
      // Global reference tables (postal master, service_version) carry no
      // shop_id; rule child tables are scoped through the shop-owned parent
      // rule_id; everything else must filter by shop_id directly.
      if (/postal_|service_version|commercial_zone_rule|rule_condition|rule_action_service/.test(call.sql)) {
        continue;
      }
      expect(call.params).toContain(SHOP_ID);
    }
  });
});

describe('ADD-05/ADD-10 never force an uncached quote call (§4.5 cache)', () => {
  const freshCacheRow = {
    quote_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    components_json: { components: [{ code: 'F-5', label: 'Base', amount: '94.40', taxable: true }], rtoRule: null },
    total: '94.40',
    currency: 'INR',
    provider_quote_ref: 'ref-1',
    fetched_at: '2026-08-02T18:30:00.000Z',
    edd_from: '2026-08-05',
    edd_to: '2026-08-06',
    edd_source: 'PROVIDER',
  };

  it('serves the LIVE_QUOTE candidate from a fresh cache row — no adapter call', async () => {
    const { pool, svc, adapterCaller, estimates } = staged({
      costSource: 'LIVE_QUOTE',
      conditionRows: [
        {
          condition_id: 'c1',
          rule_id: RULE_ID,
          group_id: 'g1',
          field: 'ESTIMATED_FREIGHT',
          operator: 'LTE',
          value_json: { value: '100.00' },
        },
      ],
      quoteCacheRow: freshCacheRow,
    });
    const loaded = await svc.loadForShipment(pool.asPool(), SHOP_ID, SHIPMENT_ID, NOW);
    const c = loaded!.input.candidates.find((x) => x.serviceId === SVC_A)!;
    expect(c.quote?.total).toBe('94.40'); // the CACHED quote (S-16 TTL)
    expect(adapterCaller.call).not.toHaveBeenCalled(); // cache hit, no fetch
    expect(estimates.estimateCost).not.toHaveBeenCalled();

    // The ADD-05 filter passes against the cached price (94.40 ≤ 100).
    const result = evaluate(loaded!.input);
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_A });
  });

  it('the ADD-05 filter eliminates against the cached price, still no adapter call', async () => {
    const { pool, svc, adapterCaller } = staged({
      costSource: 'LIVE_QUOTE',
      conditionRows: [
        {
          condition_id: 'c1',
          rule_id: RULE_ID,
          group_id: 'g1',
          field: 'ESTIMATED_FREIGHT',
          operator: 'GTE',
          value_json: { value: '500.00' },
        },
      ],
      quoteCacheRow: freshCacheRow,
    });
    const loaded = await svc.loadForShipment(pool.asPool(), SHOP_ID, SHIPMENT_ID, NOW);
    const result = evaluate(loaded!.input);
    expect(adapterCaller.call).not.toHaveBeenCalled();
    expect(result.outcome).toEqual({
      kind: 'MANUAL_ASSIGNMENT',
      reason: 'CHAIN_EXHAUSTED', // PRIORITY_CHAIN action, only candidate filtered out
    });
    expect(result.candidateResults[0].reasons.map((r) => r.code)).toContain(
      'ESTIMATED_FREIGHT_FILTERED',
    );
  });
});
