import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AuthenticatedRequest,
  SessionGuard,
} from '../../auth/session.guard';
import { RolesGuard } from '../team/rbac/roles.guard';
import { RequiresPermission } from '../team/rbac/requires-permission.decorator';
import { InAppService } from './in-app.service';
import { NotificationSettingsService } from './notification-settings.service';

/**
 * Merchant-facing endpoints: the in-app inbox (any authenticated member sees
 * only their own rows — INV-1 + member scoping) and the S-45 per-event
 * toggles (Operator+ per §10.2 'settings.ndr_notifications.edit').
 */
@Controller('notifications')
@UseGuards(SessionGuard, RolesGuard)
export class NotificationsController {
  constructor(
    private readonly inApp: InAppService,
    private readonly settings: NotificationSettingsService,
  ) {}

  @Get('in-app')
  async list(@Req() req: AuthenticatedRequest) {
    const items = await this.inApp.listInApp(
      req.session.shopId,
      req.session.memberId,
    );
    return { ok: true, items };
  }

  @Post('in-app/:messageId/read')
  async markRead(
    @Req() req: AuthenticatedRequest,
    @Param('messageId') messageId: string,
  ) {
    const done = await this.inApp.markRead(
      req.session.shopId,
      req.session.memberId,
      messageId,
    );
    if (!done) throw new NotFoundException('notification not found');
    return { ok: true };
  }

  /** S-45: read the shop's per-event toggles (absent key = default ON). */
  @Get('settings/toggles')
  async getToggles(@Req() req: AuthenticatedRequest) {
    const toggles = await this.settings.getEventToggles(req.session.shopId);
    return { ok: true, toggles };
  }

  /** S-45 / ADD-25: set one event toggle or channel-selection key. */
  @Put('settings/toggles')
  @RequiresPermission('settings.ndr_notifications.edit')
  async putToggle(
    @Req() req: AuthenticatedRequest,
    @Body() body: { event?: string; enabled?: boolean },
  ) {
    if (typeof body?.event !== 'string' || typeof body?.enabled !== 'boolean') {
      return { ok: false, error: 'event (string) and enabled (boolean) required' };
    }
    await this.settings.setEventToggle(
      req.session.shopId,
      body.event,
      body.enabled,
    );
    return { ok: true };
  }
}
