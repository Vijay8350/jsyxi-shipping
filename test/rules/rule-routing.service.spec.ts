import { describe, expect, it, vi } from 'vitest';
import { RuleRoutingService } from '../../src/modules/rules/rule-routing.service';
import type { EvaluationResult } from '../../src/modules/rules/evaluate';
import type { LoadedEvaluation } from '../../src/modules/rules/rule-evaluation.service';
import { FnPool, mockAudit } from '../booking/helpers';
import { RULE_ID, SHIPMENT_ID, SHOP_ID, SVC_A, input } from './helpers';

const TRACE_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

/**
 * RuleRoutingService.evaluateForShipment — the persisting production path:
 * trace row, outcome write, idempotent re-evaluation, audit (§9.4.4/§9.4.5,
 * §3.2, §3.30, INV-22). The evaluation core is stubbed; its behavior is
 * covered by the pure-core specs.
 */

function selectedResult(): EvaluationResult {
  return {
    matchedRuleId: RULE_ID,
    matchedRuleVersion: 3,
    ruleTraces: [
      {
        ruleId: RULE_ID,
        name: 'Rule 1',
        version: 3,
        position: 1,
        status: 'MATCHED',
        groups: [],
      },
    ],
    candidateResults: [
      {
        serviceId: SVC_A,
        costSource: 'RATE_CARD',
        cost: '100.00',
        eddFrom: null,
        eddTo: null,
        quoteFetchedAt: '2026-08-02T18:00:00.000Z',
        zone: 'C',
        volumetricWeightKg: '1.200',
        eliminated: false,
        reasons: [],
        selected: true,
      },
    ],
    selectedServiceId: SVC_A,
    fallbackChain: null,
    outcome: { kind: 'SELECTED', serviceId: SVC_A },
  };
}

function manualResult(reason: 'HELD_BY_RULE' | 'CHAIN_EXHAUSTED' | 'NO_SERVICEABLE_CANDIDATE' | 'NO_RULE_AND_NO_DEFAULT_CHAIN'): EvaluationResult {
  return { ...selectedResult(), selectedServiceId: null, outcome: { kind: 'MANUAL_ASSIGNMENT', reason } };
}

function staged(result: EvaluationResult, bookingState = 'DRAFT') {
  const pool = new FnPool();
  const audit = mockAudit();
  const loaded: LoadedEvaluation = {
    shipment: {
      shipment_id: SHIPMENT_ID,
      shop_id: SHOP_ID,
      order_id: '22222222-2222-2222-2222-222222222222',
      pickup_location_id: '44444444-4444-4444-4444-444444444444',
      service_id: null,
      booking_state: bookingState,
      is_test: false,
      working_values: null,
      version: 3,
      created_at: '2026-08-01T00:00:00.000Z',
    },
    input: input(),
  };
  const evaluation = {
    loadForShipment: vi.fn().mockResolvedValue(loaded),
    evaluateLoaded: vi.fn().mockResolvedValue(result),
  };
  pool.on(/INSERT INTO rule_evaluation_trace/, [{ trace_id: TRACE_ID }]);
  pool.on(/UPDATE shipment/, [], 1);
  const svc = new RuleRoutingService(pool.asPool(), evaluation as never, audit as never);
  return { pool, audit, evaluation, svc };
}

