import { describe, expect, it } from 'vitest';
import { evaluate } from '../../src/modules/rules/evaluate';
import { SVC_A, SVC_B, SVC_C, candidate, cond, input, quote, rule } from './helpers';

/**
 * §4.5 candidate elimination — one rule per action, never merged (RV-04) —
 * plus ADD-03/05/10 candidate-level filters, ADD-15 exclusions and ADD-14
 * MANUAL_ONLY. All against the pure core.
 */

const unserviceable = { serviceable: false, failureReasons: ['PINCODE_NOT_SERVED'] };

describe('§4.5 PRIORITY_CHAIN', () => {
  it('books the first chain position; price and EDD never eliminate (A3-04)', () => {
    const a = candidate({
      serviceId: SVC_A,
      quote: null, // COST_SOURCE = NONE-style: no price, no EDD
      costSource: 'NONE',
    });
    const b = candidate({ serviceId: SVC_B });
    const result = evaluate(
      input({
        rules: [rule({ actionType: 'PRIORITY_CHAIN', actionServiceIds: [SVC_A, SVC_B] })],
        candidates: [a, b],
      }),
    );
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_A });
    const aResult = result.candidateResults.find((c) => c.serviceId === SVC_A)!;
    expect(aResult.eliminated).toBe(false);
    expect(aResult.selected).toBe(true);
  });

  it('a serviceability failure moves down the chain; nothing else does', () => {
    const a = candidate({ serviceId: SVC_A, quote: quote(unserviceable) });
    const b = candidate({ serviceId: SVC_B });
    const result = evaluate(
      input({
        rules: [rule({ actionType: 'PRIORITY_CHAIN', actionServiceIds: [SVC_A, SVC_B] })],
        candidates: [a, b],
      }),
    );
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_B });
    const aResult = result.candidateResults.find((c) => c.serviceId === SVC_A)!;
    expect(aResult.eliminated).toBe(true);
    expect(aResult.reasons[0].code).toBe('NOT_SERVICEABLE');
    expect(aResult.reasons[0].detail).toContain('PINCODE_NOT_SERVED');
  });

  it('every position failed → NEEDS_MANUAL_ASSIGNMENT / CHAIN_EXHAUSTED (§3.30)', () => {
    const a = candidate({ serviceId: SVC_A, quote: quote(unserviceable) });
    const b = candidate({ serviceId: SVC_B, bookable: false, notBookableReason: 'MERCHANT_SERVICE_DISABLED' });
    const result = evaluate(
      input({
        rules: [rule({ actionType: 'PRIORITY_CHAIN', actionServiceIds: [SVC_A, SVC_B] })],
        candidates: [a, b],
      }),
    );
    expect(result.outcome).toEqual({ kind: 'MANUAL_ASSIGNMENT', reason: 'CHAIN_EXHAUSTED' });
    expect(result.selectedServiceId).toBeNull();
    // RV-03: per-Service failure detail in candidate_results.
    const bResult = result.candidateResults.find((c) => c.serviceId === SVC_B)!;
    expect(bResult.reasons[0].code).toBe('NOT_BOOKABLE');
    expect(bResult.reasons[0].detail).toBe('MERCHANT_SERVICE_DISABLED');
  });
});

