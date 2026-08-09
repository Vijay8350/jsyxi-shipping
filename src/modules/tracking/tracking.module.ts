import { Module, forwardRef } from '@nestjs/common';
import { CourierFrameworkModule } from '../courier-framework/courier-framework.module';
import { SyncBackModule } from '../sync-back/sync-back.module';
import { NdrModule } from '../ndr/ndr.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReconCodModule } from '../recon-cod/recon-cod.module';
import { CodReconTrackingSeam } from '../recon-cod/cod-recon-tracking-seam';
import { NdrTrackingSeams } from '../ndr/ndr-tracking-seams';
import { TrackingSeams } from './tracking-seams';
import { OwnerGuard } from '../courier-framework/owner.guard';
import { CourierWebhookIngestService } from './courier-webhook-ingest.service';
import { TrackingIngestService } from './tracking-ingest.service';
import { MovementReducerService } from './movement-reducer.service';
import { TrackingPollingService } from './tracking-polling.service';
import { TrackingDelayService } from './tracking-delay.service';
import { WebhookPayloadsService } from './webhook-payloads.service';
import { WebhookPayloadsController } from './webhook-payloads.controller';
import {
  TrackingIngestProcessor,
  TrackingIngestQueueService,
  TrackingPollScheduler,
} from './tracking-queue';
import { TRACKING_SEAMS } from './tracking-seams';

/**
 * Tracking engine (§9.7, M7): §8.5 durable webhook ingest + polling
 * fallback, §3.6 normalization against courier_status_map, the §3.4 reducer
 * (the only movement_state writer), the S-47 delay flag, and the ADD-18
 * payload viewer/replay surface.
 *
 * DatabaseModule, RedisModule, AuditModule and AuthModule are @Global.
 * CourierFrameworkModule supplies AdapterCallerService (polling) and
 * SyncBackModule supplies SyncBackService (§8.4 fulfillment events; INV-19
 * test exclusion lives inside it).
 *
 * TRACKING_SEAMS ships a no-op default: the recon COD expectation (M17)
 * binds onDelivered and the NDR suite (M8, machine F) binds onNdr.
 *
 * The parent wires: AppModule imports TrackingModule, and
 * CourierWebhookController calls CourierWebhookIngestService
 * .ingestVerifiedWebhook before its ack (§8.5 durable-before-ack).
 */
@Module({
  imports: [
    forwardRef(() => CourierFrameworkModule),
    SyncBackModule,
    // NdrModule supplies the machine-F seam binding (§3.10);
    // NotificationsModule supplies ADD-26 buyer notifications.
    // forwardRef: the ndr → courier-framework → tracking module chain is
    // circular at require time (live boot proved it).
    forwardRef(() => NdrModule),
    forwardRef(() => NotificationsModule),
    ReconCodModule,
  ],
  controllers: [WebhookPayloadsController],
  providers: [
    CourierWebhookIngestService,
    TrackingIngestService,
    MovementReducerService,
    TrackingPollingService,
    TrackingDelayService,
    WebhookPayloadsService,
    TrackingIngestQueueService,
    TrackingIngestProcessor,
    TrackingPollScheduler,
    OwnerGuard,
    // Machine F (§3.10) answers onNdr/terminal close; the recon COD ledger
    // (§9.17.3) answers onDelivered and §4.7's RTO_UNCOLLECTED on RTO.
    {
      provide: TRACKING_SEAMS,
      useFactory: (ndr: NdrTrackingSeams, cod: CodReconTrackingSeam): TrackingSeams => ({
        onDelivered: async (i) => {
          await ndr.onDelivered(i); // machine F closes (§3.10 terminal row)
          await cod.onDelivered(i); // §9.17.3 expectation creation
        },
        onNdr: (i) => ndr.onNdr(i),
        onTerminalMovement: async (i) => {
          await ndr.closeOnTerminalMovement(i);
          if (i.movementState === 'RTO_DELIVERED') await cod.onTerminalMovement(i);
        },
        onRtoInitiated: (i) => cod.onRtoInitiated(i), // §4.7 RTO_UNCOLLECTED
      }),
      inject: [NdrTrackingSeams, CodReconTrackingSeam],
    },
  ],
  exports: [
    CourierWebhookIngestService,
    TrackingIngestService,
    MovementReducerService,
    TrackingPollingService,
    TrackingDelayService,
    WebhookPayloadsService,
    TRACKING_SEAMS,
  ],
})
export class TrackingModule {}
