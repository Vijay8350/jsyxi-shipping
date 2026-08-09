import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { NotificationService } from '../notifications/notification.service';
import { NOTIFICATION_EVENTS } from '../notifications/notifications.types';
import { normalizeAwb } from '../tracking/tracking.util';
import {
  AssignTicketDto,
  CreateTicketDto,
  TicketReplyDto,
  TransitionTicketDto,
} from './support.dto';
import {
  TicketMessageRow,
  TicketMetrics,
  TicketRow,
  TICKET_TRANSITIONS,
  TicketState,
  ticketMetrics,
} from './support.types';

export interface TicketInboxFilters {
  state?: TicketState;
  category?: string;
  priority?: string;
  assignedAdminId?: string;
}

/** §9.18 admin per-ticket merchant context (§10.3: never PII, never secrets). */
export interface MerchantContext {
  plan: { code: string; name: string; state: string } | null;
  couriers: Array<{
    courierAccountId: string;
    courierCode: string;
    courierName: string;
    mode: string;
    healthState: string;
    disabledAt: string | null;
  }>;
  recentErrors: {
    courierApi: Array<{ method: string; outcome: string; createdAt: string }>;
    dlq: Array<{ queue: string; error: string | null; failedAt: string }>;
  };
}

/**
 * Support tickets (§9.18, §3.16). All merchant-side queries are shop-scoped
 * (INV-1); "order" is a quoted identifier; every statement is parameterized.
 *
 * Numbering (§13.5, TKT-{seq} per Shop): the sequence is allocated inside
 * the create transaction under a `SELECT ... FOR UPDATE` on the shop row, so
 * concurrent raises can never draw the same number; the UNIQUE (shop_id,
 * number) index is the backstop.
 *
 * Notifications (§9.21 ticket.reply): fired after the write with the
 * thread's MEMBER participants; INV-21 — a notification failure never gates
 * the reply, and NotificationService.notify already swallows delivery
 * errors, so the extra catch here is belt-and-braces.
 */
