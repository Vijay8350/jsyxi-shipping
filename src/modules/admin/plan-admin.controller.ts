import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { AdminRoles } from './admin-roles.decorator';
import { PlanAdminService } from './plan-admin.service';
import { CreatePlanDto, UpdatePlanDto } from './plan-admin.dto';
import { AdminAuthenticatedRequest } from './admin.types';

/**
 * §9.13 plan/tier management — §10.3 grants this to PLATFORM_ADMIN and
 * PLATFORM_FINANCE. Plan rows only; charges are Shopify Billing's (§9.14).
 */
@Controller('admin/plans')
@UseGuards(AdminGuard)
export class PlanAdminController {
  constructor(private readonly plans: PlanAdminService) {}

  @Get()
  @AdminRoles('PLATFORM_ADMIN', 'PLATFORM_FINANCE')
  async list() {
    return this.plans.listPlans();
  }

  @Post()
  @AdminRoles('PLATFORM_ADMIN', 'PLATFORM_FINANCE')
  async create(@Req() req: AdminAuthenticatedRequest, @Body() dto: CreatePlanDto) {
    return this.plans.createPlan(req.admin, dto);
  }

  @Patch(':planId')
  @HttpCode(204)
  @AdminRoles('PLATFORM_ADMIN', 'PLATFORM_FINANCE')
  async update(
    @Req() req: AdminAuthenticatedRequest,
    @Param('planId') planId: string,
    @Body() dto: UpdatePlanDto,
  ) {
    await this.plans.updatePlan(req.admin, planId, dto);
  }
}
