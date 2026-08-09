import { describe, expect, it } from 'vitest';
import { NdrCaseService } from '../../src/modules/ndr/ndr-case.service';
import {
  AUTO_RTO_WARN_HOURS,
  normalizeNdrReason,
} from '../../src/modules/ndr/ndr.types';
import {
  ATTEMPT_2_AT,
  caseRow,
  FIRST_NDR_AT,
  FnPool,
  mockAudit,
  SHIPMENT_ID,
  SHOP_ID,
  SQL,
} from './helpers';

/**
 * Machine F (§3.10) case lifecycle: every transition row, both reverse rows,
 * the OTHER reason fallback (RV-14/INV-20), S-44 warn-at computation and the
 * INV-22-style version retry.
 */

function mk(pool: FnPool) {
  const audit = mockAudit();
  const service = new NdrCaseService(pool.asPool(), audit as never);
  return { service, audit };
}

function attempt(service: NdrCaseService, occurredAt = FIRST_NDR_AT) {
  return service.handleUndeliveredAttempt({
    shopId: SHOP_ID,
    shipmentId: SHIPMENT_ID,
    occurredAt,
  });
}

describe('normalizeNdrReason (§3.10, RV-14/INV-20)', () => {
  it.each([
    ['Customer refused to accept', 'CUSTOMER_REFUSED'],
    ['consignee not reachable, phone switched off', 'UNCONTACTABLE'],
    ['incomplete address, landmark missing', 'ADDRESS_ISSUE'],
    ['COD amount not ready', 'COD_NOT_READY'],
    ['weather delay at facility', 'OTHER'],
    [null, 'OTHER'],
    ['', 'OTHER'],
  ])('%s → %s', (text, expected) => {
    expect(normalizeNdrReason(text)).toBe(expected);
  });
});

describe('machine F: — → OPEN (first UNDELIVERED_ATTEMPT, no open case)', () => {
  it('opens with attempt_count 1, normalized reason, S-44 warn at first_ndr_at + 48h', async () => {
    const pool = new FnPool();
    pool.on(SQL.attemptReason, [{ reason_text: 'Customer refused' }]);
    pool.on(SQL.latestCase, []); // no case at all
    pool.on(SQL.insertCase, [caseRow({ reason_code: 'CUSTOMER_REFUSED' })]);
    const { service, audit } = mk(pool);

    const outcome = await attempt(service);

    expect(outcome.kind).toBe('OPENED');
    const insert = pool.matching(SQL.insertCase)[0];
    expect(insert.params[2]).toBe('CUSTOMER_REFUSED'); // reason_code
    expect(insert.params[3]).toBe(FIRST_NDR_AT); // first/last_ndr_at
    expect(insert.params[4]).toBe(AUTO_RTO_WARN_HOURS); // S-44: 48h (RW-05)
    expect(insert.sql).toContain("($5 || ' hours')::interval");
    expect(audit.entries[0].action).toBe('ndr_case.open');
    expect(audit.entries[0].actorKind).toBe('SYSTEM');
  });

  it('unmappable reason_text opens with OTHER — never discarded (RV-14)', async () => {
    const pool = new FnPool();
    pool.on(SQL.attemptReason, [{ reason_text: 'gate was blue' }]);
    pool.on(SQL.insertCase, [caseRow()]);
    const { service } = mk(pool);

    const outcome = await attempt(service);

    expect(outcome.kind).toBe('OPENED');
    expect(pool.matching(SQL.insertCase)[0].params[2]).toBe('OTHER');
  });
});

describe('machine F: further UNDELIVERED_ATTEMPT', () => {
  it('while OPEN: attempt_count++ and last_ndr_at move, state stays OPEN', async () => {
    const pool = new FnPool();
    pool.on(SQL.attemptReason, [{ reason_text: null }]);
    pool.on(SQL.latestCase, [caseRow({ state: 'OPEN' })]);
    pool.on(SQL.updateCase, [caseRow({ attempt_count: 2, last_ndr_at: ATTEMPT_2_AT })]);
    const { service } = mk(pool);

    const outcome = await attempt(service, ATTEMPT_2_AT);

    expect(outcome.kind).toBe('ATTEMPT_RECORDED');
    expect(outcome.caseRow.attempt_count).toBe(2);
    expect(outcome.caseRow.state).toBe('OPEN');
  });

  it('reverse row: REATTEMPT_SCHEDULED → OPEN with attempt_count++', async () => {
    const pool = new FnPool();
    pool.on(SQL.attemptReason, [{ reason_text: 'no answer' }]);
    pool.on(SQL.latestCase, [caseRow({ state: 'REATTEMPT_SCHEDULED', attempt_count: 1 })]);
    pool.on(SQL.updateCase, [caseRow({ state: 'OPEN', attempt_count: 2, version: 2 })]);
    const { service, audit } = mk(pool);

    const outcome = await attempt(service, ATTEMPT_2_AT);

    expect(outcome.kind).toBe('REOPENED');
    expect(outcome.caseRow.state).toBe('OPEN');
    expect(outcome.caseRow.attempt_count).toBe(2);
    const update = pool.matching(SQL.updateCase)[0];
    expect(update.sql).toContain('attempt_count = attempt_count + 1');
    expect(audit.entries[0].action).toBe('ndr_case.reopen');
  });

  it('while RTO_REQUESTED: attempt recorded, no state change (no machine F row)', async () => {
    const pool = new FnPool();
    pool.on(SQL.attemptReason, [{ reason_text: null }]);
    pool.on(SQL.latestCase, [caseRow({ state: 'RTO_REQUESTED' })]);
    pool.on(SQL.updateCase, [caseRow({ state: 'RTO_REQUESTED', attempt_count: 2 })]);
    const { service } = mk(pool);

    const outcome = await attempt(service, ATTEMPT_2_AT);

    expect(outcome.kind).toBe('ATTEMPT_RECORDED');
    expect(outcome.caseRow.state).toBe('RTO_REQUESTED');
  });

  it('INV-17: a case already CLOSED is never re-opened by a stray attempt', async () => {
    const pool = new FnPool();
    pool.on(SQL.attemptReason, [{ reason_text: null }]);
    pool.on(SQL.latestCase, [caseRow({ state: 'CLOSED' })]);
    const { service } = mk(pool);

    const outcome = await attempt(service, ATTEMPT_2_AT);

    expect(outcome.kind).toBe('IGNORED');
    expect(pool.matching(SQL.insertCase)).toEqual([]);
    expect(pool.matching(SQL.updateCase)).toEqual([]);
  });
});

