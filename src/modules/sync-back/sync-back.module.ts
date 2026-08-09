import { Module } from '@nestjs/common';
import { ShopifyModule } from '../shopify/shopify.module';
import { TrackPageModule } from '../track-page/track-page.module';
import { SyncBackService, ShopifySyncBackPublisher, SYNC_BACK_PUBLISHER } from './sync-back.service';
import { SyncBackWorkerService } from './sync-back-worker.service';
import { ShopifySyncMutations } from './shopify-sync.mutations';
import { SyncCostBudget } from './cost-budget';
import { SyncBackQueueService, SyncBackProcessor } from './sync-back-queue';
import { SyncBackController } from './sync-back.controller';

/**
 * Shopify sync-back (§8.4, §9.6, M6): the sync_outbox writer (with the
 * INV-19 test-shipment skip and the §8.4 idempotency key), the §3.17 outbox
 * worker on the `shopify-sync` BullMQ queue with the §8.4 per-Shop cost
 * budget and the S-48 retry/DLQ policy, and the audited admin-only DEAD
 * replay.
 *
 * DatabaseModule, RedisModule and AuditModule are @Global; ShopifyModule
 * supplies the §8.4 GraphQL client. The parent wires this module into
 * AppModule and injects SYNC_BACK_PUBLISHER (SyncBackPublisher) into the
 * booking flow for the CONFIRMED → enqueueFulfillmentCreate hook.
 */
@Module({
  imports: [ShopifyModule, TrackPageModule],
  controllers: [SyncBackController],
  providers: [
    SyncBackService,
    ShopifySyncBackPublisher,
    { provide: SYNC_BACK_PUBLISHER, useExisting: ShopifySyncBackPublisher },
    SyncBackWorkerService,
    ShopifySyncMutations,
    SyncCostBudget,
    SyncBackQueueService,
    SyncBackProcessor,
  ],
  exports: [SyncBackService, ShopifySyncBackPublisher, SYNC_BACK_PUBLISHER],
})
export class SyncBackModule {}
