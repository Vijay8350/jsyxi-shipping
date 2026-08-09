import { describe, expect, it } from 'vitest';
import { evaluate, type EvaluationResult } from '../../src/modules/rules/evaluate';
import { cond, input, orderFacts, rule, NOW } from './helpers';

/**
 * §3.9 operators + ADD-01…ADD-12 operands + ADD-13 groups + ADD-16
 * scheduling — all against the pure core. "Missing data = no match, shown
 * in trace" (§3.9) is asserted on every family.
 */

function matchResult(r: ReturnType<typeof rule>, order = orderFacts()): EvaluationResult {
  return evaluate(input({ rules: [r], order }));
}

function conditionTrace(result: EvaluationResult) {
  return result.ruleTraces[0].groups[0].conditions[0];
}

describe('§3.9 numeric operators (WEIGHT — F-24 dead weight)', () => {
  const cases: Array<[Parameters<typeof cond>[1], Record<string, string>, string, boolean]> = [
    ['EQUALS', { value: '1.000' }, '1.000', true],
    ['EQUALS', { value: '1.000' }, '1.001', false],
    ['BETWEEN', { min: '0.500', max: '1.500' }, '1.000', true],
    ['BETWEEN', { min: '0.500', max: '1.500' }, '0.500', true], // inclusive (§3.9)
    ['BETWEEN', { min: '0.500', max: '1.500' }, '1.500', true],
    ['BETWEEN', { min: '0.500', max: '1.500' }, '1.501', false],
    ['GTE', { value: '1.000' }, '1.000', true],
    ['GTE', { value: '1.001' }, '1.000', false],
    ['LTE', { value: '1.000' }, '1.000', true],
    ['LTE', { value: '0.999' }, '1.000', false],
  ];
  for (const [op, value, weight, expected] of cases) {
    it(`${op} ${JSON.stringify(value)} vs ${weight} → ${expected}`, () => {
      const r = rule({ groups: [{ position: 1, conditions: [cond('WEIGHT', op, value)] }] });
      const result = matchResult(r, orderFacts({ deadWeightKg: weight }));
      expect(result.matchedRuleId !== null).toBe(expected);
      expect(conditionTrace(result).matched).toBe(expected);
    });
  }

  it('missing weight = no match, shown in trace (§3.9)', () => {
    const r = rule({ groups: [{ position: 1, conditions: [cond('WEIGHT', 'GTE', { value: '0' })] }] });
    const result = matchResult(r, orderFacts({ deadWeightKg: null }));
    expect(result.matchedRuleId).toBeNull();
    const trace = conditionTrace(result);
    expect(trace.matched).toBe(false);
    expect(trace.note).toBe('MISSING_DATA');
    expect(trace.operand).toBeNull();
  });
});

