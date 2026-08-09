import { Module, forwardRef } from '@nestjs/common';
import { CourierFrameworkModule } from '../courier-framework/courier-framework.module';
import { TeamModule } from '../team/team.module';
import { NdrActionService } from './ndr-action.service';
import { NdrAnalyticsService } from './ndr-analytics.service';
import { NdrBuyerResponseService } from './ndr-buyer-response.service';
import { NdrCaseService } from './ndr-case.service';
import { NdrController } from './ndr.controller';
import { NdrInboxService } from './ndr-inbox.service';
import { NdrSettingsService } from './ndr-settings.service';
import { NdrTrackingSeams } from './ndr-tracking-seams';

/**
 * NDR suite (§9.8, M8): machine F (§3.10) case lifecycle, NDR actions via
 * the courier adapter (A1-03 capability gate), ADD-27 buyer self-serve (the
 * stated INV-21 exception), the §9.8.1 inbox, §9.8.2 settings (S-41–S-43)
 * and §9.8.3 analytics (F-16.b/c).
 *
 * DatabaseModule, AuditModule and AuthModule are @Global, so PG_POOL,
 * AuditService and SessionGuard inject without imports; RolesGuard comes
 * from the team module's §10.2 catalog; AdapterCallerService from the
 * courier framework.
 *
 * ADD-27's public endpoint is owned by the notifications module
 * (NdrRespondController), which calls NdrBuyerResponseService via the
 * NDR_RESPONSE_PROCESSOR seam — ndr-public.controller.ts is retained but
 * deliberately not registered.
 *
 * TRACKING_SEAMS is bound in the tracking module to this module's
 * NdrTrackingSeams (onNdr / onDelivered / closeOnTerminalMovement).
 */
@Module({
  imports: [forwardRef(() => CourierFrameworkModule), TeamModule],
  controllers: [NdrController],
  providers: [
    NdrCaseService,
    NdrActionService,
    NdrBuyerResponseService,
    NdrSettingsService,
    NdrInboxService,
    NdrAnalyticsService,
    NdrTrackingSeams,
  ],
  exports: [
    NdrTrackingSeams,
    NdrCaseService,
    NdrActionService,
    NdrBuyerResponseService,
    NdrSettingsService,
  ],
})
export class NdrModule {}
