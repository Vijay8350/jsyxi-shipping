import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TeamModule } from '../team/team.module';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  LocalFilesystemObjectStore,
  OBJECT_STORE,
} from '../booking-ops/object-store';
import { RECON_DISPUTES_PROVIDER } from '../dashboard/recon-disputes';
import { ReconExportService, ReconExportSigner } from './recon-export.service';
import { ReconImportService } from './recon-import.service';
import { ReconProcessingService } from './recon-processing.service';
import { ReconDisputesBridge, ReconQueriesService } from './recon-queries.service';
import { ReconSettingsService } from './recon-settings.service';
import { ReconWorkflowService } from './recon-workflow.service';
import { ReconFreightController } from './recon-freight.controller';
import { ReconFreightProcessor, ReconFreightQueue } from './recon-queue';

/**
 * Freight reconciliation (§9.17.1/§9.17.2/§9.17.4, M17 freight side):
 * upload-only CSV import (RV-09) with §8.7 quarantine and INV-14
 * idempotency, async matching on the `recon-processing` queue (§5.7), the
 * exhaustive §4.8 expectation table computed BEFORE row insert (the §10.4
 * trigger makes imported values and flags immutable), the F-14 control
 * total (§3.28), the §3.14 row workflow, ADD-42 dispute evidence, the
 * dispute export (S-26 signed download) and the dashboard disputes feed.
 *
 * DatabaseModule, RedisModule, AuditModule and AuthModule are @Global;
 * RolesGuard comes from TeamModule, NotificationService from
 * NotificationsModule. OBJECT_STORE is bound locally (the booking-ops
 * binding is module-private); the driver is stateless, so a second instance
 * over the same root and signing secret is equivalent.
 *
 * BINDING POINTS for the app shell (src/app.module.ts is outside this
 * module's edit scope):
 *  - add ReconFreightModule to AppModule;
 *  - rebind the dashboard's RECON_DISPUTES_PROVIDER to ReconDisputesBridge
 *    (DashboardModule currently defaults it to zero).
 */
@Module({
  imports: [TeamModule, NotificationsModule],
  controllers: [ReconFreightController],
  providers: [
    ReconImportService,
    ReconProcessingService,
    ReconSettingsService,
    ReconWorkflowService,
    ReconExportService,
    ReconExportSigner,
    ReconQueriesService,
    ReconDisputesBridge,
    ReconFreightQueue,
    ReconFreightProcessor,
    {
      provide: OBJECT_STORE,
      inject: [ConfigService, ReconExportSigner],
      useFactory: (config: ConfigService, signer: ReconExportSigner) =>
        new LocalFilesystemObjectStore(
          config.get<string>('OBJECT_STORE_DIR') ?? 'var/objects',
          (payload) => signer.hmac(payload),
        ),
    },
    { provide: RECON_DISPUTES_PROVIDER, useExisting: ReconDisputesBridge },
  ],
  exports: [
    ReconQueriesService,
    ReconDisputesBridge,
    ReconSettingsService,
    ReconWorkflowService,
    RECON_DISPUTES_PROVIDER,
  ],
})
export class ReconFreightModule {}
