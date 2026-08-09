import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ShopifyModule } from './modules/shopify/shopify.module';
import { TeamModule } from './modules/team/team.module';
import { NativeAuthModule } from './modules/native-auth/native-auth.module';
import { PlatformModule } from './modules/platform/platform.module';
import { OrderSyncModule } from './modules/order-sync/order-sync.module';
import { OrderDerivationModule } from './modules/order-derivation/order-derivation.module';
import { CourierFrameworkModule } from './modules/courier-framework/courier-framework.module';
import { RateEngineModule } from './modules/rate-engine/rate-engine.module';
import { DelhiveryModule } from './modules/delhivery/delhivery.module';
import { XpressbeesModule } from './modules/xpressbees/xpressbees.module';
import { BluedartModule } from './modules/bluedart/bluedart.module';
import { DtdcModule } from './modules/dtdc/dtdc.module';
import { AmazonShippingModule } from './modules/amazon_shipping/amazon_shipping.module';
import { ShadowfaxModule } from './modules/shadowfax/shadowfax.module';
import { ShiprocketModule } from './modules/shiprocket/shiprocket.module';
import { BookingModule } from './modules/booking/booking.module';
import { BookingOpsModule } from './modules/booking-ops/booking-ops.module';
import { SyncBackModule } from './modules/sync-back/sync-back.module';
import { TrackingModule } from './modules/tracking/tracking.module';
import { TrackPageModule } from './modules/track-page/track-page.module';
import { RulesModule } from './modules/rules/rules.module';
import { LabelsModule } from './modules/labels/labels.module';
import { GstModule } from './modules/gst/gst.module';
import { NdrModule } from './modules/ndr/ndr.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { ReportsModule } from './modules/reports/reports.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReconFreightModule } from './modules/recon-freight/recon-freight.module';
import { ReconCodModule } from './modules/recon-cod/recon-cod.module';
import { SupportModule } from './modules/support/support.module';
import { AdminModule } from './modules/admin/admin.module';
import { BillingModule } from './modules/billing/billing.module';
import { HealthModule } from './modules/health/health.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { OpsModule } from './ops/ops.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    DatabaseModule,
    RedisModule,
    AuditModule,
    AuthModule,
    ShopifyModule,
    TeamModule,
    NativeAuthModule,
    PlatformModule,
    OrderDerivationModule,
    OrderSyncModule,
    CourierFrameworkModule,
    RateEngineModule,
    DelhiveryModule,
    XpressbeesModule,
    BluedartModule,
    DtdcModule,
    AmazonShippingModule,
    ShadowfaxModule,
    ShiprocketModule,
    BookingModule,
    BookingOpsModule,
    SyncBackModule,
    TrackingModule,
    TrackPageModule,
    RulesModule,
    LabelsModule,
    GstModule,
    NdrModule,
    DashboardModule,
    ReportsModule,
    NotificationsModule,
    ReconFreightModule,
    ReconCodModule,
    SupportModule,
    AdminModule,
    BillingModule,
    HealthModule,
    MaintenanceModule,
    OpsModule,
  ],
})
export class AppModule {}