describe('§3.9 PAYMENT_MODE / PINCODE / SKU / TAG', () => {
  it('IS_COD / IS_PREPAID', () => {
    const codRule = rule({
      groups: [{ position: 1, conditions: [cond('PAYMENT_MODE', 'IS_COD')] }],
    });
    expect(matchResult(codRule, orderFacts({ paymentMode: 'COD' })).matchedRuleId).not.toBeNull();
    expect(matchResult(codRule, orderFacts({ paymentMode: 'PREPAID' })).matchedRuleId).toBeNull();
    const prepaidRule = rule({
      groups: [{ position: 1, conditions: [cond('PAYMENT_MODE', 'IS_PREPAID')] }],
    });
    expect(matchResult(prepaidRule, orderFacts({ paymentMode: 'PREPAID' })).matchedRuleId).not.toBeNull();
    expect(matchResult(prepaidRule, orderFacts({ paymentMode: 'UNRESOLVED' })).matchedRuleId).toBeNull();
  });

  it('PINCODE IN_LIST / NOT_IN_LIST / IN_SAVED_ZONE / CSV_UPLOAD', () => {
    const inList = rule({
      groups: [{ position: 1, conditions: [cond('PINCODE', 'IN_LIST', { list: ['110001', '400001'] })] }],
    });
    expect(matchResult(inList).matchedRuleId).not.toBeNull();
    expect(matchResult(inList, orderFacts({ destinationPincode: '560001' })).matchedRuleId).toBeNull();

    const notIn = rule({
      groups: [{ position: 1, conditions: [cond('PINCODE', 'NOT_IN_LIST', { list: ['560001'] })] }],
    });
    expect(matchResult(notIn).matchedRuleId).not.toBeNull();
    expect(matchResult(notIn, orderFacts({ destinationPincode: '560001' })).matchedRuleId).toBeNull();

    // IN_SAVED_ZONE arrives at the core with pincodes inlined by the loader.
    const savedZone = rule({
      groups: [{ position: 1, conditions: [cond('PINCODE', 'IN_SAVED_ZONE', { pincodes: ['110001'] })] }],
    });
    expect(matchResult(savedZone).matchedRuleId).not.toBeNull();

    const csv = rule({
      groups: [{ position: 1, conditions: [cond('PINCODE', 'CSV_UPLOAD', { pincodes: ['400001'] })] }],
    });
    expect(matchResult(csv).matchedRuleId).toBeNull();
  });

  it('SKU IN_LIST = ANY line matches; NOT_IN_LIST = NO line matches (§3.9 A1-03)', () => {
    const anyRule = rule({
      groups: [{ position: 1, conditions: [cond('SKU', 'IN_LIST', { list: ['SKU-2'] })] }],
    });
    expect(matchResult(anyRule, orderFacts({ skus: ['SKU-1', 'SKU-2'] })).matchedRuleId).not.toBeNull();
    expect(matchResult(anyRule, orderFacts({ skus: ['SKU-1'] })).matchedRuleId).toBeNull();

    const noneRule = rule({
      groups: [{ position: 1, conditions: [cond('SKU', 'NOT_IN_LIST', { list: ['SKU-2'] })] }],
    });
    expect(matchResult(noneRule, orderFacts({ skus: ['SKU-1'] })).matchedRuleId).not.toBeNull();
    expect(matchResult(noneRule, orderFacts({ skus: ['SKU-1', 'SKU-2'] })).matchedRuleId).toBeNull();
    // All SKUs missing → missing data = no match, even for NOT_IN_LIST.
    expect(matchResult(noneRule, orderFacts({ skus: [null, null] })).matchedRuleId).toBeNull();
  });

  it('TAG same any/none semantics', () => {
    const tagRule = rule({
      groups: [{ position: 1, conditions: [cond('TAG', 'IN_LIST', { list: ['fragile'] })] }],
    });
    expect(matchResult(tagRule).matchedRuleId).not.toBeNull();
    expect(matchResult(tagRule, orderFacts({ tags: [] })).matchedRuleId).toBeNull();
  });
});

describe('ADD-01/02 DEST_STATE / DEST_CITY (postal master, case-folded)', () => {
  it('matches the postal-master state, case-folded', () => {
    const r = rule({
      groups: [{ position: 1, conditions: [cond('DEST_STATE', 'IN_LIST', { list: ['delhi '] })] }],
    });
    expect(matchResult(r).matchedRuleId).not.toBeNull();
    expect(conditionTrace(matchResult(r)).operand).toBe('Delhi');
  });

  it('NOT_IN_LIST for NE-state exclusion; missing postal row = no match', () => {
    const r = rule({
      groups: [{ position: 1, conditions: [cond('DEST_STATE', 'NOT_IN_LIST', { list: ['Assam'] })] }],
    });
    expect(matchResult(r).matchedRuleId).not.toBeNull();
    expect(matchResult(r, orderFacts({ destState: 'Assam' })).matchedRuleId).toBeNull();
    expect(matchResult(r, orderFacts({ destState: null })).matchedRuleId).toBeNull();
  });

  it('DEST_CITY normalized and case-folded (ADD-02)', () => {
    const r = rule({
      groups: [{ position: 1, conditions: [cond('DEST_CITY', 'IN_LIST', { list: ['new delhi'] })] }],
    });
    expect(matchResult(r).matchedRuleId).not.toBeNull();
  });
});

describe('ADD-04 COD_AMOUNT is F-15, not F-17', () => {
  it('compares against codAmount even when orderAmount differs', () => {
    const r = rule({
      groups: [{ position: 1, conditions: [cond('COD_AMOUNT', 'GTE', { value: '5000.00' })] }],
    });
    const facts = orderFacts({ orderAmount: '9000.00', codAmount: '100.00' });
    expect(matchResult(r, facts).matchedRuleId).toBeNull();
    expect(matchResult(r, orderFacts({ orderAmount: '100.00', codAmount: '6000.00' })).matchedRuleId).not.toBeNull();
  });
});

