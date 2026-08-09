import { describe, expect, it, vi } from 'vitest';
import { NdrBuyerResponseService } from '../../src/modules/ndr/ndr-buyer-response.service';
import type { NdrActionService } from '../../src/modules/ndr/ndr-action.service';
import type { NdrCaseService } from '../../src/modules/ndr/ndr-case.service';
import { tokenHash } from '../../src/common/crypto';
import {
  caseRow,
  FnPool,
  mockAudit,
  NDR_ACTION_ID,
  NDR_CASE_ID,
  RESPONSE_ID,
  SHOP_ID,
  SQL,
  TOKEN_ID,
} from './helpers';

/**
 * ADD-27 buyer self-serve. The core proof (the stated INV-21 exception): an
 * ndr_action exists ONLY when a stored, audited ndr_buyer_response row
 * exists — processResponse builds the action FROM the stored record, never
 * from message delivery.
 */

function mk(pool: FnPool, submitResult: unknown = { submitted: true, ndrActionId: NDR_ACTION_ID }) {
  const audit = mockAudit();
  const cases = {
    getCase: vi.fn().mockResolvedValue(caseRow({ state: 'OPEN' })),
  };
  const actions = {
    submit: vi.fn().mockResolvedValue(submitResult),
  };
  const service = new NdrBuyerResponseService(
    pool.asPool(),
    cases as unknown as NdrCaseService,
    actions as unknown as NdrActionService,
    audit as never,
  );
  return { service, cases, actions, audit };
}

const RAW_TOKEN = 'buyer-token-abc';

describe('response tokens (A1-07 pattern)', () => {
  it('issue stores only the token hash; resolve returns the token scope', async () => {
    const pool = new FnPool();
    pool.on(/INSERT INTO ndr_response_token/, [{ token_id: TOKEN_ID }]);
    pool.on(SQL.resolveToken, [
      { token_id: TOKEN_ID, shop_id: SHOP_ID, ndr_case_id: NDR_CASE_ID },
    ]);
    const { service } = mk(pool);

    const issued = await service.issueResponseToken(SHOP_ID, NDR_CASE_ID);
    expect(issued.token).toBeTruthy();
    // At rest: hashed, never raw (§5.7).
    expect(pool.matching(/INSERT INTO ndr_response_token/)[0].params[2]).not.toBe(issued.token);

    const resolved = await service.resolveToken(RAW_TOKEN);
    expect(resolved).toEqual({ tokenId: TOKEN_ID, shopId: SHOP_ID, ndrCaseId: NDR_CASE_ID });
    expect(pool.matching(SQL.resolveToken)[0].params[0]).toBe(tokenHash(RAW_TOKEN));
  });

  it('unknown or revoked tokens resolve to null', async () => {
    const pool = new FnPool(); // no handler → no rows
    const { service } = mk(pool);
    expect(await service.resolveToken('nope')).toBeNull();
  });
});

