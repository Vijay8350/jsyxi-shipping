import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BookingModule } from '../booking/booking.module';
import { RulesModule } from '../rules/rules.module';
import { CourierFrameworkModule } from '../courier-framework/courier-framework.module';
import { QuoteCacheService } from '../booking/quote-cache.service';
import { BookingOpsController } from './booking-ops.controller';
import { PickupsController } from './pickups.controller';
import { DocumentsController } from './documents.controller';
import { BookingOpsOperatorPlusGuard } from './operator-plus.guard';
import { BulkBookingService } from './bulk-booking.service';
import { BulkBookingQueueService } from './bulk-booking-queue';
import { BulkBookingProcessor } from './bulk-booking.processor';
import { AutoShipService } from './auto-ship.service';
import { AutoShipProcessor, AutoShipScheduler } from './auto-ship-queue';
import { RouteResolver } from './route-resolver';
import { PickupService } from './pickup.service';
import { DocumentsService } from './documents.service';
import { DocumentUrlSigner } from './document-urls';
import { LocalFilesystemObjectStore, OBJECT_STORE } from './object-store';
import { NoopSyncBackPublisher, SYNC_BACK_PUBLISHER } from './sync-back-publisher';

/**
 * Booking operations (M5 continuations): §9.5.2 bulk booking, §9.5.3
 * auto-ship, §9.5.5 pickup scheduling + manifests (A4-02), and the §9.6
 * sync-back seam (SyncBackPublisher — no-op default; the parent injects the
 * real publisher into the booking worker's CONFIRMED path when the §9.6
 * module lands).
 *
 * BookingModule supplies BookingService (queueBooking is REUSED per order,
 * never duplicated). QuoteCacheService is provided locally rather than added
 * to BookingModule's exports — it is stateless, so a second instance is
 * equivalent (booking-ops is not allowed to edit shared module files).
 * DatabaseModule, RedisModule, AuditModule and AuthModule are @Global.
 */
@Module({
  imports: [BookingModule, CourierFrameworkModule, RulesModule],
  controllers: [BookingOpsController, PickupsController, DocumentsController],
  providers: [
    BulkBookingService,
    BulkBookingQueueService,
    BulkBookingProcessor,
    AutoShipService,
    AutoShipScheduler,
    AutoShipProcessor,
    RouteResolver,
    PickupService,
    DocumentsService,
    DocumentUrlSigner,
    QuoteCacheService,
    BookingOpsOperatorPlusGuard,
    {
      provide: OBJECT_STORE,
      inject: [ConfigService, DocumentUrlSigner],
      useFactory: (config: ConfigService, signer: DocumentUrlSigner) =>
        new LocalFilesystemObjectStore(
          config.get<string>('OBJECT_STORE_DIR') ?? 'var/objects',
          (payload) => signer.hmac(payload),
        ),
    },
    { provide: SYNC_BACK_PUBLISHER, useClass: NoopSyncBackPublisher },
  ],
  exports: [SYNC_BACK_PUBLISHER, BulkBookingService, AutoShipService, PickupService],
})
export class BookingOpsModule {}
