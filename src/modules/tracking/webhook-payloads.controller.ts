import { Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { OwnerGuard } from '../courier-framework/owner.guard';
import { WebhookPayloadsService } from './webhook-payloads.service';

/**
 * ADD-18 webhook management endpoints (Owner-only, §10.2 courier account
 * management): the masked last-20-payloads viewer and the merchant-side
 * idempotent replay (distinct from admin DLQ replay, §8.6).
 *
 * Routes extend the existing courier-accounts surface in courier-framework
 * (`GET/POST /courier-accounts/:accountId/webhook*`); this controller owns
 * only the tracking module's two ADD-18 rows.
 */
@Controller('courier-accounts')
@UseGuards(SessionGuard, OwnerGuard)
export class WebhookPayloadsController {
  constructor(private readonly payloads: WebhookPayloadsService) {}

  /** ADD-18: last 20 raw payloads with parse result, masked (INV-18). */
  @Get(':accountId/webhook/payloads')
  async list(@Param('accountId') accountId: string, @Req() req: AuthenticatedRequest) {
    return this.payloads.listPayloads(req.session.shopId, accountId);
  }

  /** ADD-18: replay one payload — idempotent, audited (§12). */
  @Post(':accountId/webhook/payloads/:rawEventId/replay')
  @HttpCode(200)
  async replay(
    @Param('accountId') accountId: string,
    @Param('rawEventId') rawEventId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.payloads.replayPayload({
      shopId: req.session.shopId,
      courierAccountId: accountId,
      rawEventId,
      memberId: req.session.memberId,
    });
  }
}
