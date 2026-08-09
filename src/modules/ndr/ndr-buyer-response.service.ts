import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { randomToken, tokenHash } from '../../common/crypto';
import { NdrActionService, NdrSubmitResult } from './ndr-action.service';
import { NdrCaseService } from './ndr-case.service';
import {
  NdrAction,
  NdrBuyerResponseRow,
  NdrBuyerResponseType,
} from './ndr.types';

export interface ResolvedResponseToken {
  tokenId: string;
  shopId: string;
  ndrCaseId: string;
}

export interface ProcessOutcome {
  responseId: string;
  /** True only when an ndr_action row was created FROM the stored response. */
  actionCreated: boolean;
  ndrActionId: string | null;
  /** COD_TO_PREPAID: no §3.10 action exists — flagged for the payment-link
   *  flow instead. */
  paymentLinkPending: boolean;
  submit: NdrSubmitResult | null;
}

/**
 * ADD-27 NDR buyer self-serve. The tokenized buyer link lets the buyer
 * confirm the address, correct it, pick a reattempt date, or convert COD to
 * prepaid; the stored response drives the corresponding §3.10 NDR action
 * automatically through NdrActionService.
 *
 * STATED INV-21 EXCEPTION (ADD-27): a buyer response DOES drive a business
 * action here — but the action is created FROM the stored, audited
 * ndr_buyer_response record, never from message delivery success. No action
 * exists unless a stored response row exists; processResponse reads the row
 * back and builds the action from it.
 */
