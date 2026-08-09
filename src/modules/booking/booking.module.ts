import { Module, forwardRef } from '@nestjs/common';
import { CourierFrameworkModule } from '../courier-framework/courier-framework.module';
import { RateEngineModule } from '../rate-engine/rate-engine.module';
import { PlatformModule } from '../platform/platform.module';
import { OrderDerivationModule } from '../order-derivation/order-derivation.module';
import { SyncBackModule } from '../sync-back/sync-back.module';
import { RulesModule } from '../rules/rules.module';
import { GstModule } from '../gst/gst.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { BillingModule } from '../billing/billing.module';
import { BookingService } from './booking.service';
import { BookingWorkerService } from './booking-worker.service';
import { BookingProcessor, BookingQueueService } from './booking-queue';
import { CancellationService } from './cancellation.service';
import { ShipModalService } from './ship-modal.service';
import { QuoteCacheService } from './quote-cache.service';
import { BookingController } from './booking.controller';
import { OperatorPlusGuard } from './operator-plus.guard';

/**
 * Booking core (§9.5, M5): the §2.9 snapshot assembler, the §3.2 booking
 * state machine with the §9.5.4 exactly-once protocol, the §5.7 `booking`
 * queue + worker, the §9.5.1 ship modal and single-booking endpoints, and
 * §9.5.5 pre-pickup cancellation.
 *
 * DatabaseModule, RedisModule, AuditModule and AuthModule are @Global. Not
 * built here (sibling blocks): §9.5.2 bulk booking, §9.5.3 auto-ship, pickup
 * scheduling + manifests, Shopify sync-back (§9.6).
 */
@Module({
  imports: [
    CourierFrameworkModule,
    RateEngineModule,
    PlatformModule,
    forwardRef(() => OrderDerivationModule),
    // Provides SYNC_BACK_PUBLISHER: CONFIRMED bookings enqueue the §8.4
    // fulfillment create through the outbox (test shipments excluded, INV-19).
    SyncBackModule,
    // §9.4.4 routing runs at the head of queueBooking; §9.9.2 invoice
    // creation hooks the CONFIRMED path.
    RulesModule,
    GstModule,
    // ADD-26: CONFIRMED bookings trigger the buyer "shipped" message.
    forwardRef(() => NotificationsModule),
    // §9.5.6 overage emission + §9.14 allowance alerts ride the CONFIRMED path.
    forwardRef(() => BillingModule),
  ],
  controllers: [BookingController],
  providers: [
    BookingService,
    BookingWorkerService,
    BookingQueueService,
    BookingProcessor,
    CancellationService,
    ShipModalService,
    QuoteCacheService,
    OperatorPlusGuard,
  ],
  exports: [BookingService, BookingWorkerService, CancellationService, BookingQueueService],
})
export class BookingModule {}
