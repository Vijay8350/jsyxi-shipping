import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, SessionGuard } from '../../auth/session.guard';
import { RolesGuard } from '../team/rbac/roles.guard';
import { RequiresPermission } from '../team/rbac/requires-permission.decorator';
import { SetupHealthService } from './setup-health.service';

/**
 * ADD-30 merchant onboarding checklist. §10.2 has no dedicated setup-health
 * row; like the dashboard this is a read-only surface, so it borrows the
 * 'reports.run' row — the only §10.2 read row granted ✓ to all four
 * merchant roles. SessionGuard binds (shop_id, member_id) first (INV-1);
 * RolesGuard enforces the catalog permission.
 */
@Controller('setup')
@UseGuards(SessionGuard, RolesGuard)
export class SetupHealthController {
  constructor(private readonly health: SetupHealthService) {}

  /**
   * ADD-30: the stored ADD-29 object rendered as the dashboard checklist —
   * each item with state, detail and the deep link to the fixing screen;
   * `completed` when every item is OK. Computes on demand for a shop with
   * no stored rows yet (fresh install, before the first hourly sweep).
   */
  @Get('health')
  @RequiresPermission('reports.run')
  getHealth(@Req() req: AuthenticatedRequest) {
    return this.health.getChecklist(req.session.shopId);
  }

  /** ADD-29 "recompute on demand" — synchronous recompute, returns the
   *  fresh checklist. */
  @Post('health/recompute')
  @RequiresPermission('reports.run')
  async recompute(@Req() req: AuthenticatedRequest) {
    await this.health.compute(req.session.shopId);
    return this.health.getChecklist(req.session.shopId);
  }
}