describe('machine F: ack and terminal transitions', () => {
  it('OPEN → ACTION_SUBMITTED', async () => {
    const pool = new FnPool();
    pool.on(SQL.updateCase, [caseRow({ state: 'ACTION_SUBMITTED', version: 2 })]);
    const { service, audit } = mk(pool);

    const next = await service.markActionSubmitted(caseRow(), {
      kind: 'MEMBER',
      id: 'm-1',
    });

    expect(next.state).toBe('ACTION_SUBMITTED');
    expect(audit.entries[0].action).toBe('ndr_case.action_submitted');
    expect(audit.entries[0].actorKind).toBe('MEMBER');
  });

  it('ACTION_SUBMITTED → REATTEMPT_SCHEDULED (reattempt ack)', async () => {
    const pool = new FnPool();
    pool.on(SQL.updateCase, [caseRow({ state: 'REATTEMPT_SCHEDULED', version: 3 })]);
    const { service } = mk(pool);

    const next = await service.markReattemptScheduled(caseRow({ state: 'ACTION_SUBMITTED', version: 2 }));
    expect(next.state).toBe('REATTEMPT_SCHEDULED');
  });

  it('ACTION_SUBMITTED → RTO_REQUESTED (RTO ack)', async () => {
    const pool = new FnPool();
    pool.on(SQL.updateCase, [caseRow({ state: 'RTO_REQUESTED', version: 3 })]);
    const { service } = mk(pool);

    const next = await service.markRtoRequested(caseRow({ state: 'ACTION_SUBMITTED', version: 2 }));
    expect(next.state).toBe('RTO_REQUESTED');
  });

  it('reverse row: ACTION_SUBMITTED → OPEN on provider rejection', async () => {
    const pool = new FnPool();
    pool.on(SQL.updateCase, [caseRow({ state: 'OPEN', version: 3 })]);
    const { service, audit } = mk(pool);

    const next = await service.returnToOpenOnProviderRejection(
      caseRow({ state: 'ACTION_SUBMITTED', version: 2 }),
    );
    expect(next.state).toBe('OPEN');
    expect(audit.entries[0].action).toBe('ndr_case.provider_rejected');
  });

  it('a transition not in machine F is refused, never merged (§3.10)', async () => {
    const pool = new FnPool();
    const { service } = mk(pool);

    // OPEN → REATTEMPT_SCHEDULED is not a listed transition.
    await expect(service.markReattemptScheduled(caseRow({ state: 'OPEN' }))).rejects.toThrow(
      /not a listed transition/,
    );
    // CLOSED → anything is refused.
    await expect(
      service.markActionSubmitted(caseRow({ state: 'CLOSED' }), { kind: 'SYSTEM', id: null }),
    ).rejects.toThrow(/not a listed transition/);
  });

  it('terminal row: every non-CLOSED state → CLOSED on terminal movement', async () => {
    for (const state of ['OPEN', 'ACTION_SUBMITTED', 'REATTEMPT_SCHEDULED', 'RTO_REQUESTED'] as const) {
      const pool = new FnPool();
      pool.on(SQL.openCase, [caseRow({ state })]);
      pool.on(SQL.updateCase, [caseRow({ state: 'CLOSED', version: 2 })]);
      const { service, audit } = mk(pool);

      const closed = await service.closeOnTerminalMovement({
        shopId: SHOP_ID,
        shipmentId: SHIPMENT_ID,
        movementState: 'RTO_DELIVERED',
        occurredAt: ATTEMPT_2_AT,
      });

      expect(closed?.state).toBe('CLOSED');
      expect(audit.entries[0].action).toBe('ndr_case.close');
    }
  });

  it('non-terminal movement closes nothing', async () => {
    const pool = new FnPool();
    const { service } = mk(pool);
    const closed = await service.closeOnTerminalMovement({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_ID,
      movementState: 'OUT_FOR_DELIVERY',
      occurredAt: ATTEMPT_2_AT,
    });
    expect(closed).toBeNull();
    expect(pool.calls).toEqual([]);
  });

  it('INV-22 pattern: a version mismatch re-reads and re-applies', async () => {
    const pool = new FnPool();
    let updates = 0;
    pool.onFn(SQL.updateCase, () => {
      updates += 1;
      // First update loses the version race; the second wins.
      return updates === 1
        ? { rows: [], rowCount: 0 }
        : { rows: [caseRow({ state: 'ACTION_SUBMITTED', version: 3 })], rowCount: 1 };
    });
    pool.on(SQL.getCase, [caseRow({ version: 2 })]); // the re-read
    const { service } = mk(pool);

    const next = await service.markActionSubmitted(caseRow(), { kind: 'SYSTEM', id: null });

    expect(next.state).toBe('ACTION_SUBMITTED');
    expect(updates).toBe(2);
  });
});
