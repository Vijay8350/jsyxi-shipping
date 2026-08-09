import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { NdrBuyerResponseService } from './ndr-buyer-response.service';
import { NdrCaseService } from './ndr-case.service';
import { NdrBuyerResponseType } from './ndr.types';

const RESPONSE_TYPES: readonly NdrBuyerResponseType[] = [
  'CONFIRM_ADDRESS',
  'CORRECT_ADDRESS',
  'CHOOSE_REATTEMPT_DATE',
  'COD_TO_PREPAID',
];

interface RespondBody {
  responseType?: NdrBuyerResponseType;
  payload?: Record<string, unknown>;
}

/**
 * ADD-27 buyer self-serve endpoints — NO session, by design: possession of
 * the tokenized link is the authorization (A1-07, same pattern as the §9.16
 * track page). The failure surface is uniform: an invalid or revoked token
 * is a 404 with one wording. No PII beyond what the buyer already knows is
 * exposed, and nothing is logged raw (§5.7 control 4).
 */
@Controller('ndr/public')
export class NdrPublicController {
  constructor(
    private readonly responses: NdrBuyerResponseService,
    private readonly cases: NdrCaseService,
  ) {}

  /** The case summary the buyer page renders. */
  @Get('r/:token')
  async summary(@Param('token') token: string) {
    const resolved = await this.responses.resolveToken(token);
    if (!resolved) throw new NotFoundException('This link is no longer valid.');
    const caseRow = await this.cases.getCase(resolved.shopId, resolved.ndrCaseId);
    return {
      state: caseRow.state,
      attemptCount: caseRow.attempt_count,
      reason: caseRow.reason_code,
      lastAttemptAt: caseRow.last_ndr_at,
      responseTypes: RESPONSE_TYPES,
    };
  }

  /**
   * The buyer response: stored first, then the §3.10 action is created FROM
   * the stored record (the stated INV-21 exception — see
   * NdrBuyerResponseService).
   */
  @Post('r/:token/respond')
  @HttpCode(200)
  async respond(@Param('token') token: string, @Body() body: RespondBody) {
    if (!body?.responseType || !RESPONSE_TYPES.includes(body.responseType)) {
      throw new UnprocessableEntityException({ ok: false, code: 'INVALID_RESPONSE_TYPE' });
    }
    const outcome = await this.responses.recordAndProcess({
      token,
      responseType: body.responseType,
      payload: body.payload,
    });
    if (!outcome) throw new NotFoundException('This link is no longer valid.');
    return {
      ok: true,
      actionCreated: outcome.actionCreated,
      paymentLinkPending: outcome.paymentLinkPending,
    };
  }
}