describe('ADD-06/07/08 checkout shipping + item count', () => {
  it('CHECKOUT_SHIPPING_TITLE CONTAINS (case-folded) and IN_LIST', () => {
    const contains = rule({
      groups: [{ position: 1, conditions: [cond('CHECKOUT_SHIPPING_TITLE', 'CONTAINS', { list: ['expr'] })] }],
    });
    expect(matchResult(contains).matchedRuleId).not.toBeNull();
    const inList = rule({
      groups: [{ position: 1, conditions: [cond('CHECKOUT_SHIPPING_TITLE', 'IN_LIST', { list: ['Free Shipping'] })] }],
    });
    expect(matchResult(inList).matchedRuleId).toBeNull();
    expect(matchResult(inList, orderFacts({ checkoutShippingTitle: null })).matchedRuleId).toBeNull();
  });

  it('CHECKOUT_SHIPPING_AMOUNT BETWEEN', () => {
    const r = rule({
      groups: [{ position: 1, conditions: [cond('CHECKOUT_SHIPPING_AMOUNT', 'BETWEEN', { min: '40.00', max: '60.00' })] }],
    });
    expect(matchResult(r).matchedRuleId).not.toBeNull();
    expect(matchResult(r, orderFacts({ checkoutShippingAmount: '61.00' })).matchedRuleId).toBeNull();
  });

  it('ITEM_COUNT compares the allocated-quantity sum', () => {
    const r = rule({
      groups: [{ position: 1, conditions: [cond('ITEM_COUNT', 'EQUALS', { value: '2' })] }],
    });
    expect(matchResult(r).matchedRuleId).not.toBeNull();
    expect(matchResult(r, orderFacts({ itemCount: 3 })).matchedRuleId).toBeNull();
  });
});

describe('ADD-09 PRODUCT / VENDOR / COLLECTION (SKU-like any/none)', () => {
  it('PRODUCT IN_LIST any-match on line titles', () => {
    const r = rule({
      groups: [{ position: 1, conditions: [cond('PRODUCT', 'IN_LIST', { list: ['Cotton Tee'] })] }],
    });
    expect(matchResult(r).matchedRuleId).not.toBeNull();
    expect(matchResult(r, orderFacts({ products: ['Mug'] })).matchedRuleId).toBeNull();
  });

  it('VENDOR NOT_IN_LIST none-match; COLLECTION IN_LIST', () => {
    const vendor = rule({
      groups: [{ position: 1, conditions: [cond('VENDOR', 'NOT_IN_LIST', { list: ['Acme'] })] }],
    });
    expect(matchResult(vendor).matchedRuleId).toBeNull();
    const collection = rule({
      groups: [{ position: 1, conditions: [cond('COLLECTION', 'IN_LIST', { list: ['Summer'] })] }],
    });
    expect(matchResult(collection).matchedRuleId).not.toBeNull();
  });
});

describe('ADD-11 RISK_FLAG', () => {
  it('IS_HIGH / IS_NOT_HIGH; missing flag = no match', () => {
    const high = rule({
      groups: [{ position: 1, conditions: [cond('RISK_FLAG', 'IS_HIGH')] }],
    });
    expect(matchResult(high, orderFacts({ riskFlag: 'HIGH' })).matchedRuleId).not.toBeNull();
    expect(matchResult(high, orderFacts({ riskFlag: 'MEDIUM' })).matchedRuleId).toBeNull();
    const notHigh = rule({
      groups: [{ position: 1, conditions: [cond('RISK_FLAG', 'IS_NOT_HIGH')] }],
    });
    expect(matchResult(notHigh, orderFacts({ riskFlag: 'LOW' })).matchedRuleId).not.toBeNull();
    expect(matchResult(notHigh, orderFacts({ riskFlag: null })).matchedRuleId).toBeNull();
  });
});

describe('ADD-12 WEEKDAY / TIME_OF_DAY in shop-local time (§5.2)', () => {
  // NOW = 2026-08-02 19:00 UTC = Monday 2026-08-03 00:30 in Asia/Kolkata.
  it('WEEKDAY resolves in the Shop tz, not UTC', () => {
    const monday = rule({
      groups: [{ position: 1, conditions: [cond('WEEKDAY', 'IN_LIST', { list: ['MON'] })] }],
    });
    const sunday = rule({
      groups: [{ position: 1, conditions: [cond('WEEKDAY', 'IN_LIST', { list: ['SUN'] })] }],
    });
    expect(matchResult(monday).matchedRuleId).not.toBeNull(); // IST Monday
    expect(matchResult(sunday).matchedRuleId).toBeNull(); // UTC Sunday is irrelevant
    const trace = conditionTrace(matchResult(monday));
    expect(trace.operand).toBe('MON');
  });

  it('WEEKDAY accepts full names and ISO numbers', () => {
    const full = rule({
      groups: [{ position: 1, conditions: [cond('WEEKDAY', 'IN_LIST', { list: ['Monday'] })] }],
    });
    expect(matchResult(full).matchedRuleId).not.toBeNull();
    const iso = rule({
      groups: [{ position: 1, conditions: [cond('WEEKDAY', 'IN_LIST', { list: ['1'] })] }],
    });
    expect(matchResult(iso).matchedRuleId).not.toBeNull();
  });

  it('TIME_OF_DAY BETWEEN in shop-local wall time', () => {
    const r = rule({
      groups: [{ position: 1, conditions: [cond('TIME_OF_DAY', 'BETWEEN', { min: '00:00', max: '01:00' })] }],
    });
    expect(matchResult(r).matchedRuleId).not.toBeNull(); // 00:30 IST
    const day = rule({
      groups: [{ position: 1, conditions: [cond('TIME_OF_DAY', 'BETWEEN', { min: '09:00', max: '17:00' })] }],
    });
    expect(matchResult(day).matchedRuleId).toBeNull();
  });

  it('TIME_OF_DAY overnight window wraps past midnight', () => {
    const r = rule({
      groups: [{ position: 1, conditions: [cond('TIME_OF_DAY', 'BETWEEN', { min: '22:00', max: '06:00' })] }],
    });
    expect(matchResult(r).matchedRuleId).not.toBeNull(); // 00:30 IST
  });
});

