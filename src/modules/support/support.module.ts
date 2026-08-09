import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { RolesGuard } from '../team/rbac/roles.guard';
import { AdminSupportController } from './admin-support.controller';
import { AdminGuard } from './admin.guard';
import { AnnouncementService } from './announcement.service';
import { FeedbackService } from './feedback.service';
import { SupportController } from './support.controller';
import { TicketService } from './ticket.service';

/**
 * Support module (§9.18 tickets, §9.19 announcements & feedback; schema in
 * migration 0017). DatabaseModule, AuditModule and AuthModule are @Global,
 * so PG_POOL and SessionGuard inject without imports; NotificationsModule
 * supplies NotificationService (§9.21 ticket.reply / announcement events).
 *
 * BINDING POINTS for the parent:
 *  - AppModule must import SupportModule (not wired here — app.module.ts is
 *    shared with sibling builds).
 *  - AdminGuard is a seam: the sibling §10.3 admin-auth module replaces it
 *    and supplies a real admin identity (see admin.guard.ts).
 *  - Attachment binaries flow through the booking-ops ObjectStore; this
 *    module validates and stores only {key, bytes} references (§5.1).
 */
@Module({
  imports: [NotificationsModule],
  controllers: [SupportController, AdminSupportController],
  providers: [TicketService, AnnouncementService, FeedbackService, RolesGuard, AdminGuard],
  exports: [TicketService, AnnouncementService, FeedbackService],
})
export class SupportModule {}
