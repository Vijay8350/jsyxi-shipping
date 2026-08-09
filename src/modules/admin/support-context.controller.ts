import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { AdminRoles } from './admin-roles.decorator';
import { SupportContextGuard } from './support-context.guard';
import { SupportContextService } from './support-context.service';
import { OpenSupportContextDto } from './support-context.dto';
import {
  AdminAuthenticatedRequest,
  SupportContextRequest,
} from './admin.types';

/**
 * A1-07 / §10.3 support context endpoints (PLATFORM_ADMIN + SUPPORT_AGENT).
 * Guard order matters: AdminGuard establishes identity + role first, then
 * SupportContextGuard enforces the read-only / credential-exclusion rules
 * whenever the request carries a live x-support-context header.
 */
@Controller('admin/support/contexts')
@UseGuards(AdminGuard, SupportContextGuard)
@AdminRoles('PLATFORM_ADMIN', 'SUPPORT_AGENT')
export class SupportContextController {
  constructor(private readonly contexts: SupportContextService) {}

  @Post()
  async open(@Req() req: AdminAuthenticatedRequest, @Body() dto: OpenSupportContextDto) {
    return this.contexts.open(req.admin, dto);
  }

  @Post(':contextId/end')
  @HttpCode(204)
  async end(@Req() req: AdminAuthenticatedRequest, @Param('contextId') contextId: string) {
    await this.contexts.end(req.admin, contextId);
  }

  @Get(':contextId')
  async get(@Param('contextId') contextId: string) {
    const ctx = await this.contexts.resolveAlive(contextId);
    if (!ctx) return { alive: false };
    return { alive: true, ...ctx };
  }

  // -------- Context-bound views (GET only — the guard enforces it) --------

  @Get(':contextId/shop')
  async shopOverview(@Req() req: SupportContextRequest) {
    return this.contexts.viewShopOverview(req.supportContext);
  }

  @Get(':contextId/setup-health')
  async setupHealth(@Req() req: SupportContextRequest) {
    return this.contexts.viewSetupHealth(req.supportContext);
  }

  @Get(':contextId/courier-accounts')
  async courierAccounts(@Req() req: SupportContextRequest) {
    return this.contexts.viewCourierAccounts(req.supportContext);
  }
}