describe('§4.5 CHEAPEST', () => {
  it('picks the lowest F-11/quote total; ties by priority_tiebreak_order', () => {
    const a = candidate({ serviceId: SVC_A, quote: quote({ total: '120.00' }), priorityTiebreakOrder: 0 });
    const b = candidate({ serviceId: SVC_B, quote: quote({ total: '100.00' }), priorityTiebreakOrder: 5 });
    const c = candidate({ serviceId: SVC_C, quote: quote({ total: '100.00' }), priorityTiebreakOrder: 2 });
    const result = evaluate(
      input({
        rules: [rule({ actionType: 'CHEAPEST', actionServiceIds: [SVC_A, SVC_B, SVC_C] })],
        candidates: [a, b, c],
      }),
    );
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_C });
  });

  it('unpriced candidates ARE excluded; a missing/stale EDD is NOT', () => {
    const cheapest = candidate({
      serviceId: SVC_A,
      costSource: 'NONE',
      quote: null,
    });
    const eddless = candidate({
      serviceId: SVC_B,
      quote: quote({ total: '150.00', eddFrom: null, eddTo: null, fetchedAt: '2020-01-01T00:00:00Z' }),
    });
    const result = evaluate(
      input({
        rules: [rule({ actionType: 'CHEAPEST', actionServiceIds: [SVC_A, SVC_B] })],
        candidates: [cheapest, eddless],
      }),
    );
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_B });
    const aResult = result.candidateResults.find((c) => c.serviceId === SVC_A)!;
    expect(aResult.eliminated).toBe(true);
    expect(aResult.reasons.map((r) => r.code)).toContain('PRICE_UNAVAILABLE');
  });

  it('a failed quote excludes from CHEAPEST as PRICE_UNAVAILABLE', () => {
    const a = candidate({ serviceId: SVC_A, costSource: 'LIVE_QUOTE', quote: null, quoteError: 'quote call failed: Error' });
    const b = candidate({ serviceId: SVC_B, quote: quote({ total: '200.00' }) });
    const result = evaluate(
      input({
        rules: [rule({ actionType: 'CHEAPEST', actionServiceIds: [SVC_A, SVC_B] })],
        candidates: [a, b],
      }),
    );
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_B });
    expect(
      result.candidateResults.find((c) => c.serviceId === SVC_A)!.reasons.map((r) => r.code),
    ).toContain('PRICE_UNAVAILABLE');
  });

  it('no priced candidate → "price unavailable — fell back to chain" (A2-12)', () => {
    const a = candidate({ serviceId: SVC_A, costSource: 'NONE', quote: null });
    const chainSvc = candidate({ serviceId: SVC_C });
    const result = evaluate(
      input({
        rules: [rule({ actionType: 'CHEAPEST', actionServiceIds: [SVC_A] })],
        candidates: [a, chainSvc],
        defaultChainServiceIds: [SVC_C],
      }),
    );
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_C });
    expect(result.fallbackChain).toEqual({
      kind: 'CHAIN_FALLBACK',
      note: 'price unavailable — fell back to chain',
      serviceIds: [SVC_C],
    });
  });

  it('chain also exhausted → NO_SERVICEABLE_CANDIDATE (§3.30)', () => {
    const a = candidate({ serviceId: SVC_A, costSource: 'NONE', quote: null });
    const chainSvc = candidate({ serviceId: SVC_C, quote: quote(unserviceable) });
    const result = evaluate(
      input({
        rules: [rule({ actionType: 'CHEAPEST', actionServiceIds: [SVC_A] })],
        candidates: [a, chainSvc],
        defaultChainServiceIds: [SVC_C],
      }),
    );
    expect(result.outcome).toEqual({ kind: 'MANUAL_ASSIGNMENT', reason: 'NO_SERVICEABLE_CANDIDATE' });
  });
});

describe('§4.5 FASTEST', () => {
  it('picks the lowest EDD; a failed PRICE alone never excludes', () => {
    const slow = candidate({ serviceId: SVC_A, quote: quote({ eddTo: '2026-08-10' }) });
    const fastUnpriced = candidate({
      serviceId: SVC_B,
      quote: quote({ eddTo: '2026-08-04', rateAvailable: false, total: null }),
    });
    const result = evaluate(
      input({
        rules: [rule({ actionType: 'FASTEST', actionServiceIds: [SVC_A, SVC_B] })],
        candidates: [slow, fastUnpriced],
      }),
    );
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_B });
  });

  it('a stale EDD (F-18) is excluded while a fresh one is not', () => {
    const stale = candidate({
      serviceId: SVC_A,
      quote: quote({ eddTo: '2026-08-03', fetchedAt: '2026-08-02T10:00:00.000Z' }), // 9 h > S-18 6 h
    });
    const fresh = candidate({
      serviceId: SVC_B,
      quote: quote({ eddTo: '2026-08-05', fetchedAt: '2026-08-02T18:00:00.000Z' }),
    });
    const result = evaluate(
      input({
        rules: [rule({ actionType: 'FASTEST', actionServiceIds: [SVC_A, SVC_B] })],
        candidates: [stale, fresh],
      }),
    );
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_B });
    const aResult = result.candidateResults.find((c) => c.serviceId === SVC_A)!;
    expect(aResult.reasons.map((r) => r.code)).toContain('EDD_STALE');
  });

  it('a missing EDD is excluded with EDD_MISSING', () => {
    const a = candidate({ serviceId: SVC_A, quote: quote({ eddTo: null, eddFrom: null }) });
    const b = candidate({ serviceId: SVC_B, quote: quote({ eddTo: '2026-08-05' }) });
    const result = evaluate(
      input({
        rules: [rule({ actionType: 'FASTEST', actionServiceIds: [SVC_A, SVC_B] })],
        candidates: [a, b],
      }),
    );
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_B });
    expect(
      result.candidateResults.find((c) => c.serviceId === SVC_A)!.reasons.map((r) => r.code),
    ).toContain('EDD_MISSING');
  });

  it('no usable EDD → fall back to the chain with the reason recorded (A1-03)', () => {
    const a = candidate({ serviceId: SVC_A, quote: quote({ eddTo: null, eddFrom: null }) });
    const chainSvc = candidate({ serviceId: SVC_C });
    const result = evaluate(
      input({
        rules: [rule({ actionType: 'FASTEST', actionServiceIds: [SVC_A] })],
        candidates: [a, chainSvc],
        defaultChainServiceIds: [SVC_C],
      }),
    );
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_C });
    expect(result.fallbackChain?.kind).toBe('CHAIN_FALLBACK');
    expect(result.fallbackChain?.note).toBe('no usable EDD — fell back to chain');
  });
});

