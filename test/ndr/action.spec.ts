import { describe, expect, it } from 'vitest';
import { NdrActionService } from '../../src/modules/ndr/ndr-action.service';
import { NdrCaseService } from '../../src/modules/ndr/ndr-case.service';
import { UnsupportedCapabilityError } from '../../src/modules/courier-framework/adapter.types';
import {
  AWB,
  caseRow,
  FnPool,
  MEMBER_ID,
  mockAudit,
  NDR_ACTION_ID,
  NDR_CASE_ID,
  shipmentRow,
  SHOP_ID,
  SQL,
  stubAdapterCaller,
} from './helpers';

/**
 * NdrActionService.submit (§9.8.1, machine F §3.10): adapter-accepted
 * actions traverse OPEN → ACTION_SUBMITTED → REATTEMPT_SCHEDULED /
 * RTO_REQUESTED; provider rejection exercises the reverse row back to OPEN;
 * the A1-03 capability gate refuses with the documented manual fallback and
 * NEVER calls the adapter.
 */

function mk(pool: FnPool, caller: ReturnType<typeof stubAdapterCaller>) {
  const audit = mockAudit();
  const cases = new NdrCaseService(pool.asPool(), audit as never);
  const service = new NdrActionService(pool.asPool(), cases, caller as never, audit as never);
  return { service, audit };
}

/** Happy-path pool: OPEN case, shipment, supported capability, all writes. */
function happyPool() {
  const pool = new FnPool();
  pool.on(SQL.getCase, [caseRow({ state: 'OPEN' })]);
  pool.on(SQL.loadShipment, [shipmentRow()]);
  pool.on(SQL.capability, [{ supported: true, manual_fallback_note: null }]);
  pool.on(SQL.insertAction, [{ ndr_action_id: NDR_ACTION_ID }]);
  return pool;
}

const BASE = {
  shopId: SHOP_ID,
  ndrCaseId: NDR_CASE_ID,
  actorMemberId: MEMBER_ID,
};

describe('submit — accepted paths (machine F)', () => {
  it('REATTEMPT: OPEN → ACTION_SUBMITTED → REATTEMPT_SCHEDULED, action row persisted with ack', async () => {
    const pool = happyPool();
    let updateN = 0;
    pool.onFn(SQL.updateCase, () => {
      updateN += 1;
      return {
        rows: [caseRow({ state: updateN === 1 ? 'ACTION_SUBMITTED' : 'REATTEMPT_SCHEDULED', version: 1 + updateN })],
        rowCount: 1,
      };
    });
    const caller = stubAdapterCaller({ accepted: true, providerAck: 'rw-42' });
    const { service } = mk(pool, caller);

    const result = await service.submit({ ...BASE, action: 'REATTEMPT' });

    expect(result).toMatchObject({
      submitted: true,
      ndrActionId: NDR_ACTION_ID,
      caseState: 'REATTEMPT_SCHEDULED',
      providerAck: 'rw-42',
    });
    // The adapter saw the shipment's AWB and the action.
    expect(caller.calls[0]).toMatchObject({ method: 'ndrAction', awb: AWB, action: 'REATTEMPT' });
    // The action row carries the provider ack + result (§3.10 ndr_action).
    const action = pool.matching(SQL.insertAction)[0];
    expect(action.params[4]).toBe('rw-42');
    expect(action.params[5]).toBe('ACCEPTED');
  });

  it('UPDATE_ADDRESS_AND_REATTEMPT → REATTEMPT_SCHEDULED', async () => {
    const pool = happyPool();
    let updateN = 0;
    pool.onFn(SQL.updateCase, () => {
      updateN += 1;
      return {
        rows: [caseRow({ state: updateN === 1 ? 'ACTION_SUBMITTED' : 'REATTEMPT_SCHEDULED', version: 1 + updateN })],
        rowCount: 1,
      };
    });
    const caller = stubAdapterCaller({ accepted: true });
    const { service } = mk(pool, caller);

    const result = await service.submit({
      ...BASE,
      action: 'UPDATE_ADDRESS_AND_REATTEMPT',
      payload: { addressLines: ['12 MG Road'], phone: '9876543210' },
    });

    expect(result.submitted && result.caseState).toBe('REATTEMPT_SCHEDULED');
    expect(pool.matching(SQL.insertAction)[0].params[1]).toBe('UPDATE_ADDRESS_AND_REATTEMPT');
  });

  it('INITIATE_RTO: OPEN → ACTION_SUBMITTED → RTO_REQUESTED', async () => {
    const pool = happyPool();
    let updateN = 0;
    pool.onFn(SQL.updateCase, () => {
      updateN += 1;
      return {
        rows: [caseRow({ state: updateN === 1 ? 'ACTION_SUBMITTED' : 'RTO_REQUESTED', version: 1 + updateN })],
        rowCount: 1,
      };
    });
    const caller = stubAdapterCaller({ accepted: true });
    const { service } = mk(pool, caller);

    const result = await service.submit({ ...BASE, action: 'INITIATE_RTO' });
    expect(result.submitted && result.caseState).toBe('RTO_REQUESTED');
  });
});