describe('processResponse — the INV-21 exception, proven', () => {
  it('creates the action FROM the stored response row (system actor)', async () => {
    const pool = new FnPool();
    pool.on(SQL.getResponse, [
      {
        response_id: RESPONSE_ID,
        shop_id: SHOP_ID,
        ndr_case_id: NDR_CASE_ID,
        response_type: 'CORRECT_ADDRESS',
        payload: { addressLines: ['42 Residency Road'], phone: '9876543210' },
        ndr_action_id: null,
      },
    ]);
    const { service, actions } = mk(pool);

    const outcome = await service.processResponse(RESPONSE_ID);

    expect(outcome.actionCreated).toBe(true);
    expect(outcome.ndrActionId).toBe(NDR_ACTION_ID);
    expect(actions.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: SHOP_ID,
        ndrCaseId: NDR_CASE_ID,
        action: 'UPDATE_ADDRESS_AND_REATTEMPT',
        actorMemberId: null, // system actor — buyer-driven
        payload: expect.objectContaining({
          source: 'BUYER_RESPONSE',
          responseId: RESPONSE_ID,
          addressLines: ['42 Residency Road'],
        }),
      }),
    );
    // The stored response is linked to the action it drove.
    expect(pool.matching(SQL.linkResponseAction)[0].params).toEqual([RESPONSE_ID, NDR_ACTION_ID]);
  });

  it('NO stored response row → NO action (message delivery alone drives nothing)', async () => {
    const pool = new FnPool(); // getResponse returns no row
    const { service, actions } = mk(pool);

    await expect(service.processResponse(RESPONSE_ID)).rejects.toThrow(/not found/);
    expect(actions.submit).not.toHaveBeenCalled();
  });

  it.each([
    ['CONFIRM_ADDRESS', 'REATTEMPT'],
    ['CHOOSE_REATTEMPT_DATE', 'REATTEMPT'],
    ['CORRECT_ADDRESS', 'UPDATE_ADDRESS_AND_REATTEMPT'],
  ] as const)('%s maps to %s', async (responseType, action) => {
    const pool = new FnPool();
    pool.on(SQL.getResponse, [
      {
        response_id: RESPONSE_ID,
        shop_id: SHOP_ID,
        ndr_case_id: NDR_CASE_ID,
        response_type: responseType,
        payload: {},
        ndr_action_id: null,
      },
    ]);
    const { service, actions } = mk(pool);

    await service.processResponse(RESPONSE_ID);
    expect(actions.submit).toHaveBeenCalledWith(expect.objectContaining({ action }));
  });

  it('COD_TO_PREPAID: NO ndr_action (§3.10 has none) — recorded and flagged for the payment-link flow', async () => {
    const pool = new FnPool();
    pool.on(SQL.getResponse, [
      {
        response_id: RESPONSE_ID,
        shop_id: SHOP_ID,
        ndr_case_id: NDR_CASE_ID,
        response_type: 'COD_TO_PREPAID',
        payload: {},
        ndr_action_id: null,
      },
    ]);
    const { service, actions } = mk(pool);

    const outcome = await service.processResponse(RESPONSE_ID);

    expect(outcome.actionCreated).toBe(false);
    expect(outcome.paymentLinkPending).toBe(true);
    expect(actions.submit).not.toHaveBeenCalled();
    expect(pool.matching(SQL.flagPaymentLink)).toHaveLength(1);
  });

  it('idempotent: an already-linked response is not re-processed', async () => {
    const pool = new FnPool();
    pool.on(SQL.getResponse, [
      {
        response_id: RESPONSE_ID,
        shop_id: SHOP_ID,
        ndr_case_id: NDR_CASE_ID,
        response_type: 'CONFIRM_ADDRESS',
        payload: {},
        ndr_action_id: NDR_ACTION_ID,
      },
    ]);
    const { service, actions } = mk(pool);

    const outcome = await service.processResponse(RESPONSE_ID);

    expect(outcome.actionCreated).toBe(false);
    expect(actions.submit).not.toHaveBeenCalled();
  });

  it('a response on a non-OPEN case is stored but drives no action (machine F)', async () => {
    const pool = new FnPool();
    pool.on(SQL.getResponse, [
      {
        response_id: RESPONSE_ID,
        shop_id: SHOP_ID,
        ndr_case_id: NDR_CASE_ID,
        response_type: 'CONFIRM_ADDRESS',
        payload: {},
        ndr_action_id: null,
      },
    ]);
    const { service, cases, actions } = mk(pool);
    (cases.getCase as ReturnType<typeof vi.fn>).mockResolvedValue(caseRow({ state: 'RTO_REQUESTED' }));

    const outcome = await service.processResponse(RESPONSE_ID);

    expect(outcome.actionCreated).toBe(false);
    expect(actions.submit).not.toHaveBeenCalled();
  });
});

describe('recordAndProcess — the tokenized entry point', () => {
  it('stores the response FIRST, then processes from the stored row', async () => {
    const pool = new FnPool();
    pool.on(SQL.resolveToken, [
      { token_id: TOKEN_ID, shop_id: SHOP_ID, ndr_case_id: NDR_CASE_ID },
    ]);
    pool.on(SQL.insertResponse, [{ response_id: RESPONSE_ID }]);
    pool.on(SQL.getResponse, [
      {
        response_id: RESPONSE_ID,
        shop_id: SHOP_ID,
        ndr_case_id: NDR_CASE_ID,
        response_type: 'CONFIRM_ADDRESS',
        payload: {},
        ndr_action_id: null,
      },
    ]);
    const { service, actions, audit } = mk(pool);

    const outcome = await service.recordAndProcess({
      token: RAW_TOKEN,
      responseType: 'CONFIRM_ADDRESS',
    });

    expect(outcome?.actionCreated).toBe(true);
    expect(actions.submit).toHaveBeenCalled();
    // Insert precedes processing; the response write is audited (§12).
    expect(audit.entries[0].action).toBe('ndr_buyer_response.record');
    expect(pool.matching(SQL.insertResponse)).toHaveLength(1);
  });

  it('an invalid token records nothing', async () => {
    const pool = new FnPool();
    const { service, actions } = mk(pool);

    const outcome = await service.recordAndProcess({
      token: 'bad',
      responseType: 'CONFIRM_ADDRESS',
    });

    expect(outcome).toBeNull();
    expect(pool.matching(SQL.insertResponse)).toEqual([]);
    expect(actions.submit).not.toHaveBeenCalled();
  });
});