describe('ADD-14 MANUAL_ONLY', () => {
  it('short-circuits to NEEDS_MANUAL_ASSIGNMENT / HELD_BY_RULE before candidates', () => {
    const result = evaluate(
      input({
        rules: [rule({ actionType: 'MANUAL_ONLY', actionServiceIds: [] })],
        candidates: [],
      }),
    );
    expect(result.outcome).toEqual({ kind: 'MANUAL_ASSIGNMENT', reason: 'HELD_BY_RULE' });
    expect(result.candidateResults).toEqual([]);
    expect(result.matchedRuleId).not.toBeNull();
  });
});

describe('ADD-15 excluded_service_ids', () => {
  it('eliminates before the action rule, with its own trace reason', () => {
    const cheap = candidate({ serviceId: SVC_A, quote: quote({ total: '90.00' }) });
    const dear = candidate({ serviceId: SVC_B, quote: quote({ total: '150.00' }) });
    const result = evaluate(
      input({
        rules: [
          rule({ actionType: 'CHEAPEST', actionServiceIds: [SVC_A, SVC_B], excludedServiceIds: [SVC_A] }),
        ],
        candidates: [cheap, dear],
      }),
    );
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_B });
    const aResult = result.candidateResults.find((c) => c.serviceId === SVC_A)!;
    expect(aResult.eliminated).toBe(true);
    expect(aResult.reasons[0].code).toBe('EXCLUDED_BY_RULE');
  });
});

describe('ADD-05 ESTIMATED_FREIGHT candidate filter', () => {
  it('filters during elimination with its own reason; priced by the candidate quote', () => {
    const cheap = candidate({ serviceId: SVC_A, quote: quote({ total: '90.00' }) });
    const dear = candidate({ serviceId: SVC_B, quote: quote({ total: '600.00' }) });
    const r = rule({
      actionType: 'CHEAPEST',
      actionServiceIds: [SVC_A, SVC_B],
      groups: [
        {
          position: 1,
          conditions: [cond('ESTIMATED_FREIGHT', 'GTE', { value: '500.00' })],
        },
      ],
    });
    const result = evaluate(input({ rules: [r], candidates: [cheap, dear] }));
    // The group condition is deferred (candidate-level), never order-level.
    expect(result.ruleTraces[0].groups[0].conditions[0].note).toBe('DEFERRED_TO_CANDIDATES');
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_B });
    const aResult = result.candidateResults.find((c) => c.serviceId === SVC_A)!;
    expect(aResult.reasons.map((x) => x.code)).toContain('ESTIMATED_FREIGHT_FILTERED');
  });
});

describe('ADD-10 VOLUMETRIC_WEIGHT candidate filter', () => {
  it('per-Service F-1 compared during elimination', () => {
    const light = candidate({ serviceId: SVC_A, volumetricWeightKg: '1.200' });
    const heavy = candidate({ serviceId: SVC_B, volumetricWeightKg: '6.500' });
    const r = rule({
      actionType: 'PRIORITY_CHAIN',
      actionServiceIds: [SVC_A, SVC_B],
      groups: [
        { position: 1, conditions: [cond('VOLUMETRIC_WEIGHT', 'LTE', { value: '5.000' })] },
      ],
    });
    const result = evaluate(input({ rules: [r], candidates: [light, heavy] }));
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_A });
    const bResult = result.candidateResults.find((c) => c.serviceId === SVC_B)!;
    expect(bResult.volumetricWeightKg).toBe('6.500');
    // The filter is applied to every candidate up front (ADD-10 is an
    // elimination filter, not an order-level condition).
    expect(bResult.eliminated).toBe(true);
    expect(bResult.reasons.map((x) => x.code)).toContain('VOLUMETRIC_WEIGHT_FILTERED');

    const r2 = rule({
      actionType: 'PRIORITY_CHAIN',
      actionServiceIds: [SVC_B, SVC_A],
      groups: [
        { position: 1, conditions: [cond('VOLUMETRIC_WEIGHT', 'LTE', { value: '5.000' })] },
      ],
    });
    const result2 = evaluate(input({ rules: [r2], candidates: [light, heavy] }));
    expect(result2.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_A });
    expect(
      result2.candidateResults.find((c) => c.serviceId === SVC_B)!.reasons.map((x) => x.code),
    ).toContain('VOLUMETRIC_WEIGHT_FILTERED');
  });
});