describe('evaluateForShipment — SELECTED outcome', () => {
  it('persists the §9.4.5 trace and writes service_id + routing block', async () => {
    const { pool, audit, svc } = staged(selectedResult());
    const out = await svc.evaluateForShipment(SHOP_ID, SHIPMENT_ID);
    expect(out.evaluated).toBe(true);
    if (out.evaluated) expect(out.traceId).toBe(TRACE_ID);

    const traceInsert = pool.matching(/INSERT INTO rule_evaluation_trace/);
    expect(traceInsert).toHaveLength(1);
    expect(traceInsert[0].params[0]).toBe(SHOP_ID); // INV-1
    expect(traceInsert[0].params[1]).toBe(SHIPMENT_ID);
    expect(traceInsert[0].params[2]).toBe(RULE_ID); // matched rule
    expect(traceInsert[0].params[3]).toBe(3); // and its version
    expect(traceInsert[0].params[6]).toBe(SVC_A); // selected service

    const update = pool.matching(/UPDATE shipment/);
    expect(update).toHaveLength(1);
    expect(update[0].sql).toContain('service_id = $3');
    expect(update[0].sql).toContain("booking_state = 'DRAFT'");
    expect(update[0].sql).toContain('version = $5'); // INV-22 version-checked
    expect(update[0].params[2]).toBe(SVC_A);
    expect(update[0].params[4]).toBe(3);
    const routing = JSON.parse(update[0].params[3] as string) as {
      routing: { ruleId: string; serviceId: string; traceId: string };
    };
    expect(routing.routing).toMatchObject({ ruleId: RULE_ID, serviceId: SVC_A, traceId: TRACE_ID });

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      action: 'rule.evaluated',
      objectType: 'shipment',
      objectId: SHIPMENT_ID,
    });
  });

  it('re-evaluation while NEEDS_MANUAL_ASSIGNMENT is idempotent and returns to DRAFT', async () => {
    const { pool, svc } = staged(selectedResult(), 'NEEDS_MANUAL_ASSIGNMENT');
    const out = await svc.evaluateForShipment(SHOP_ID, SHIPMENT_ID);
    expect(out.evaluated).toBe(true);
    const update = pool.matching(/UPDATE shipment/);
    expect(update[0].sql).toContain("booking_state = 'DRAFT'");
    expect(update[0].sql).toContain('manual_assignment_reason = NULL');
  });
});

describe('evaluateForShipment — NEEDS_MANUAL_ASSIGNMENT outcomes (§3.2, §3.30)', () => {
  for (const reason of [
    'HELD_BY_RULE',
    'CHAIN_EXHAUSTED',
    'NO_SERVICEABLE_CANDIDATE',
    'NO_RULE_AND_NO_DEFAULT_CHAIN',
  ] as const) {
    it(`writes booking_state + manual_assignment_reason = ${reason}`, async () => {
      const { pool, svc } = staged(manualResult(reason));
      const out = await svc.evaluateForShipment(SHOP_ID, SHIPMENT_ID);
      expect(out.evaluated).toBe(true);
      const update = pool.matching(/UPDATE shipment/);
      expect(update).toHaveLength(1);
      expect(update[0].sql).toContain("booking_state = 'NEEDS_MANUAL_ASSIGNMENT'");
      expect(update[0].params[2]).toBe(reason);
      // The trace is still persisted with per-candidate detail (RV-03).
      expect(pool.matching(/INSERT INTO rule_evaluation_trace/)).toHaveLength(1);
    });
  }
});

describe('evaluateForShipment — guards', () => {
  it('refuses from QUEUED onward (working values immutable, §10.4)', async () => {
    const { pool, svc } = staged(selectedResult(), 'QUEUED');
    const out = await svc.evaluateForShipment(SHOP_ID, SHIPMENT_ID);
    expect(out).toEqual({ evaluated: false, code: 'INVALID_STATE', currentState: 'QUEUED' });
    expect(pool.matching(/INSERT INTO rule_evaluation_trace/)).toHaveLength(0);
    expect(pool.matching(/UPDATE shipment/)).toHaveLength(0);
  });

  it('unknown shipment → SHIPMENT_NOT_FOUND (INV-1 shop scope)', async () => {
    const pool = new FnPool();
    const evaluation = { loadForShipment: vi.fn().mockResolvedValue(null), evaluateLoaded: vi.fn() };
    const svc = new RuleRoutingService(pool.asPool(), evaluation as never, mockAudit() as never);
    const out = await svc.evaluateForShipment(SHOP_ID, SHIPMENT_ID);
    expect(out).toEqual({ evaluated: false, code: 'SHIPMENT_NOT_FOUND' });
  });
});
