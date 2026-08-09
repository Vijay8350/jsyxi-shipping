import { Module } from '@nestjs/common';
import { TrackingDelayService } from '../tracking/tracking-delay.service';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminGuard } from './admin.guard';
import { AdminMonitorsController } from './admin-monitors.controller';
import { BookingFailureMonitorService } from './booking-failure-monitor.service';
import { CourierApiMonitorService } from './courier-api-monitor.service';
import { CourierMasterController } from './courier-master.controller';
import { CourierMasterService } from './courier-master.service';
import { DlqAdminController } from './dlq-admin.controller';
import { DlqAdminService } from './dlq-admin.service';
import { FeatureFlagController } from './feature-flag.controller';
import { FeatureFlagService } from './feature-flag.service';
import { MerchantDirectoryController } from './merchant-directory.controller';
import { MerchantDirectoryService } from './merchant-directory.service';
import { PlanAdminController } from './plan-admin.controller';
import { PlanAdminService } from './plan-admin.service';
import {
  ScreenGuideAdminController,
  ScreenGuideMerchantController,
} from './screen-guide.controller';
import { ScreenGuideService } from './screen-guide.service';
import { SupportContextController } from './support-context.controller';
import { SupportContextGuard } from './support-context.guard';
import { SupportContextService } from './support-context.service';

/**
 * §9.13 admin panel (admin.jsyxi.com): MFA-backed admin auth + RBAC (§10.3),
 * Courier Master CRUD, merchant list + ADD-31 health board, ADD-32 booking
 * failure monitor, ADD-33 screen guides, plans, feature flags, DLQ replay
 * (§8.6), support contexts (A1-07) and the courier API error monitor.
 *
 * DatabaseModule / AuditModule / AuthModule are @Global, so no imports are
 * needed. TrackingDelayService is re-provided here (plain injectable over
 * PG_POOL) as the §3.6 unmapped-status feed — the tracking module stays
 * untouched. The parent wires AdminModule into AppModule and should also
 * register SupportContextGuard on any sibling route that serves merchant
 * data to admins (see module README notes in the handoff).
 */
@Module({
  controllers: [
    AdminAuthController,
    CourierMasterController,
    MerchantDirectoryController,
    AdminMonitorsController,
    ScreenGuideAdminController,
    ScreenGuideMerchantController,
    PlanAdminController,
    FeatureFlagController,
    DlqAdminController,
    SupportContextController,
  ],
  providers: [
    AdminAuthService,
    AdminGuard,
    SupportContextGuard,
    SupportContextService,
    CourierMasterService,
    MerchantDirectoryService,
    BookingFailureMonitorService,
    CourierApiMonitorService,
    ScreenGuideService,
    PlanAdminService,
    FeatureFlagService,
    DlqAdminService,
    TrackingDelayService,
  ],
  exports: [AdminGuard, SupportContextGuard, AdminAuthService, SupportContextService],
})
export class AdminModule {}
