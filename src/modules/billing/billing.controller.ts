import { IsUUID } from 'class-validator';
import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { RequiresPermission } from '../team/rbac/requires-permission.decorator';
import { RolesGuard } from '../team/rbac/roles.guard';
import { BillingService } from './billing.service';

export class CreateSubscriptionDto {
  @IsUUID()
  planId!: string;
}

/**
 * Plan & billing endpoints (§9.14, M14). Owner-only: every route requires
 * the §10.2 'billing.manage' permission, which the matrix grants to Owner
 * alone ("Billing: upgrade, downgrade, approve overage" ✓ — — —).
 *
 * These endpoints are deliberately NOT gated on account_state — billing is
 * how a RESTRICTED / READ_ONLY shop resubscribes back to ACTIVE (§3.11).
 */
@Controller('billing')
@UseGuards(SessionGuard, RolesGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** §9.14 tier cards. */
  @Get('plans')
  @RequiresPermission('billing.manage')
  listPlans() {
    return this.billing.listPlans();
  }

  /** §9.14 current plan + usage bar. */
  @Get('subscription')
  @RequiresPermission('billing.manage')
  getSubscription(@Req() req: AuthenticatedRequest) {
    return this.billing.getOverview(req.session.shopId);
  }

  /**
   * §9.5.6 upgrade/downgrade. Returns the Shopify confirmationUrl for
   * upgrades (effective after approval) or schedules a NEXT_CYCLE downgrade.
   */
  @Post('subscription')
  @RequiresPermission('billing.manage')
  changePlan(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateSubscriptionDto,
  ) {
    return this.billing.requestPlanChange(
      req.session.shopId,
      req.session.memberId,
      dto.planId,
    );
  }

  /**
   * §9.14 returnUrl target: the merchant lands here after approving (or
   * declining) at Shopify. Activation is verified by querying Shopify, never
   * trusted from redirect parameters.
   */
  @Get('confirm')
  @RequiresPermission('billing.manage')
  confirm(@Req() req: AuthenticatedRequest) {
    return this.billing.confirmSubscription(
      req.session.shopId,
      req.session.memberId,
    );
  }

  /** §3.11: cancellation → RESTRICTED (capability ladder applies). */
  @Post('subscription/cancel')
  @RequiresPermission('billing.manage')
  cancel(@Req() req: AuthenticatedRequest) {
    return this.billing.cancel(req.session.shopId, req.session.memberId);
  }

  /** §9.14 billing history: subscriptions, usage charges, credits. */
  @Get('history')
  @RequiresPermission('billing.manage')
  history(@Req() req: AuthenticatedRequest) {
    return this.billing.billingHistory(req.session.shopId);
  }
}
