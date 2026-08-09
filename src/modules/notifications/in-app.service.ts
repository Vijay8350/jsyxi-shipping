import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { IN_APP_EVENT } from './notifications.types';

/**
 * The in-app inbox, within the briefed constraints: no in_app table exists
 * and migrations may not be added, so an in-app notification is a message_log
 * row with event = 'in_app' and provider_ref = the recipient member's uuid
 * (internal id, not PII — briefed DECISION). channel is 'EMAIL' only because
 * the message_channel enum has no IN_APP value; these rows are NEVER handed
 * to a sender. Since message_log has no body column, the rendered text lives
 * on a per-send message_template row (also event 'in_app') that the log row
 * references via template_id.
 *
 * State: the row is written directly as DELIVERED (writing it IS delivery);
 * markRead moves DELIVERED → READ (§9.21 message_delivery_state).
 */

export interface InAppItem {
  messageId: string;
  text: string;
  link: string | null;
  queuedAt: string;
  readAt: string | null;
}

@Injectable()
export class InAppService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async writeInApp(
    shopId: string,
    memberId: string,
    input: {
      subject: string;
      body: string;
      link?: string;
      shipmentId?: string;
      ndrCaseId?: string;
    },
  ): Promise<string> {
    const template = await this.pool.query<{ template_id: string }>(
      `INSERT INTO message_template (shop_id, event, channel, body, is_active)
       VALUES ($1, $2, 'EMAIL', $3, false)
       RETURNING template_id`,
      [shopId, IN_APP_EVENT, `${input.subject}\n\n${input.body}`],
    );
    const result = await this.pool.query<{ message_id: string }>(
      `INSERT INTO message_log
         (shop_id, channel, event, template_id, recipient_ref, shipment_id,
          ndr_case_id, state, provider_ref, sent_at, delivered_at)
       VALUES ($1, 'EMAIL', $2, $3, NULL, $4, $5, 'DELIVERED', $6, now(), now())
       RETURNING message_id`,
      [
        shopId,
        IN_APP_EVENT,
        template.rows[0].template_id,
        input.shipmentId ?? null,
        input.ndrCaseId ?? null,
        memberId,
      ],
    );
    return result.rows[0].message_id;
  }

  /** The member's inbox — their rows only (INV-1: shop-scoped AND member-scoped). */
  async listInApp(
    shopId: string,
    memberId: string,
    limit = 50,
  ): Promise<InAppItem[]> {
    const result = await this.pool.query<{
      message_id: string;
      body: string;
      queued_at: string;
      read_at: string | null;
    }>(
      `SELECT m.message_id, t.body, m.queued_at, m.read_at
         FROM message_log m
         JOIN message_template t ON t.template_id = m.template_id
        WHERE m.shop_id = $1 AND m.event = $2 AND m.provider_ref = $3
        ORDER BY m.queued_at DESC
        LIMIT $4`,
      [shopId, IN_APP_EVENT, memberId, limit],
    );
    return result.rows.map((row) => ({
      messageId: row.message_id,
      text: row.body,
      link: null,
      queuedAt: row.queued_at,
      readAt: row.read_at,
    }));
  }

  /** DELIVERED → READ; scoped so one member can never touch another's row. */
  async markRead(
    shopId: string,
    memberId: string,
    messageId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE message_log
          SET state = 'READ', read_at = now()
        WHERE shop_id = $1 AND message_id = $2 AND event = $3
          AND provider_ref = $4 AND state = 'DELIVERED'`,
      [shopId, messageId, IN_APP_EVENT, memberId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
