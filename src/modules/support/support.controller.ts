import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { SessionGuard, AuthenticatedRequest } from '../../auth/session.guard';
import { RequiresPermission } from '../team/rbac/requires-permission.decorator';
import { RolesGuard } from '../team/rbac/roles.guard';
import { AnnouncementService } from './announcement.service';
import { FeedbackService } from './feedback.service';
import {
  CreateTicketDto,
  SubmitFeedbackDto,
  TicketReplyDto,
} from './support.dto';
import { TicketService } from './ticket.service';
import { TicketAttachmentService } from './attachment.service';

/**
 * Merchant-side support endpoints (§9.18, §9.19). SessionGuard establishes
 * the (shop_id, member_id) identity (INV-1); §10.2 RW-25 grants
 * 'tickets.use' to all four roles, so every route carries it.
 */
@Controller('support')
@UseGuards(SessionGuard, RolesGuard)
export class SupportController {
  constructor(
    private readonly tickets: TicketService,
    private readonly announcements: AnnouncementService,
    private readonly feedback: FeedbackService,
    private readonly attachments: TicketAttachmentService,
  ) {}

  /* ---------------------------- Attachments -------------------------- */

  /**
   * §5.1 upload. Returns the {key, bytes} reference the ticket DTOs take, so
   * the client uploads first and then names the file on the message.
   */
  @Post('attachments')
  @RequiresPermission('tickets.use')
  uploadAttachment(
    @Req() req: AuthenticatedRequest,
    @Body() body: { filename?: string; dataBase64?: string },
  ) {
    return this.attachments.upload({
      // From the session, never the body (INV-1).
      shopId: req.session.shopId,
      filename: body?.filename ?? '',
      dataBase64: body?.dataBase64 ?? '',
    });
  }

  /** Read one back. The key is checked against this session's shop prefix. */
  @Get('attachments')
  @RequiresPermission('tickets.use')
  async downloadAttachment(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Query('key') key: string,
  ) {
    const file = await this.attachments.read(req.session.shopId, key ?? '');
    res.setHeader('Content-Type', file.contentType);
    // Never inline: an attacker-supplied file rendered in our origin would be
    // stored XSS, so it always downloads.
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(file.bytes);
  }

  /* ------------------------------ Tickets ---------------------------- */

  /** §9.18: raise a ticket (category/priority §3.16, TKT-{seq} per §13.5). */
  @Post('tickets')
  @RequiresPermission('tickets.use')
  createTicket(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateTicketDto,
  ) {
    return this.tickets.createTicket(req.session.shopId, req.session.memberId, dto);
  }

  @Get('tickets')
  @RequiresPermission('tickets.use')
  listTickets(@Req() req: AuthenticatedRequest) {
    return this.tickets.listTickets(req.session.shopId);
  }

  /** The threaded conversation (ticket_message), oldest first. */
  @Get('tickets/:ticketId')
  @RequiresPermission('tickets.use')
  getThread(
    @Req() req: AuthenticatedRequest,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
  ) {
    return this.tickets.getThread(req.session.shopId, ticketId);
  }

  /** §3.16: a MEMBER reply reopens RESOLVED → IN_PROGRESS; CLOSED is terminal. */
  @Post('tickets/:ticketId/messages')
  @RequiresPermission('tickets.use')
  reply(
    @Req() req: AuthenticatedRequest,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: TicketReplyDto,
  ) {
    return this.tickets.replyAsMember(
      req.session.shopId,
      req.session.memberId,
      ticketId,
      dto,
    );
  }

  /* --------------------------- Announcements -------------------------- */

  /** §9.19 Announcements section: everything visible to this shop. */
  @Get('announcements')
  @RequiresPermission('tickets.use')
  listAnnouncements(@Req() req: AuthenticatedRequest) {
    return this.announcements.listVisible(
      req.session.shopId,
      req.session.memberId,
    );
  }

  /** §9.19 unread badge on the bell. */
  @Get('announcements/unread-count')
  @RequiresPermission('tickets.use')
  unreadCount(@Req() req: AuthenticatedRequest) {
    return this.announcements.unreadCount(
      req.session.shopId,
      req.session.memberId,
    );
  }

  /** §9.19 dismissible banner: the latest undismissed announcement. */
  @Get('announcements/banner')
  @RequiresPermission('tickets.use')
  banner(@Req() req: AuthenticatedRequest) {
    return this.announcements.banner(req.session.shopId, req.session.memberId);
  }

  /** §9.19 dismissal is per Member (announcement_read). */
  @Post('announcements/:announcementId/dismiss')
  @RequiresPermission('tickets.use')
  dismiss(
    @Req() req: AuthenticatedRequest,
    @Param('announcementId', ParseUUIDPipe) announcementId: string,
  ) {
    return this.announcements.dismiss(
      req.session.shopId,
      req.session.memberId,
      announcementId,
    );
  }

  /* ----------------------------- Feedback ----------------------------- */

  /** §9.19 feedback widget: 1–5 rating, comment, optional screenshot. */
  @Post('feedback')
  @RequiresPermission('tickets.use')
  submitFeedback(
    @Req() req: AuthenticatedRequest,
    @Body() dto: SubmitFeedbackDto,
  ) {
    return this.feedback.submit(req.session.shopId, req.session.memberId, dto);
  }
}
