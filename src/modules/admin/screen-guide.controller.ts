import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../../auth/session.guard';
import { AdminGuard } from './admin.guard';
import { AdminRoles } from './admin-roles.decorator';
import { ScreenGuideService } from './screen-guide.service';
import { isValidSurfaceKey, UpsertScreenGuideDto } from './screen-guide.dto';
import { AdminAuthenticatedRequest } from './admin.types';

/**
 * ADD-33 screen guides. Two surfaces:
 *   - admin CRUD (PLATFORM_ADMIN, §10.3) under /admin/screen-guides;
 *   - the merchant-facing per-screen read the app shell calls, under
 *     /screen-guides/:surfaceKey behind the merchant SessionGuard.
 * screen_guide is [global] reference data — the merchant read needs no shop
 * scoping, but it does need an authenticated merchant session.
 */
@Controller('admin/screen-guides')
@UseGuards(AdminGuard)
export class ScreenGuideAdminController {
  constructor(private readonly guides: ScreenGuideService) {}

  @Get()
  @AdminRoles('PLATFORM_ADMIN', 'SUPPORT_AGENT')
  async list() {
    return this.guides.listGuides();
  }

  @Put(':surfaceKey')
  @AdminRoles('PLATFORM_ADMIN')
  async upsert(
    @Req() req: AdminAuthenticatedRequest,
    @Param('surfaceKey') surfaceKey: string,
    @Body() dto: UpsertScreenGuideDto,
  ) {
    if (!isValidSurfaceKey(surfaceKey)) throw new BadRequestException('invalid surface key');
    return this.guides.upsertGuide(req.admin, surfaceKey, dto);
  }

  @Delete(':surfaceKey')
  @HttpCode(204)
  @AdminRoles('PLATFORM_ADMIN')
  async remove(@Req() req: AdminAuthenticatedRequest, @Param('surfaceKey') surfaceKey: string) {
    await this.guides.deleteGuide(req.admin, surfaceKey);
  }
}

@Controller('screen-guides')
export class ScreenGuideMerchantController {
  constructor(private readonly guides: ScreenGuideService) {}

  /** ADD-33: the app shell calls this per screen; the help icon reads it. */
  @Get(':surfaceKey')
  @UseGuards(SessionGuard)
  async getForMerchant(@Param('surfaceKey') surfaceKey: string) {
    if (!isValidSurfaceKey(surfaceKey)) throw new BadRequestException('invalid surface key');
    return this.guides.getGuide(surfaceKey);
  }
}
