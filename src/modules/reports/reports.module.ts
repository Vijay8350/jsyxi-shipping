import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentUrlSigner } from '../booking-ops/document-urls';
import { LocalFilesystemObjectStore, OBJECT_STORE } from '../booking-ops/object-store';
import { NotificationsModule } from '../notifications/notifications.module';
import { NotificationService } from '../notifications/notification.service';
import { ReportRunnerService } from './report-runner.service';
import { ReportScheduleService } from './report-schedule.service';
import { ReportsController } from './reports.controller';
import { ReportsProcessor, ReportsQueueService, ReportsSchedulerShell } from './reports-queue';
import { ReportsService } from './reports.service';
import { NOTIFICATION_SENDER } from './notification-sender';

/**
 * Reports pack (M11; §11, §5.2, A2-06, INV-19).
 *
 * Wiring notes:
 *  - DatabaseModule, RedisModule, AuditModule and AuthModule are @Global.
 *  - DocumentUrlSigner and OBJECT_STORE are NOT exported by BookingOpsModule,
 *    so local instances are provided here (the same pattern BookingOpsModule
 *    uses for QuoteCacheService): the signer is stateless against
 *    DOCUMENT_SIGNING_SECRET, and the local object store shares the same
 *    OBJECT_STORE_DIR root, so both modules see the same objects.
 *  - NOTIFICATION_SENDER is the §9.21 seam: the notifications module binds
 *    it when it lands; the default is a no-op (INV-21).
 *
 * Binding point for the parent: import ReportsModule in app.module.ts, and
 * rebind NOTIFICATION_SENDER to the notifications module's sender.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    ReportRunnerService,
    ReportScheduleService,
    ReportsQueueService,
    ReportsProcessor,
    ReportsSchedulerShell,
    DocumentUrlSigner,
    {
      provide: OBJECT_STORE,
      inject: [ConfigService, DocumentUrlSigner],
      useFactory: (config: ConfigService, signer: DocumentUrlSigner) =>
        new LocalFilesystemObjectStore(
          config.get<string>('OBJECT_STORE_DIR') ?? 'var/objects',
          (payload) => signer.hmac(payload),
        ),
    },
    // §9.21: report-ready mail with the expiring link (INV-21 — delivery
    // never gates the job; notify swallows failures internally).
    {
      provide: NOTIFICATION_SENDER,
      inject: [NotificationService],
      useFactory: (notifications: NotificationService) => ({
        sendReportReady: (message: {
          shopId: string;
          reportCode: string;
          reportJobId: string;
          requestedBy: string | null;
          recipients: string[];
          downloadUrl: string;
          expiresAt: Date;
          rowCount: number;
        }) =>
          notifications.notify(message.shopId, 'report.ready', {
            subject: `Report ${message.reportCode} ready`,
            body: `Your ${message.reportCode} report is ready (${message.rowCount} rows). The download link expires at ${message.expiresAt.toISOString()}.`,
            requesterMemberId: message.requestedBy ?? undefined,
            link: message.downloadUrl,
          }),
      }),
    },
  ],
  exports: [ReportsService, ReportScheduleService, NOTIFICATION_SENDER],
})
export class ReportsModule {}
