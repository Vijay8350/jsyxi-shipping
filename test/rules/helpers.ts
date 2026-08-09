import type {
  CandidateFacts,
  ConditionDef,
  EvaluateInput,
  OrderFacts,
  RuleDef,
} from '../../src/modules/rules/evaluate';

/**
 * Fixtures for the pure §9.4.4 core. NOW is 2026-08-02 19:00 UTC — in
 * Asia/Kolkata that is Monday 2026-08-03 00:30, which lets the ADD-12 tests
 * prove shop-local evaluation (UTC Sunday vs IST Monday).
 */
export const NOW = new Date('2026-08-02T19:00:00.000Z');
export const SIX_H_MS = 6 * 60 * 60 * 1000;

export const SHOP_ID = '11111111-1111-1111-1111-111111111111';
export const SHIPMENT_ID = '33333333-3333-3333-3333-333333333333';
export const ORDER_ID = '22222222-2222-2222-2222-222222222222';
export const RULE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const RULE_ID_2 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab';
export const SVC_A = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';
export const SVC_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2';
export const SVC_C = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3';
export const ACCT_1 = '88888888-8888-8888-8888-888888888888';
export const ZONE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

export function orderFacts(over: Partial<OrderFacts> = {}): OrderFacts {
  return {
    deadWeightKg: '1.000',
    orderAmount: '500.00',
    paymentMode: 'PREPAID',
    destinationPincode: '110001',
    skus: ['SKU-1'],
    tags: ['fragile'],
    destState: 'Delhi',
    destCity: 'New Delhi',
    codAmount: '0.00',
    checkoutShippingTitle: 'Express',
    checkoutShippingAmount: '50.00',
    itemCount: 2,
    products: ['Cotton Tee'],
    vendors: ['Acme'],
    collections: ['Summer'],
    riskFlag: null,
    ...over,
  };
}

export function cond(
  field: ConditionDef['field'],
  operator: ConditionDef['operator'],
  value: ConditionDef['value'] = {},
): ConditionDef {
  return { field, operator, value };
}

/** A catch-all single-group rule (no conditions → always matches). */
export function rule(over: Partial<RuleDef> = {}): RuleDef {
  return {
    ruleId: RULE_ID,
    name: 'Rule 1',
    version: 3,
    isActive: true,
    position: 1,
    actionType: 'PRIORITY_CHAIN',
    excludedServiceIds: [],
    activeFrom: null,
    activeTo: null,
    groups: [{ position: 1, conditions: [cond('WEIGHT', 'GTE', { value: '0' })] }],
    actionServiceIds: [SVC_A],
    ...over,
  };
}

export function candidate(over: Partial<CandidateFacts> = {}): CandidateFacts {
  return {
    serviceId: SVC_A,
    courierAccountId: ACCT_1,
    costSource: 'RATE_CARD',
    bookable: true,
    notBookableReason: null,
    priorityTiebreakOrder: 0,
    quote: {
      serviceable: true,
      failureReasons: [],
      rateAvailable: true,
      total: '100.00',
      eddFrom: '2026-08-05',
      eddTo: '2026-08-06',
      fetchedAt: '2026-08-02T18:00:00.000Z', // 1 h before NOW — fresh (F-18)
    },
    quoteError: null,
    zone: 'C',
    volumetricWeightKg: '1.200',
    ...over,
  };
}

export function input(over: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    now: NOW,
    shopTimezone: 'Asia/Kolkata',
    eddStaleMs: SIX_H_MS,
    rules: [rule()],
    order: orderFacts(),
    candidates: [candidate()],
    defaultChainServiceIds: null,
    ...over,
  };
}

/** A quote variant; pass null fields explicitly through `over`. */
export function quote(over: Partial<NonNullable<CandidateFacts['quote']>> = {}) {
  return { ...candidate().quote!, ...over };
}