describe('ADD-03 ZONE candidate-adjacent condition', () => {
  it('resolved per candidate and recorded in the trace', () => {
    const zoneC = candidate({ serviceId: SVC_A, zone: 'C' });
    const zoneE = candidate({ serviceId: SVC_B, zone: 'E' });
    const r = rule({
      actionType: 'PRIORITY_CHAIN',
      actionServiceIds: [SVC_A, SVC_B],
      groups: [{ position: 1, conditions: [cond('ZONE', 'IN_LIST', { list: ['E'] })] }],
    });
    const result = evaluate(input({ rules: [r], candidates: [zoneC, zoneE] }));
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_B });
    const aResult = result.candidateResults.find((c) => c.serviceId === SVC_A)!;
    expect(aResult.zone).toBe('C');
    expect(aResult.reasons.map((x) => x.code)).toContain('ZONE_FILTERED');
    expect(result.ruleTraces[0].groups[0].conditions[0].note).toBe('DEFERRED_TO_CANDIDATES');
  });

  it('an unresolvable zone (LIVE_QUOTE has no zone map, §4.3) = no match', () => {
    const live = candidate({ serviceId: SVC_A, costSource: 'LIVE_QUOTE', zone: null });
    const r = rule({
      actionType: 'PRIORITY_CHAIN',
      actionServiceIds: [SVC_A],
      groups: [{ position: 1, conditions: [cond('ZONE', 'IN_LIST', { list: ['A'] })] }],
    });
    const result = evaluate(input({ rules: [r], candidates: [live] }));
    expect(result.outcome).toEqual({ kind: 'MANUAL_ASSIGNMENT', reason: 'CHAIN_EXHAUSTED' });
    expect(result.candidateResults[0].reasons[0].code).toBe('ZONE_FILTERED');
  });
});

describe('no rule matched → S-22 default chain as PRIORITY_CHAIN (§9.4.4)', () => {
  const noMatchRule = rule({
    groups: [{ position: 1, conditions: [cond('DEST_STATE', 'IN_LIST', { list: ['Assam'] })] }],
  });

  it('S-22 unset → NO_RULE_AND_NO_DEFAULT_CHAIN, never an arbitrary Service (RW-22)', () => {
    const result = evaluate(input({ rules: [noMatchRule], defaultChainServiceIds: null }));
    expect(result.outcome).toEqual({ kind: 'MANUAL_ASSIGNMENT', reason: 'NO_RULE_AND_NO_DEFAULT_CHAIN' });
  });

  it('S-22 evaluated as PRIORITY_CHAIN in chain order', () => {
    const a = candidate({ serviceId: SVC_A, quote: quote(unserviceable) });
    const b = candidate({ serviceId: SVC_B });
    const result = evaluate(
      input({ rules: [noMatchRule], candidates: [a, b], defaultChainServiceIds: [SVC_A, SVC_B] }),
    );
    expect(result.outcome).toEqual({ kind: 'SELECTED', serviceId: SVC_B });
    expect(result.fallbackChain).toEqual({
      kind: 'S22_DEFAULT_CHAIN',
      note: 'no rule matched — evaluated S-22 as PRIORITY_CHAIN',
      serviceIds: [SVC_A, SVC_B],
    });
    expect(result.matchedRuleId).toBeNull();
  });

  it('every S-22 Service unusable → NO_RULE_AND_NO_DEFAULT_CHAIN (§3.30)', () => {
    const a = candidate({ serviceId: SVC_A, quote: quote(unserviceable) });
    const result = evaluate(
      input({ rules: [noMatchRule], candidates: [a], defaultChainServiceIds: [SVC_A] }),
    );
    expect(result.outcome).toEqual({ kind: 'MANUAL_ASSIGNMENT', reason: 'NO_RULE_AND_NO_DEFAULT_CHAIN' });
  });
});

describe('trace content (§9.4.5)', () => {
  it('candidate results carry cost, EDD, quote timestamps, zone and volumetric', () => {
    const result = evaluate(input());
    const c = result.candidateResults.find((x) => x.serviceId === SVC_A)!;
    expect(c.cost).toBe('100.00');
    expect(c.eddFrom).toBe('2026-08-05');
    expect(c.eddTo).toBe('2026-08-06');
    expect(c.quoteFetchedAt).toBe('2026-08-02T18:00:00.000Z');
    expect(c.zone).toBe('C');
    expect(c.volumetricWeightKg).toBe('1.200');
    expect(c.selected).toBe(true);
    expect(result.matchedRuleVersion).toBe(3);
  });
});