@Injectable()
export class NdrBuyerResponseService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly cases: NdrCaseService,
    private readonly actions: NdrActionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Issue a single-purpose response token for a case (hashed at rest, like
   * §9.16 track tokens — A1-07). The notification layer (ADD-26) builds the
   * buyer link from the raw token; it is never stored raw.
   */
  async issueResponseToken(
    shopId: string,
    ndrCaseId: string,
  ): Promise<{ tokenId: string; token: string }> {
    const token = randomToken(32); // 256-bit ≥ the required 128
    const res = await this.pool.query<{ token_id: string }>(
      `INSERT INTO ndr_response_token (shop_id, ndr_case_id, token_hash)
       VALUES ($1, $2, $3)
       RETURNING token_id`,
      [shopId, ndrCaseId, tokenHash(token)],
    );
    return { tokenId: res.rows[0].token_id, token };
  }

  /** Possession of the link is the authorization (A1-07); revoked/unknown → null. */
  async resolveToken(token: string): Promise<ResolvedResponseToken | null> {
    const res = await this.pool.query<{
      token_id: string;
      shop_id: string;
      ndr_case_id: string;
    }>(
      `SELECT token_id, shop_id, ndr_case_id
         FROM ndr_response_token
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash(token)],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { tokenId: row.token_id, shopId: row.shop_id, ndrCaseId: row.ndr_case_id };
  }

  /**
   * Record a buyer response from a tokenized link, then process it. The
   * response row is written FIRST; the action derives from the stored row
   * (the INV-21 exception above).
   */
  async recordAndProcess(input: {
    token: string;
    responseType: NdrBuyerResponseType;
    payload?: Record<string, unknown>;
  }): Promise<ProcessOutcome | null> {
    const resolved = await this.resolveToken(input.token);
    if (!resolved) return null;
    const res = await this.pool.query<{ response_id: string }>(
      `INSERT INTO ndr_buyer_response (shop_id, ndr_case_id, response_type, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING response_id`,
      [
        resolved.shopId,
        resolved.ndrCaseId,
        input.responseType,
        JSON.stringify(input.payload ?? {}),
      ],
    );
    await this.audit.record({
      shopId: resolved.shopId,
      actorKind: 'SYSTEM',
      action: 'ndr_buyer_response.record',
      objectType: 'ndr_case',
      objectId: resolved.ndrCaseId,
      after: { response_id: res.rows[0].response_id, response_type: input.responseType },
    });
    return this.processResponse(res.rows[0].response_id);
  }

  /**
   * Consume a stored response record and drive the §3.10 action:
   *  - CONFIRM_ADDRESS        → REATTEMPT
   *  - CORRECT_ADDRESS        → UPDATE_ADDRESS_AND_REATTEMPT (corrected address)
   *  - CHOOSE_REATTEMPT_DATE  → REATTEMPT (chosen date)
   *  - COD_TO_PREPAID         → NO ndr_action (§3.10 has none); the response
   *    is recorded and flagged for the payment-link flow.
   * Idempotent: a response that already carries ndr_action_id is not
   * re-processed. System actor (actor_member_id NULL per migration 0014).
   */
  async processResponse(responseId: string): Promise<ProcessOutcome> {
    const res = await this.pool.query<NdrBuyerResponseRow>(
      `SELECT * FROM ndr_buyer_response WHERE response_id = $1`,
      [responseId],
    );
    const response = res.rows[0];
    if (!response) throw new Error(`ndr_buyer_response ${responseId} not found`);

    if (response.ndr_action_id) {
      return {
        responseId,
        actionCreated: false,
        ndrActionId: response.ndr_action_id,
        paymentLinkPending: false,
        submit: null,
      };
    }

    if (response.response_type === 'COD_TO_PREPAID') {
      // §3.10 NDR_ACTION has no COD-conversion value — record the response
      // and mark it for the payment-link flow; do NOT invent an ndr action.
      await this.pool.query(
        `UPDATE ndr_buyer_response
            SET payload = payload || '{"paymentLinkPending": true}'::jsonb
          WHERE response_id = $1`,
        [responseId],
      );
      return {
        responseId,
        actionCreated: false,
        ndrActionId: null,
        paymentLinkPending: true,
        submit: null,
      };
    }

    // The case must be OPEN for an action (machine F); a response arriving
    // after RTO_REQUESTED/CLOSED is stored and audited but drives nothing.
    const caseRow = await this.cases.getCase(response.shop_id, response.ndr_case_id);
    if (caseRow.state !== 'OPEN') {
      return {
        responseId,
        actionCreated: false,
        ndrActionId: null,
        paymentLinkPending: false,
        submit: null,
      };
    }

    const action: NdrAction =
      response.response_type === 'CORRECT_ADDRESS'
        ? 'UPDATE_ADDRESS_AND_REATTEMPT'
        : 'REATTEMPT';
    const payload: Record<string, unknown> = {
      source: 'BUYER_RESPONSE', // ADD-27
      responseId: response.response_id,
      ...response.payload,
    };

    const submit = await this.actions.submit({
      shopId: response.shop_id,
      ndrCaseId: response.ndr_case_id,
      action,
      payload,
      actorMemberId: null, // system actor — buyer-driven, no member
    });

    const ndrActionId = submit.submitted ? submit.ndrActionId : null;
    if (ndrActionId) {
      await this.pool.query(
        `UPDATE ndr_buyer_response SET ndr_action_id = $2 WHERE response_id = $1`,
        [responseId, ndrActionId],
      );
    }
    return {
      responseId,
      actionCreated: ndrActionId !== null,
      ndrActionId,
      paymentLinkPending: false,
      submit,
    };
  }

  /** Sweep helper: stored responses not yet processed (retry path). */
  async processPending(shopId: string, limit = 100): Promise<ProcessOutcome[]> {
    const res = await this.pool.query<{ response_id: string }>(
      `SELECT response_id FROM ndr_buyer_response
        WHERE shop_id = $1 AND ndr_action_id IS NULL
          AND response_type <> 'COD_TO_PREPAID'
          AND NOT (payload ? 'paymentLinkPending')
        ORDER BY created_at LIMIT $2`,
      [shopId, limit],
    );
    const out: ProcessOutcome[] = [];
    for (const row of res.rows) out.push(await this.processResponse(row.response_id));
    return out;
  }
}