describe('submit — reverse row: provider rejection returns the case to OPEN', () => {
  it('accepted=false persists the action as REJECTED_BY_PROVIDER and ends OPEN', async () => {
    const pool = happyPool();
    let updateN = 0;
    pool.onFn(SQL.updateCase, () => {
      updateN += 1;
      // ACTION_SUBMITTED, then the reverse row back to OPEN.
      return {
        rows: [caseRow({ state: updateN === 1 ? 'ACTION_SUBMITTED' : 'OPEN', version: 1 + updateN })],
        rowCount: 1,
      };
    });
    const caller = stubAdapterCaller({ accepted: false, providerAck: 'customer unreachable window' });
    const { service, audit } = mk(pool, caller);

    const result = await service.submit({ ...BASE, action: 'REATTEMPT' });

    expect(result).toMatchObject({ submitted: false, code: 'PROVIDER_REJECTED' });
    expect(pool.matching(SQL.insertAction)[0].params[5]).toBe('REJECTED_BY_PROVIDER');
    const actions = audit.entries.map((e) => e.action);
    expect(actions).toContain('ndr_case.action_submitted');
    expect(actions).toContain('ndr_case.provider_rejected');
  });
});

describe('submit — A1-03 capability gate (never a silent no-op)', () => {
  it('courier_capability supported=false refuses with the manual fallback; adapter NOT called', async () => {
    const pool = new FnPool();
    pool.on(SQL.getCase, [caseRow({ state: 'OPEN' })]);
    pool.on(SQL.loadShipment, [shipmentRow()]);
    pool.on(SQL.capability, [
      { supported: false, manual_fallback_note: 'Raise an NDR ticket in the courier panel' },
    ]);
    const caller = stubAdapterCaller({ accepted: true });
    const { service } = mk(pool, caller);

    const result = await service.submit({ ...BASE, action: 'REATTEMPT' });

    expect(result).toEqual({
      submitted: false,
      code: 'CAPABILITY_UNSUPPORTED',
      manualFallbackNote: 'Raise an NDR ticket in the courier panel',
    });
    expect(caller.calls).toEqual([]); // no silent no-op, no provider call
    expect(pool.matching(SQL.insertAction)).toEqual([]);
  });

  it('adapter-thrown UnsupportedCapabilityError also refuses with the fallback', async () => {
    const pool = happyPool();
    const caller = stubAdapterCaller({
      throwError: new UnsupportedCapabilityError('DL', 'ndrAction', 'Use the Delhivery panel'),
    });
    const { service } = mk(pool, caller);

    const result = await service.submit({ ...BASE, action: 'REATTEMPT' });

    expect(result).toEqual({
      submitted: false,
      code: 'CAPABILITY_UNSUPPORTED',
      manualFallbackNote: 'Use the Delhivery panel',
    });
    expect(pool.matching(SQL.updateCase)).toEqual([]); // case state untouched
  });
});

describe('submit — guards', () => {
  it('an action requires an OPEN case (machine F)', async () => {
    const pool = new FnPool();
    pool.on(SQL.getCase, [caseRow({ state: 'REATTEMPT_SCHEDULED' })]);
    const caller = stubAdapterCaller({ accepted: true });
    const { service } = mk(pool, caller);

    const result = await service.submit({ ...BASE, action: 'REATTEMPT' });

    expect(result).toMatchObject({ submitted: false, code: 'INVALID_CASE_STATE' });
    expect(caller.calls).toEqual([]);
  });

  it('a transport error persists the action row with the error result, case stays OPEN', async () => {
    const pool = happyPool();
    const caller = stubAdapterCaller({ throwError: new Error('socket timeout') });
    const { service } = mk(pool, caller);

    const result = await service.submit({ ...BASE, action: 'REATTEMPT' });

    expect(result).toMatchObject({ submitted: false, code: 'TRANSPORT_ERROR' });
    expect(pool.matching(SQL.insertAction)[0].params[5]).toContain('TRANSPORT_ERROR');
    expect(pool.matching(SQL.updateCase)).toEqual([]);
  });
});

describe('submitBulk (§9.8.1 + ADD-36)', () => {
  it('per-case partial results — one success, one invalid-state failure', async () => {
    const pool = new FnPool();
    pool.on(SQL.loadShipment, [shipmentRow()]);
    pool.on(SQL.capability, [{ supported: true, manual_fallback_note: null }]);
    pool.on(SQL.insertAction, [{ ndr_action_id: NDR_ACTION_ID }]);
    const secondCase = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    let getCaseN = 0;
    pool.onFn(SQL.getCase, () => {
      getCaseN += 1;
      return {
        rows: [caseRow({ state: getCaseN === 1 ? 'OPEN' : 'CLOSED', ndr_case_id: getCaseN === 1 ? NDR_CASE_ID : secondCase })],
        rowCount: 1,
      };
    });
    let updateN = 0;
    pool.onFn(SQL.updateCase, () => {
      updateN += 1;
      return {
        rows: [caseRow({ state: updateN === 1 ? 'ACTION_SUBMITTED' : 'REATTEMPT_SCHEDULED', version: 1 + updateN })],
        rowCount: 1,
      };
    });
    const caller = stubAdapterCaller({ accepted: true });
    const { service } = mk(pool, caller);

    const results = await service.submitBulk({
      shopId: SHOP_ID,
      ndrCaseIds: [NDR_CASE_ID, secondCase],
      action: 'REATTEMPT',
      actorMemberId: MEMBER_ID,
    });

    expect(results).toHaveLength(2);
    expect(results[0].result.submitted).toBe(true);
    expect(results[1].result).toMatchObject({ submitted: false, code: 'INVALID_CASE_STATE' });
    expect(caller.calls).toHaveLength(1); // only the OPEN case hit the adapter
  });
});
