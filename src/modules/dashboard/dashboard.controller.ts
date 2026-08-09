import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { RolesGuard } from '../team/rbac/roles.guard';
import { RequiresPermission } from '../team/rbac/requires-permission.decorator';
import { DashboardService } from './dashboard.service';
import { TestView } from './dashboard.types';

/**
 * §9.10 dashboard endpoints. Every figure is served from
 * `rollup_hourly_stats` (§5.7) with an as-of time (§5.2); test/live view
 * defaults to live (§9.23).
 *
 * Permission: §10.2 has no dedicated dashboard row; the dashboard is a
 * read-only figures surface, so it borrows the 'reports.run' row — the
 * only §10.2 read row granted ✓ to all four merchant roles (Owner,
 * Operator, Finance, Viewer). RolesGuard enforces it against the catalog;
 * SessionGuard binds (shop_id, member_id) first (INV-1).
 */
@Controller('dashboard')
@UseGuards(SessionGuard, RolesGuard)
@RequiresPermission('reports.run')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** §9.10: cards, today-vs-yesterday, matrix, F-16 performance, COD vs
   *  Prepaid, 30-day trend — all from rollups, with as-of. */
  @Get()
  getDashboard(@Req() req: AuthenticatedRequest, @Query('view') view?: string) {
    return this.dashboard.getDashboard(req.session.shopId, parseView(view));
  }

  /** §9.10 Service performance (F-16.a–d) from rollups only. */
  @Get('service-performance')
  getServicePerformance(
    @Req() req: AuthenticatedRequest,
    @Query('view') view?: string,
    @Query('days') days?: string,
  ) {
    return this.dashboard.getServicePerformance(
      req.session.shopId,
      parseView(view),
      parseDays(days),
    );
  }

  /** §9.10 30-day trend from rollups only. */
  @Get('trends')
  getTrends(
    @Req() req: AuthenticatedRequest,
    @Query('view') view?: string,
    @Query('days') days?: string,
  ) {
    return this.dashboard.getTrend(
      req.session.shopId,
      parseView(view),
      parseDays(days),
    );
  }
}

/** §9.23: the test/live filter defaults to live; only 'test' opts out. */
function parseView(view: string | undefined): TestView {
  return view === 'test' ? 'test' : 'live';
}

function parseDays(days: string | undefined): number | undefined {
  if (days === undefined) return undefined;
  const n = Number(days);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
