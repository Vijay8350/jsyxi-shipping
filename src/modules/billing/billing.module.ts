import { Module, forwardRef } from '@nestjs/common';
import { ShopifyModule } from '../shopify/shopify.module';
import { PlatformModule } from '../platform/platform.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AccountSweepService } from './account-sweep.service';
import { BillingAlertsService } from './billing-alerts.service';
import { BillingController } from './billing.controller';
import { BillingProcessor, BillingScheduler } from './billing-queue';
import { BillingService } from './billing.service';
import { OverageService } from './overage.service';
import { ShopifyBillingClient } from './shopify-billing.client';
import { SubscriptionsUpdateHandler } from './handlers/subscriptions-update.handler';

/**
 * Plan & billing module (§9.14, §9.5.6, §3.11, §3.20; A2-08; INV-23).
 * DatabaseModule, RedisModule, AuditModule and AuthModule are @Global, so
 * PG_POOL, REDIS, AuditService and SessionGuard inject without imports.
 *
 * Exports are the binding points for sibling modules:
 *  - OverageService.recordOverageForShipment — booking worker, after a
 *    durably-confirmed non-test AWB debit (§9.5.6).
 *  - OverageService.reverseOverageForShipment — cancellation path, after the
 *    entitlement ledger reversed a pre-pickup courier-confirmed cancel.
 *  - BillingAlertsService.checkAllowanceThresholds — after each debit (the
 *    daily sweep also re-checks trials).
 *  - BillingService.applyExternalStatus — Shopify app/subscriptions_update
 *    webhook handler (payment failure / store freeze / cancellation).
 */
@Module({
  imports: [ShopifyModule, PlatformModule, forwardRef(() => NotificationsModule)],
  controllers: [BillingController],
  providers: [
    ShopifyBillingClient,
    BillingService,
    OverageService,
    BillingAlertsService,
    AccountSweepService,
    BillingScheduler,
    BillingProcessor,
    SubscriptionsUpdateHandler,
  ],
  exports: [
    BillingService,
    OverageService,
    BillingAlertsService,
    AccountSweepService,
  ],
})
export class BillingModule {}
