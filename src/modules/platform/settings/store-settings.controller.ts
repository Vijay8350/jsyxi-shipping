import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AuthenticatedRequest,
  SessionGuard,
} from '../../../auth/session.guard';
import {
  StoreSettingsPatch,
  StoreSettingsService,
  StoreSettingsView,
} from './store-settings.service';

/**
 * Store general settings endpoints (§7.1, §9.20).
 * S-1…S-7 are Owner-only to change (§10.2) — a local role check here; the
 * team module's RBAC guard is not this module's concern.
 */
@Controller('store-settings')
@UseGuards(SessionGuard)
export class StoreSettingsController {
  constructor(private readonly settings: StoreSettingsService) {}

  @Get()
  get(@Req() req: AuthenticatedRequest): Promise<StoreSettingsView> {
    return this.settings.getOrCreate(req.session.shopId);
  }

  @Patch()
  update(
    @Req() req: AuthenticatedRequest,
    @Body() body: StoreSettingsPatch,
  ): Promise<StoreSettingsView> {
    if (req.session.role !== 'OWNER') {
      throw new ForbiddenException('store settings are Owner-only (§10.2)');
    }
    return this.settings.update(req.session.shopId, body, {
      memberId: req.session.memberId,
    });
  }
}
