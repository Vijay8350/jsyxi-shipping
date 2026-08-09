import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { RequiresPermission } from '../team/rbac/requires-permission.decorator';
import { RolesGuard } from '../team/rbac/roles.guard';
import { NdrActionService } from './ndr-action.service';
import { NdrAnalyticsService, NdrBreakdown, RtoBreakdown } from './ndr-analytics.service';
import { NdrInboxService, NdrInboxFilters } from './ndr-inbox.service';
import { NdrSettingsService } from './ndr-settings.service';
import {
  NdrAction,
  NdrAlertChannel,
  NdrCaseState,
  NdrDigestFrequency,
  NdrReason,
} from './ndr.types';

interface NdrActionBody {
  action?: NdrAction;
  payload?: Record<string, unknown>;
}

interface BulkActionBody extends NdrActionBody {
  ndrCaseIds?: string[];
}

interface SettingsBody {
  recipients?: string[];
  channel?: NdrAlertChannel;
  digestFrequency?: NdrDigestFrequency;
  autoReattemptOnce?: boolean;
  escalationTemplates?: unknown[];
}

const ACTIONS: readonly NdrAction[] = [
  'REATTEMPT',
  'UPDATE_ADDRESS_AND_REATTEMPT',
  'INITIATE_RTO',
];

/**
 * §9.8 NDR suite endpoints. SessionGuard establishes identity (INV-1);
 * RolesGuard authorizes against the §10.2 matrix: actions are Operator+
 * ('ndr.act'), settings are Operator+ ('settings.ndr_notifications.edit'),
 * and reads are available to every authenticated member (§10.2 row 1 —
 * "View orders, shipments, tracking" grants all roles ✓/R). Structured
 * failures return 422 with the failure body — never silent (INV-20).
 */
@Controller('ndr')
@UseGuards(SessionGuard, RolesGuard)
export class NdrController {
  constructor(
    private readonly inboxService: NdrInboxService,
    private readonly actionService: NdrActionService,
    private readonly settingsService: NdrSettingsService,
    private readonly analytics: NdrAnalyticsService,
  ) {}

  /** §9.8.1 inbox: filters state / reason / aging / Service / courier
   *  account / §9.23 test-live (default live-only). */
  @Get('inbox')
  inbox(@Req() req: AuthenticatedRequest, @Query() query: Record<string, string>) {
    const filters: NdrInboxFilters = {
      state: query.state as NdrCaseState | undefined,
      reason: query.reason as NdrReason | undefined,
      agingMinDays: query.agingMinDays !== undefined ? Number(query.agingMinDays) : undefined,
      agingMaxDays: query.agingMaxDays !== undefined ? Number(query.agingMaxDays) : undefined,
      serviceId: query.serviceId,
      courierAccountId: query.courierAccountId,
      isTest: query.isTest === undefined ? undefined : query.isTest === 'true',
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
      offset: query.offset !== undefined ? Number(query.offset) : undefined,
    };
    return this.inboxService.inbox(req.session.shopId, filters);
  }

  /** §9.8.1 single action (Operator+): Reattempt · Update address & phone →
   *  reattempt · Initiate RTO. */
  @Post('cases/:id/actions')
  @HttpCode(200)
  @RequiresPermission('ndr.act')
  async submitAction(
    @Req() req: AuthenticatedRequest,
    @Param('id') ndrCaseId: string,
    @Body() body: NdrActionBody,
  ) {
    if (!body?.action || !ACTIONS.includes(body.action)) {
      throw new UnprocessableEntityException({ submitted: false, code: 'INVALID_ACTION' });
    }
    const result = await this.actionService.submit({
      shopId: req.session.shopId,
      ndrCaseId,
      action: body.action,
      payload: body.payload,
      actorMemberId: req.session.memberId,
    });
    if (!result.submitted) throw new UnprocessableEntityException(result);
    return result;
  }

  /** §9.8.1 + ADD-36: the bulk NDR action, per-case partial results. */
  @Post('actions/bulk')
  @HttpCode(200)
  @RequiresPermission('ndr.act')
  async submitBulk(@Req() req: AuthenticatedRequest, @Body() body: BulkActionBody) {
    if (
      !body?.action ||
      !ACTIONS.includes(body.action) ||
      !Array.isArray(body.ndrCaseIds) ||
      body.ndrCaseIds.length === 0
    ) {
      throw new UnprocessableEntityException({ submitted: false, code: 'INVALID_BULK_REQUEST' });
    }
    const results = await this.actionService.submitBulk({
      shopId: req.session.shopId,
      ndrCaseIds: body.ndrCaseIds,
      action: body.action,
      payload: body.payload,
      actorMemberId: req.session.memberId,
    });
    return {
      results,
      succeeded: results.filter((r) => r.result.submitted).length,
      failed: results.filter((r) => !r.result.submitted).length,
    };
  }

  /** §9.8.2 settings read (any authenticated member). */
  @Get('settings')
  getSettings(@Req() req: AuthenticatedRequest) {
    return this.settingsService.get(req.session.shopId);
  }

  /** §9.8.2 settings write — S-41/S-42/S-43 + escalation templates (Operator+). */
  @Put('settings')
  @RequiresPermission('settings.ndr_notifications.edit')
  updateSettings(@Req() req: AuthenticatedRequest, @Body() body: SettingsBody) {
    return this.settingsService.update(
      req.session.shopId,
      body ?? {},
      req.session.memberId,
    );
  }

  /** §9.8.3 analytics: F-16.b NDR breakdown by service / pincode / reason. */
  @Get('analytics/ndr')
  @RequiresPermission('reports.run')
  ndrAnalytics(
    @Req() req: AuthenticatedRequest,
    @Query() query: { from?: string; to?: string; breakdown?: NdrBreakdown },
  ) {
    return this.analytics.ndrRates(
      req.session.shopId,
      { from: query.from ?? '1970-01-01', to: query.to ?? '2999-01-01' },
      query.breakdown ?? 'service',
    );
  }

  /** §9.8.3 analytics: F-16.c RTO breakdown by service / pincode. */
  @Get('analytics/rto')
  @RequiresPermission('reports.run')
  rtoAnalytics(
    @Req() req: AuthenticatedRequest,
    @Query() query: { from?: string; to?: string; breakdown?: RtoBreakdown },
  ) {
    return this.analytics.rtoRates(
      req.session.shopId,
      { from: query.from ?? '1970-01-01', to: query.to ?? '2999-01-01' },
      query.breakdown ?? 'service',
    );
  }
}
