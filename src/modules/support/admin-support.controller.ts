import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard, AdminRequest } from './admin.guard';
import { AnnouncementService } from './announcement.service';
import { FeedbackService } from './feedback.service';
import {
  AssignTicketDto,
  ComposeAnnouncementDto,
  TicketReplyDto,
  TransitionTicketDto,
} from './support.dto';
import {
  CANNED_REPLIES,
  TicketCategory,
  TicketPriority,
  TicketState,
} from './support.types';
import { TicketService } from './ticket.service';

/**
 * Admin-side support endpoints (§9.18 inbox, §9.19 composer + feedback
 * list). Guarded by the lightweight AdminGuard — a SEAM: the full §10.3
 * MFA-backed admin RBAC is a sibling module and replaces the guard; every
 * route below stays unchanged when it lands.
 */
@Controller('admin/support')
@UseGuards(AdminGuard)
export class AdminSupportController {
  constructor(
    private readonly tickets: TicketService,
    private readonly announcements: AnnouncementService,
    private readonly feedback: FeedbackService,
  ) {}

  /* ------------------------------ Tickets ----------------------------- */

  /** §9.18 ticket inbox with filters (state / category / priority / assignment). */
  @Get('tickets')
  inbox(
    @Query('state') state?: TicketState,
    @Query('category') category?: TicketCategory,
    @Query('priority') priority?: TicketPriority,
    @Query('assignedAdminId') assignedAdminId?: string,
  ) {
    return this.tickets.listInbox({ state, category, priority, assignedAdminId });
  }

  /** RW-07: first-response and resolution metrics in calendar hours. */
  @Get('tickets/metrics')
  metrics(
    @Query('state') state?: TicketState,
    @Query('category') category?: TicketCategory,
    @Query('priority') priority?: TicketPriority,
    @Query('assignedAdminId') assignedAdminId?: string,
  ) {
    return this.tickets.metrics({ state, category, priority, assignedAdminId });
  }

  /** §9.18 per-ticket merchant context (plan, couriers, recent errors). */
  @Get('tickets/:ticketId/context')
  merchantContext(@Param('ticketId', ParseUUIDPipe) ticketId: string) {
    return this.tickets.merchantContext(ticketId);
  }

  /** §9.18 assignment (INV-22 version carried in the body). */
  @Post('tickets/:ticketId/assign')
  assign(
    @Req() req: AdminRequest,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: AssignTicketDto,
  ) {
    return this.tickets.assignTicket(req.adminId, ticketId, dto);
  }

  /**
   * §9.18 admin reply — sets first_response_at on the first ADMIN message
   * (RW-07) and emails the thread participants (§9.21 ticket.reply).
   */
  @Post('tickets/:ticketId/messages')
  reply(
    @Req() req: AdminRequest,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: TicketReplyDto,
  ) {
    return this.tickets.replyAsAdmin(req.adminId, ticketId, dto);
  }

  /** §3.16 explicit transitions: OPEN→IN_PROGRESS→RESOLVED→CLOSED. */
  @Post('tickets/:ticketId/transition')
  transition(
    @Req() req: AdminRequest,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: TransitionTicketDto,
  ) {
    return this.tickets.transitionTicket(req.adminId, ticketId, dto);
  }

  /** §9.18 canned replies — a code-constant store (see support.types.ts). */
  @Get('canned-replies')
  cannedReplies() {
    return CANNED_REPLIES;
  }

  /* --------------------------- Announcements -------------------------- */

  /** §9.19 composer (§3.29 audience, §3.31 type). Draft until published. */
  @Post('announcements')
  compose(@Req() req: AdminRequest, @Body() dto: ComposeAnnouncementDto) {
    return this.announcements.compose(req.adminId, dto);
  }

  @Get('announcements')
  listAnnouncements() {
    return this.announcements.listAll();
  }

  /** Publish; type WARNING also emails all Members (A2-09). */
  @Post('announcements/:announcementId/publish')
  publish(
    @Req() req: AdminRequest,
    @Param('announcementId', ParseUUIDPipe) announcementId: string,
  ) {
    return this.announcements.publish(req.adminId, announcementId);
  }

  @Post('announcements/:announcementId/expire')
  expire(
    @Req() req: AdminRequest,
    @Param('announcementId', ParseUUIDPipe) announcementId: string,
  ) {
    return this.announcements.expire(req.adminId, announcementId);
  }

  /* ----------------------------- Feedback ----------------------------- */

  /** §9.19 admin feedback list. */
  @Get('feedback')
  listFeedback() {
    return this.feedback.list();
  }

  /** §9.19 trends: average rating by week. */
  @Get('feedback/trends')
  feedbackTrends() {
    return this.feedback.trends();
  }
}
