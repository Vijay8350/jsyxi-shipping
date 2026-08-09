import { Module, forwardRef } from '@nestjs/common';
import { ShopifyModule } from '../shopify/shopify.module';
import { OrderDerivationModule } from '../order-derivation/order-derivation.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrderUpsertService } from './order-upsert.service';
import { OrderIngestService } from './order-ingest.service';
import { LocationService } from './location.service';
import { AllocationService } from './allocation.service';
import {
  OrdersCancelledHandler,
  OrdersCreateHandler,
  OrdersFulfilledHandler,
  OrdersUpdatedHandler,
} from './handlers/order-webhook.handlers';
import { OrderSweepService } from './sweep/order-sweep.service';
import { OrderIngestScheduler } from './sweep/order-ingest.scheduler';
import { OrderIngestProcessor } from './sweep/order-ingest.processor';

/**
 * §9.2 order sync (M2 + A4-01, RV-11). DatabaseModule / RedisModule /
 * AuditModule are global; ShopifyModule supplies the GraphQL client and the
 * webhook dispatcher the orders/* handlers register on (§8.1). The parent
 * wires this module into AppModule.
 *
 * Exported for the week-4 agent: OrderIngestService (ingest result hook for
 * the INV-7 eligibility evaluation) and OrderUpsertService (upsert result +
 * UNBOOKED_ORDER_STATES).
 */
@Module({
  imports: [ShopifyModule, OrderDerivationModule, forwardRef(() => NotificationsModule)],
  providers: [
    OrderUpsertService,
    OrderIngestService,
    LocationService,
    AllocationService,
    OrdersCreateHandler,
    OrdersUpdatedHandler,
    OrdersCancelledHandler,
    OrdersFulfilledHandler,
    OrderSweepService,
    OrderIngestScheduler,
    OrderIngestProcessor,
  ],
  exports: [OrderIngestService, OrderUpsertService, LocationService, OrderSweepService],
})
export class OrderSyncModule {}
