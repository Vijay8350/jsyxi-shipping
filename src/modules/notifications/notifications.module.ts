import { Module, forwardRef } from '@nestjs/common';
import { Pool } from 'pg';
import { TrackPageModule } from '../track-page/track-page.module';
import { NdrModule } from '../ndr/ndr.module';
import { BookingModule } from '../booking/booking.module';
import { BookingService } from '../booking/booking.service';
import { NdrBuyerResponseService } from '../ndr/ndr-buyer-response.service';
import { PG_POOL } from '../../database/database.module';
import { RolesGuard } from '../team/rbac/roles.guard';
import {
  DevEmailSender,
  MESSAGE_SENDERS,
  MessageSender,
  MessageSenderRegistry,
} from './message-sender';
import { MessageDispatcherService } from './message-dispatcher.service';
import { NotificationSettingsService } from './notification-settings.service';
import { InAppService } from './in-app.service';
import { ThrottleService } from './throttle.service';
import { DigestService } from './digest.service';
import { NotificationService } from './notification.service';
import { BuyerNotificationService } from './buyer-notification.service';
import { NdrTokenService } from './ndr-token.service';
import { NdrRespondService } from './ndr-respond.service';
import { NdrRespondController } from './ndr-respond.controller';
import { NDR_RESPONSE_PROCESSOR } from './ndr-seam';
import { CodConfirmationService } from './cod-confirmation.service';
import { CodConfirmController } from './cod-confirm.controller';
import {
  COD_CONFIRMATION_BOOKER,
} from './cod-booker-seam';
import { NotificationsController } from './notifications.controller';
import {
  NotificationsProcessor,
  NotificationsQueueService,
} from './notifications-queue';

/**
 * Notification infrastructure (spec.md §9.21 + INV-21; addendum
 * ADD-25/26/27/28; schema in migration 0014).
 *
 * DatabaseModule, RedisModule, AuditModule and AuthModule are @Global.
 * TrackPageModule supplies TrackTokenService for the ADD-26 track links.
 *
 * REBINDING POINTS for the parent (see the seam files):
 *  - NDR_RESPONSE_PROCESSOR  → the NDR module's action path
 *    (src/modules/ndr/ NdrActionService.submit) once it lands.
 *  - COD_CONFIRMATION_BOOKER → BookingService (book anyway on COD expiry).
 *  - MESSAGE_SENDERS (multi) → real EMAIL/SMS/WHATSAPP providers; the
 *    log-only DevEmailSender is registered here as the EMAIL dev fallback.
 */
@Module({
  imports: [TrackPageModule, forwardRef(() => NdrModule), forwardRef(() => BookingModule)],
  controllers: [
    NdrRespondController,
    CodConfirmController,
    NotificationsController,
  ],
  providers: [
    RolesGuard,
    NotificationSettingsService,
    InAppService,
    ThrottleService,
    DigestService,
    MessageDispatcherService,
    NotificationService,
    BuyerNotificationService,
    NdrTokenService,
    NdrRespondService,
    CodConfirmationService,
    NotificationsQueueService,
    NotificationsProcessor,
    DevEmailSender,
    // ADD-25 provider registry: real EMAIL/SMS/WHATSAPP senders are added by
    // the parent by extending this factory's inject list (Nest has no
    // multi-providers).
    {
      provide: MESSAGE_SENDERS,
      useFactory: (dev: DevEmailSender): MessageSender[] => [dev],
      inject: [DevEmailSender],
    },
    {
      provide: MessageSenderRegistry,
      useFactory: (senders: MessageSender[]) => new MessageSenderRegistry(senders),
      inject: [MESSAGE_SENDERS],
    },
    // ADD-27: the NDR module processes the stored, audited buyer response
    // record into the corresponding ndr_action (the stated INV-21 exception).
    {
      provide: NDR_RESPONSE_PROCESSOR,
      useFactory: (svc: NdrBuyerResponseService) => ({
        processBuyerResponse: (responseId: string) => svc.processResponse(responseId),
      }),
      inject: [NdrBuyerResponseService],
    },
    // ADD-28: "book anyway" on COD-confirmation expiry books the order's
    // ready DRAFT shipments through the normal path (§3.2).
    {
      provide: COD_CONFIRMATION_BOOKER,
      useFactory: (pool: Pool, booking: BookingService) => ({
        bookAnyway: async (shopId: string, orderId: string) => {
          const { rows } = await pool.query<{ shipment_id: string }>(
            `SELECT shipment_id FROM shipment
              WHERE shop_id = $1 AND order_id = $2 AND booking_state = 'DRAFT'`,
            [shopId, orderId],
          );
          for (const row of rows) {
            await booking.queueBooking({ shopId, shipmentId: row.shipment_id, actorId: null });
          }
        },
      }),
      inject: [PG_POOL, BookingService],
    },
  ],
  exports: [
    NotificationService,
    BuyerNotificationService,
    CodConfirmationService,
    InAppService,
    MessageDispatcherService,
    NdrTokenService,
    NDR_RESPONSE_PROCESSOR,
    COD_CONFIRMATION_BOOKER,
    MESSAGE_SENDERS,
  ],
})
export class NotificationsModule {}