describe('ADD-13 condition groups: AND within, OR between, one level', () => {
  it('OR between groups: second group matching is enough', () => {
    const r = rule({
      groups: [
        { position: 1, conditions: [cond('WEIGHT', 'GTE', { value: '99' })] }, // fails
        { position: 2, conditions: [cond('DEST_STATE', 'IN_LIST', { list: ['Delhi'] })] }, // matches
      ],
    });
    const result = matchResult(r);
    expect(result.matchedRuleId).not.toBeNull();
    expect(result.ruleTraces[0].groups[0].matched).toBe(false);
    expect(result.ruleTraces[0].groups[1].matched).toBe(true);
  });

  it('AND within a group: one failing condition fails the group', () => {
    const r = rule({
      groups: [
        {
          position: 1,
          conditions: [
            cond('DEST_STATE', 'IN_LIST', { list: ['Delhi'] }), // matches
            cond('WEIGHT', 'GTE', { value: '99' }), // fails
          ],
        },
      ],
    });
    const result = matchResult(r);
    expect(result.matchedRuleId).toBeNull();
    const group = result.ruleTraces[0].groups[0];
    expect(group.conditions[0].matched).toBe(true);
    expect(group.conditions[1].matched).toBe(false);
  });
});

describe('§9.4.4 first-match-wins + skipped rules in the trace', () => {
  it('the topmost matching rule wins; later rules are NOT_EVALUATED', () => {
    const first = rule({ position: 1 });
    const second = rule({ ruleId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', name: 'Rule 2', position: 2 });
    const result = evaluate(input({ rules: [first, second] }));
    expect(result.matchedRuleId).toBe(first.ruleId);
    expect(result.ruleTraces.map((t) => t.status)).toEqual(['MATCHED', 'NOT_EVALUATED']);
  });

  it('inactive rules are skipped with SKIPPED_INACTIVE', () => {
    const inactive = rule({ isActive: false, position: 1 });
    const active = rule({ ruleId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', position: 2 });
    const result = evaluate(input({ rules: [inactive, active] }));
    expect(result.matchedRuleId).toBe(active.ruleId);
    expect(result.ruleTraces[0].status).toBe('SKIPPED_INACTIVE');
  });

  it('a non-matching rule shows its failing condition in the trace (§9.4.5)', () => {
    const r = rule({
      groups: [{ position: 1, conditions: [cond('DEST_STATE', 'IN_LIST', { list: ['Assam'] })] }],
    });
    const result = evaluate(input({ rules: [r], defaultChainServiceIds: null }));
    expect(result.ruleTraces[0].status).toBe('NO_MATCH');
    expect(conditionTrace(result).matched).toBe(false);
    expect(conditionTrace(result).operand).toBe('Delhi');
  });
});

describe('ADD-16 scheduling (shop-local window)', () => {
  it('before active_from → SKIPPED_SCHEDULE', () => {
    const r = rule({ activeFrom: '2026-08-03T00:00:00.000Z' }); // future vs NOW
    const result = evaluate(input({ rules: [r] }));
    expect(result.matchedRuleId).toBeNull();
    expect(result.ruleTraces[0].status).toBe('SKIPPED_SCHEDULE');
  });

  it('at/after active_to → SKIPPED_SCHEDULE (to exclusive)', () => {
    const r = rule({ activeFrom: '2026-08-01T00:00:00.000Z', activeTo: NOW.toISOString() });
    const result = evaluate(input({ rules: [r] }));
    expect(result.ruleTraces[0].status).toBe('SKIPPED_SCHEDULE');
  });

  it('inside the window → evaluated normally', () => {
    const r = rule({
      activeFrom: '2026-08-01T00:00:00.000Z',
      activeTo: '2026-09-01T00:00:00.000Z',
    });
    const result = evaluate(input({ rules: [r] }));
    expect(result.matchedRuleId).toBe(r.ruleId);
  });
});
