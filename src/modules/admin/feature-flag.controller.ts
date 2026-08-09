import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Query,
  Req,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { AdminRoles } from './admin-roles.decorator';
import { FeatureFlagService } from './feature-flag.service';
import { UpsertFeatureFlagDto } from './feature-flag.dto';
import { AdminAuthenticatedRequest } from './admin.types';

/** §9.13 feature flags — PLATFORM_ADMIN only (§10.3). */
@Controller('admin/feature-flags')
@UseGuards(AdminGuard)
@AdminRoles('PLATFORM_ADMIN')
export class FeatureFlagController {
  constructor(private readonly flags: FeatureFlagService) {}

  @Get()
  async list(@Query('shopId') shopId?: string) {
    return this.flags.listFlags(shopId);
  }

  @Put()
  async upsert(@Req() req: AdminAuthenticatedRequest, @Body() dto: UpsertFeatureFlagDto) {
    return this.flags.upsertFlag(req.admin, dto);
  }

  @Delete(':flagId')
  @HttpCode(204)
  async remove(@Req() req: AdminAuthenticatedRequest, @Param('flagId') flagId: string) {
    await this.flags.deleteFlag(req.admin, flagId);
  }
}