@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly notifications: NotificationService,
  ) {}

  private async withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Merchant side (§9.18, §10.2 RW-25: all four roles may raise/reply)  */
  /* ------------------------------------------------------------------ */

  async createTicket(
    shopId: string,
    memberId: string,
    dto: CreateTicketDto,
  ): Promise<TicketRow> {
    if (dto.linkedOrderId) {
      const { rowCount } = await this.pool.query(
        `SELECT 1 FROM "order" WHERE order_id = $1 AND shop_id = $2`,
        [dto.linkedOrderId, shopId],
      );
      if (!rowCount) {
        throw new BadRequestException('linked order does not exist in this shop');
      }
    }
    let linkedAwb: string | null = null;
    if (dto.linkedAwb) {
      // F-19: normalization happens before any comparison.
      linkedAwb = normalizeAwb(dto.linkedAwb);
      const { rowCount } = await this.pool.query(
        `SELECT 1 FROM shipment WHERE shop_id = $1 AND awb_normalized = $2`,
        [shopId, linkedAwb],
      );
      if (!rowCount) {
        throw new BadRequestException('linked AWB does not resolve in this shop');
      }
    }

    return this.withTransaction(async (client) => {
      // §13.5: atomic per-shop sequence under the shop row lock.
      await client.query(`SELECT shop_id FROM shop WHERE shop_id = $1 FOR UPDATE`, [
        shopId,
      ]);
      const seq = await client.query<{ next_seq: string }>(
        `SELECT COALESCE(MAX(CAST(substring(number FROM 5) AS integer)), 0) + 1
                  AS next_seq
           FROM ticket WHERE shop_id = $1`,
        [shopId],
      );
      const number = `TKT-${seq.rows[0].next_seq}`;
      const inserted = await client.query<TicketRow>(
        `INSERT INTO ticket
           (shop_id, number, category, priority, subject,
            linked_order_id, linked_awb)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ticket_id, shop_id, number, category, priority, subject,
                   state, assigned_admin_id, linked_order_id, linked_awb,
                   created_at, first_response_at, resolved_at, version`,
        [
          shopId,
          number,
          dto.category,
          dto.priority ?? 'NORMAL', // §3.16 default (RW-17)
          dto.subject,
          dto.linkedOrderId ?? null,
          linkedAwb,
        ],
      );
      const ticket = inserted.rows[0];
      // The description opens the thread as the first MEMBER message.
      await client.query(
        `INSERT INTO ticket_message
           (ticket_id, author_kind, author_id, body, attachments)
         VALUES ($1, 'MEMBER', $2, $3, $4)`,
        [
          ticket.ticket_id,
          memberId,
          dto.description,
          JSON.stringify(dto.attachments ?? []),
        ],
      );
      return ticket;
    });
  }

  /** Merchant inbox: the shop's own tickets, newest first (INV-1). */
  async listTickets(shopId: string): Promise<Array<TicketRow & TicketMetrics>> {
    const { rows } = await this.pool.query<TicketRow>(
      `SELECT ticket_id, shop_id, number, category, priority, subject, state,
              assigned_admin_id, linked_order_id, linked_awb, created_at,
              first_response_at, resolved_at, version
         FROM ticket
        WHERE shop_id = $1
        ORDER BY created_at DESC`,
      [shopId],
    );
    return rows.map((row) => ({ ...row, ...ticketMetrics(row) }));
  }

  async getThread(
    shopId: string,
    ticketId: string,
  ): Promise<{ ticket: TicketRow & TicketMetrics; messages: TicketMessageRow[] }> {
    const ticket = await this.findShopTicket(shopId, ticketId);
    const { rows } = await this.pool.query<TicketMessageRow>(
      `SELECT message_id, ticket_id, author_kind, author_id, body,
              attachments, created_at
         FROM ticket_message
        WHERE ticket_id = $1
        ORDER BY created_at ASC`,
      [ticket.ticket_id],
    );
    return { ticket: { ...ticket, ...ticketMetrics(ticket) }, messages: rows };
  }

  /**
   * Member reply. §3.16: a new MEMBER message on a RESOLVED ticket reopens
   * it to IN_PROGRESS; CLOSED is terminal — "CLOSED requires a new ticket".
   */
  async replyAsMember(
    shopId: string,
    memberId: string,
    ticketId: string,
    dto: TicketReplyDto,
  ): Promise<{ ticket: TicketRow; message: TicketMessageRow }> {
    const existing = await this.findShopTicket(shopId, ticketId);
    if (existing.state === 'CLOSED') {
      throw new ConflictException(
        'ticket is CLOSED (terminal) — raise a new ticket (§3.16)',
      );
    }
    const result = await this.withTransaction(async (client) => {
      const message = await this.insertMessage(
        client,
        existing.ticket_id,
        'MEMBER',
        memberId,
        dto,
      );
      let ticket = existing;
      if (existing.state === 'RESOLVED') {
        const reopened = await client.query<TicketRow>(
          `UPDATE ticket
              SET state = 'IN_PROGRESS', resolved_at = NULL,
                  version = version + 1
            WHERE ticket_id = $1 AND state = 'RESOLVED'
            RETURNING ticket_id, shop_id, number, category, priority, subject,
                      state, assigned_admin_id, linked_order_id, linked_awb,
                      created_at, first_response_at, resolved_at, version`,
          [existing.ticket_id],
        );
        ticket = reopened.rows[0] ?? existing;
      }
      return { ticket, message };
    });
    await this.notifyParticipants(result.ticket, memberId, dto.body);
    return result;
  }

  /* ------------------------------------------------------------------ */
  /* Admin side (§9.18) — ticket rows are reached by id, not shop-scoped */
  /* ------------------------------------------------------------------ */

  async listInbox(
    filters: TicketInboxFilters,
  ): Promise<Array<TicketRow & TicketMetrics>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.state) {
      params.push(filters.state);
      where.push(`state = $${params.length}`);
    }
    if (filters.category) {
      params.push(filters.category);
      where.push(`category = $${params.length}`);
    }
    if (filters.priority) {
      params.push(filters.priority);
      where.push(`priority = $${params.length}`);
    }
    if (filters.assignedAdminId) {
      params.push(filters.assignedAdminId);
      where.push(`assigned_admin_id = $${params.length}`);
    }
    const { rows } = await this.pool.query<TicketRow>(
      `SELECT ticket_id, shop_id, number, category, priority, subject, state,
              assigned_admin_id, linked_order_id, linked_awb, created_at,
              first_response_at, resolved_at, version
         FROM ticket
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC`,
      params,
    );
    return rows.map((row) => ({ ...row, ...ticketMetrics(row) }));
  }

  /** §9.18 assignment; INV-22 version check, 409 carries the current state. */
  async assignTicket(
    adminId: string,
    ticketId: string,
    dto: AssignTicketDto,
  ): Promise<TicketRow> {
    const { rows } = await this.pool.query<TicketRow>(
      `UPDATE ticket
          SET assigned_admin_id = $3, version = version + 1
        WHERE ticket_id = $1 AND version = $2
        RETURNING ticket_id, shop_id, number, category, priority, subject,
                  state, assigned_admin_id, linked_order_id, linked_awb,
                  created_at, first_response_at, resolved_at, version`,
      [ticketId, dto.version, dto.assignedAdminId],
    );
    if (!rows[0]) await this.conflictOrMissing(ticketId);
    return rows[0];
  }

  /**
   * Admin reply. RW-07: first_response_at is set on the FIRST ADMIN message.
   * A reply to an OPEN ticket starts work (OPEN → IN_PROGRESS); RESOLVED and
   * IN_PROGRESS are unchanged by an admin message (§3.16 reopen is member-
   * driven). CLOSED stays terminal.
   */
  async replyAsAdmin(
    adminId: string,
    ticketId: string,
    dto: TicketReplyDto,
  ): Promise<{ ticket: TicketRow; message: TicketMessageRow }> {
    const existing = await this.findTicket(ticketId);
    if (existing.state === 'CLOSED') {
      throw new ConflictException(
        'ticket is CLOSED (terminal) — raise a new ticket (§3.16)',
      );
    }
    const result = await this.withTransaction(async (client) => {
      const message = await this.insertMessage(
        client,
        existing.ticket_id,
        'ADMIN',
        adminId,
        dto,
      );
      const updated = await client.query<TicketRow>(
        `UPDATE ticket
            SET first_response_at = COALESCE(first_response_at, now()),
                state = CASE WHEN state = 'OPEN' THEN 'IN_PROGRESS'::ticket_state
                             ELSE state END,
                version = version + 1
          WHERE ticket_id = $1
          RETURNING ticket_id, shop_id, number, category, priority, subject,
                    state, assigned_admin_id, linked_order_id, linked_awb,
                    created_at, first_response_at, resolved_at, version`,
        [existing.ticket_id],
      );
      return { ticket: updated.rows[0], message };
    });
    await this.notifyParticipants(result.ticket, null, dto.body);
    return result;
  }

  /**
   * §3.16 explicit admin transition (OPEN → IN_PROGRESS → RESOLVED → CLOSED;
   * RESOLVED sets resolved_at, which RW-07 resolution time is measured
   * from). INV-22: the writer's read version is required.
   */
  async transitionTicket(
    adminId: string,
    ticketId: string,
    dto: TransitionTicketDto,
  ): Promise<TicketRow> {
    const current = await this.findTicket(ticketId);
    if (!(TICKET_TRANSITIONS[current.state] as readonly string[]).includes(dto.to)) {
      throw new BadRequestException(
        `illegal ticket transition ${current.state} → ${dto.to} (§3.16)`,
      );
    }
    const { rows } = await this.pool.query<TicketRow>(
      `UPDATE ticket
          SET state = $3,
              resolved_at = CASE WHEN $3 = 'RESOLVED' THEN now()
                                 ELSE resolved_at END,
              version = version + 1
        WHERE ticket_id = $1 AND version = $2 AND state = $4
        RETURNING ticket_id, shop_id, number, category, priority, subject,
                  state, assigned_admin_id, linked_order_id, linked_awb,
                  created_at, first_response_at, resolved_at, version`,
      [ticketId, dto.version, dto.to, current.state],
    );
    if (!rows[0]) await this.conflictOrMissing(ticketId);
    return rows[0];
  }

  /**
   * §9.18 response-time metrics over the (optionally filtered) inbox, in
   * calendar hours (RW-07). Unresponded tickets count in `open` but not in
   * the first-response average; unresolved likewise for resolution.
   */
  async metrics(filters: TicketInboxFilters): Promise<{
    total: number;
    byState: Record<string, number>;
    avgFirstResponseHours: number | null;
    avgResolutionHours: number | null;
  }> {
    const rows = await this.listInbox(filters);
    const byState: Record<string, number> = {};
    let frSum = 0;
    let frCount = 0;
    let resSum = 0;
    let resCount = 0;
    for (const row of rows) {
      byState[row.state] = (byState[row.state] ?? 0) + 1;
      if (row.firstResponseHours !== null) {
        frSum += row.firstResponseHours;
        frCount += 1;
      }
      if (row.resolutionHours !== null) {
        resSum += row.resolutionHours;
        resCount += 1;
      }
    }
    return {
      total: rows.length,
      byState,
      avgFirstResponseHours: frCount ? frSum / frCount : null,
      avgResolutionHours: resCount ? resSum / resCount : null,
    };
  }

  /**
   * §9.18 per-ticket merchant context: plan, couriers, recent errors —
   * assembled from subscription/plan, courier_account/courier,
   * courier_api_call and dlq_item. §10.3: masked summaries only, never
   * credentials, never PII.
   */
  async merchantContext(ticketId: string): Promise<MerchantContext> {
    const ticket = await this.findTicket(ticketId);
    const shopId = ticket.shop_id;

    const plan = await this.pool.query<{
      code: string;
      name: string;
      state: string;
    }>(
      `SELECT p.code, p.name, s.state
         FROM subscription s
         JOIN plan p ON p.plan_id = s.plan_id
        WHERE s.shop_id = $1
        ORDER BY s.created_at DESC
        LIMIT 1`,
      [shopId],
    );

    const couriers = await this.pool.query<{
      courier_account_id: string;
      code: string;
      name: string;
      mode: string;
      health_state: string;
      disabled_at: string | null;
    }>(
      `SELECT ca.courier_account_id, c.code, c.name, ca.mode, ca.health_state,
              ca.disabled_at
         FROM courier_account ca
         JOIN courier c ON c.courier_id = ca.courier_id
        WHERE ca.shop_id = $1
        ORDER BY ca.created_at ASC`,
      [shopId],
    );

    const apiErrors = await this.pool.query<{
      method: string;
      outcome: string;
      created_at: string;
    }>(
      `SELECT method, outcome, created_at
         FROM courier_api_call
        WHERE shop_id = $1 AND outcome IN ('FAILED', 'TIMEOUT')
        ORDER BY created_at DESC
        LIMIT 10`,
      [shopId],
    );

    const dlq = await this.pool.query<{
      queue: string;
      error: string | null;
      failed_at: string;
    }>(
      `SELECT queue, error, failed_at
         FROM dlq_item
        WHERE shop_id = $1 AND replayed_at IS NULL
        ORDER BY failed_at DESC
        LIMIT 10`,
      [shopId],
    );

    return {
      plan: plan.rows[0] ?? null,
      couriers: couriers.rows.map((r) => ({
        courierAccountId: r.courier_account_id,
        courierCode: r.code,
        courierName: r.name,
        mode: r.mode,
        healthState: r.health_state,
        disabledAt: r.disabled_at,
      })),
      recentErrors: {
        courierApi: apiErrors.rows.map((r) => ({
          method: r.method,
          outcome: r.outcome,
          createdAt: r.created_at,
        })),
        dlq: dlq.rows.map((r) => ({
          queue: r.queue,
          error: r.error,
          failedAt: r.failed_at,
        })),
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private async findTicket(ticketId: string): Promise<TicketRow> {
    const { rows } = await this.pool.query<TicketRow>(
      `SELECT ticket_id, shop_id, number, category, priority, subject, state,
              assigned_admin_id, linked_order_id, linked_awb, created_at,
              first_response_at, resolved_at, version
         FROM ticket WHERE ticket_id = $1`,
      [ticketId],
    );
    if (!rows[0]) throw new NotFoundException('ticket not found');
    return rows[0];
  }

  /** INV-1: merchant access is always through (shop_id, ticket_id). */
  private async findShopTicket(
    shopId: string,
    ticketId: string,
  ): Promise<TicketRow> {
    const { rows } = await this.pool.query<TicketRow>(
      `SELECT ticket_id, shop_id, number, category, priority, subject, state,
              assigned_admin_id, linked_order_id, linked_awb, created_at,
              first_response_at, resolved_at, version
         FROM ticket WHERE ticket_id = $1 AND shop_id = $2`,
      [ticketId, shopId],
    );
    if (!rows[0]) throw new NotFoundException('ticket not found');
    return rows[0];
  }

  private async insertMessage(
    client: PoolClient,
    ticketId: string,
    authorKind: 'MEMBER' | 'ADMIN',
    authorId: string,
    dto: TicketReplyDto,
  ): Promise<TicketMessageRow> {
    const { rows } = await client.query<TicketMessageRow>(
      `INSERT INTO ticket_message
         (ticket_id, author_kind, author_id, body, attachments)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING message_id, ticket_id, author_kind, author_id, body,
                 attachments, created_at`,
      [
        ticketId,
        authorKind,
        authorId,
        dto.body,
        JSON.stringify(dto.attachments ?? []),
      ],
    );
    return rows[0];
  }

  /**
   * §9.21 ticket.reply → thread participants (the distinct MEMBER authors on
   * the thread), minus the member who just replied. INV-21: never gates.
   */
  private async notifyParticipants(
    ticket: TicketRow,
    excludeMemberId: string | null,
    body: string,
  ): Promise<void> {
    try {
      const { rows } = await this.pool.query<{ author_id: string }>(
        `SELECT DISTINCT author_id
           FROM ticket_message
          WHERE ticket_id = $1 AND author_kind = 'MEMBER'`,
        [ticket.ticket_id],
      );
      const participantMemberIds = rows
        .map((r) => r.author_id)
        .filter((id) => id !== excludeMemberId);
      if (participantMemberIds.length === 0) return;
      await this.notifications.notify(
        ticket.shop_id,
        NOTIFICATION_EVENTS.TICKET_REPLY,
        {
          participantMemberIds,
          subject: `Re: ${ticket.number} — ${ticket.subject}`,
          body,
          link: `/support/tickets/${ticket.ticket_id}`,
        },
      );
    } catch (err) {
      // INV-21 — log the class only, never the payload (§5.7 control 4).
      this.logger.error(
        `ticket.reply notify failed: ${err instanceof Error ? err.name : 'Error'}`,
      );
    }
  }

  /** INV-22: 409 with the current state so the writer refreshes (§6). */
  private async conflictOrMissing(ticketId: string): Promise<never> {
    const { rows } = await this.pool.query<TicketRow>(
      `SELECT ticket_id, shop_id, number, category, priority, subject, state,
              assigned_admin_id, linked_order_id, linked_awb, created_at,
              first_response_at, resolved_at, version
         FROM ticket WHERE ticket_id = $1`,
      [ticketId],
    );
    if (!rows[0]) throw new NotFoundException('ticket not found');
    throw new ConflictException({
      message: 'version mismatch (INV-22)',
      current: rows[0],
    });
  }
}
