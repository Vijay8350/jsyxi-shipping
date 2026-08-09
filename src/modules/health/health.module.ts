import { Module, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderDerivationModule } from '../order-derivation/order-derivation.module';
import { TrackPageModule } from '../track-page/track-page.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SetupHealthService } from './setup-health.service';
import { SetupHealthScheduler } from './setup-health.scheduler';
import { SetupHealthProcessor } from './setup-health.processor';
import { SetupHealthController } from './setup-health.controller';
import { FullRedactionService } from './full-redaction.service';
import { LocalFilesystemObjectErase, OBJECT_ERASE } from './object-erase';

/**
 * Setup health (ADD-29/ADD-30) + §5.5 GDPR completion.
 *
 * Wiring notes for the parent:
 *  - Register HealthModule in AppModule (this module may not edit it).
 *  - DatabaseModule / RedisModule / AuditModule are global. The imports
 *    supply PrivacyRedactionService (phase-1 redaction, composed by
 *    FullRedactionService), TrackTokenService and MessageDispatcherService.
 *  - BINDING POINT 1: the GDPR webhook handlers in
 *    order-derivation/handlers/gdpr-webhook.handlers.ts currently call the
 *    phase-1 PrivacyRedactionService; they should call
 *    FullRedactionService.redactCustomerFull / redactShopFull /
 *    produceFullDataRequest instead so the §5.5 loop actually completes.
 *  - BINDING POINT 2: OBJECT_ERASE is bound to a local filesystem eraser
 *    rooted at the object-store dir; once booking-ops ObjectStore gains a
 *    deleteObject method, rebind OBJECT_ERASE to the OBJECT_STORE instance
 *    (see object-erase.ts).
 */
@Module({
  imports: [
    forwardRef(() => OrderDerivationModule),
    TrackPageModule,
    forwardRef(() => NotificationsModule),
  ],
  controllers: [SetupHealthController],
  providers: [
    SetupHealthService,
    SetupHealthScheduler,
    SetupHealthProcessor,
    FullRedactionService,
    {
      provide: OBJECT_ERASE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new LocalFilesystemObjectErase(
          config.get<string>('objectStoreDir') ??
            config.get<string>('OBJECT_STORE_DIR') ??
            'var/objects',
        ),
    },
  ],
  exports: [SetupHealthService, FullRedactionService],
})
export class HealthModule {}
