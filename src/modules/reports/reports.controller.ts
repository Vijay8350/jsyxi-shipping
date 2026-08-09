import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthenticatedRequest, SessionGuard } from '../../auth/session.guard';
import { RequiresPermission } from '../team/rbac/requires-permission.decorator';
import { RolesGuard } from '../team/rbac/roles.guard';
import { REPORT_CATALOGUE } from './report-catalogue';
import { ReportScheduleService } from './report-schedule.service';
import { ReportsService } from './reports.service';

/**
 * §9.11 reports endpoints. SessionGuard establishes identity (INV-1);
 * RolesGuard enforces §10.2 'reports.run' — "Run and schedule reports;
 * download exports" ✓✓✓✓, all four merchant roles. Tenancy itself is
 * enforced shop-scoped in the services.
 *
 * Downloads follow the booking-ops S-26 pattern: the URL carries
 * expires + HMAC signature AND the caller must hold a session — the emailed
 * link is an authorized link for a signed-in Member, never a public URL.
 * Large reports are links, never attachments (A1-12).
 */
@Controller('reports')
@UseGuards(SessionGuard, RolesGuard)
@RequiresPermission('reports.run')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly schedules: ReportScheduleService,
  ) {}

  /** The §11 catalogue (codes, names, grains, attribution, columns). */
  @Get('catalogue')
  catalogue() {
    return Object.values(REPORT_CATALOGUE);
  }

  @Post('jobs')
  async enqueue(
    @Req() req: AuthenticatedRequest,
    @Body() body: { reportCode?: string; filters?: unknown },
  ) {
    return this.reports.enqueueReport({
      shopId: req.session.shopId,
      memberId: req.session.memberId,
      reportCode: body?.reportCode ?? '',
      filters: body?.filters,
    });
  }

  @Get('jobs')
  async listJobs(@Req() req: AuthenticatedRequest, @Query('limit') limit?: string) {
    return this.reports.listJobs(req.session.shopId, limit ? Number(limit) : undefined);
  }

  @Get('jobs/:id')
  async getJob(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.reports.getJob(req.session.shopId, id);
  }

  @Get('jobs/:id/download')
  async download(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param('id') id: string,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
  ) {
    const result = await this.reports.getDownload({
      shopId: req.session.shopId,
      reportJobId: id,
      expires: Number(expires ?? '0'),
      signature: signature ?? '',
    });
    if (result.kind === 'REDIRECT') {
      res.redirect(result.url);
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.bytes);
  }

  @Get('schedules')
  async listSchedules(@Req() req: AuthenticatedRequest) {
    return this.schedules.list(req.session.shopId);
  }

  @Post('schedules')
  async createSchedule(
    @Req() req: AuthenticatedRequest,
    @Body() body: { reportCode?: unknown; cadence?: unknown; recipients?: unknown; filters?: unknown },
  ) {
    return this.schedules.create(req.session.shopId, req.session.memberId, body ?? {});
  }

  @Patch('schedules/:id')
  async updateSchedule(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { reportCode?: unknown; cadence?: unknown; recipients?: unknown; filters?: unknown },
  ) {
    return this.schedules.update(req.session.shopId, req.session.memberId, id, body ?? {});
  }

  @Delete('schedules/:id')
  async deleteSchedule(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.schedules.remove(req.session.shopId, req.session.memberId, id);
    return { deleted: true };
  }
}
