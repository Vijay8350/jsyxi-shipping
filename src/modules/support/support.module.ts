import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { RolesGuard } from '../team/rbac/roles.guard';
import { AdminSupportController } from './admin-support.controller';
import { AdminModule } from '../admin/admin.module';
import { AnnouncementService } from './announcement.service';
import { FeedbackService } from './feedback.service';
import { SupportController } from './support.controller';
import { TicketService } from './ticket.service';
import { TicketAttachmentService } from './attachment.service';
import { BookingOpsModule } from '../booking-ops/booking-ops.module';

/**
 * Support module (§9.18 tickets, §9.19 announcements & feedback; schema in
 * migration 0017). DatabaseModule, AuditModule and AuthModule are @Global,
 * so PG_POOL and SessionGuard inject without imports; NotificationsModule
 * supplies NotificationService (§9.21 ticket.reply / announcement events).
 *
 * BINDING POINTS for the parent:
 *  - AppModule must import SupportModule (not wired here — app.module.ts is
 *    shared with sibling builds).
 *  - Admin endpoints use the §10.3 AdminGuard from the admin module (real
 *    admin_session + per-endpoint roles). The local placeholder guard that
 *    accepted a shared header token is gone.
 *  - Attachment binaries flow through the booking-ops ObjectStore; this
 *    module validates and stores only {key, bytes} references (§5.1).
 */
@Module({
  imports: [NotificationsModule, AdminModule, BookingOpsModule],
  controllers: [SupportController, AdminSupportController],
  providers: [TicketService, AnnouncementService, FeedbackService, TicketAttachmentService, RolesGuard],
  exports: [TicketService, AnnouncementService, FeedbackService],
})
export class SupportModule {}
