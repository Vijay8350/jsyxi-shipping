import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { TrackTokenService } from '../track-page/track-token.service';
import { MessageDispatcherService } from './message-dispatcher.service';
import { NotificationSettingsService } from './notification-settings.service';
import { NdrTokenService } from './ndr-token.service';
import {
  BUYER_EVENTS,
  BuyerEvent,
  MessageChannel,
} from './notifications.types';

/**
 * ADD-26: templated buyer-facing notifications. Exported methods are the
 * triggers the parent binds:
 *
 *   onShipmentBooked      ← booking CONFIRMED (booking-worker.service.ts
 *                           confirm path, result.kind === 'CONFIRMED')
 *   onOutForDelivery      ← tracking reducer entering OUT_FOR_DELIVERY
 *   onUndeliveredAttempt  ← tracking reducer entering UNDELIVERED_ATTEMPT
 *                           (movement-reducer.service.ts, alongside the
 *                           onNdr seam) — carries the ADD-27 respond link
 *   onDelivered           ← tracking reducer entering DELIVERED
 *   onRtoInitiated        ← tracking reducer entering RTO_INITIATED
 *   sendCodConfirmationRequest ← ADD-28 (CodConfirmationService.start)
 *
 * Rules:
 *  - Per-event on/off per channel from notification_settings.channel_selection.
 *  - Templates come from message_template (shop override, else platform
 *    default); SMS/WHATSAPP sends are refused on unapproved templates by the
 *    dispatcher's ADD-26 gate — never sent.
 *  - The buyer's phone/email is used ONLY to address the send; message_log
 *    carries the salted hash (§5.7 control 4 — handled in the dispatcher).
 *  - INV-19: test shipments NEVER produce buyer-facing messages.
 *  - INV-21: fire-and-observe — these methods catch everything and return a
 *    summary; they never throw into the booking/tracking paths.
 */

interface ShipmentRow {
  shipment_id: string;
  is_test: boolean;
  awb_raw: string | null;
  shopify_order_number: string | null;
  snapshot: {
    recipient?: { phone?: string | null; email?: string | null } | null;
  } | null;
}

interface TemplateRow {
  template_id: string;
  body: string;
}

export interface BuyerSendSummary {
  shipmentId?: string;
  orderId?: string;
  attempted: number;
  sent: number;
  failed: number;
  skippedTest: boolean;
}

/** {{placeholder}} interpolation — unknown placeholders render empty. */
export function renderTemplate(
  body: string,
  vars: Record<string, string>,
): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) =>
    key in vars ? vars[key] : '',
  );
}

@Injectable()
export class BuyerNotificationService {
  private readonly logger = new Logger(BuyerNotificationService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly dispatcher: MessageDispatcherService,
    private readonly settings: NotificationSettingsService,
    private readonly trackTokens: TrackTokenService,
    private readonly ndrTokens: NdrTokenService,
  ) {}

  private async findTemplate(
    shopId: string,
    event: BuyerEvent,
    channel: MessageChannel,
  ): Promise<TemplateRow | null> {
    const result = await this.pool.query<TemplateRow>(
      `SELECT template_id, body FROM message_template
        WHERE (shop_id = $1 OR shop_id IS NULL)
          AND event = $2 AND channel = $3 AND is_active = true
        ORDER BY shop_id NULLS LAST
        LIMIT 1`,
      [shopId, event, channel],
    );
    return result.rows[0] ?? null;
  }

  private async loadShipment(
    shopId: string,
    shipmentId: string,
  ): Promise<ShipmentRow | null> {
    const result = await this.pool.query<ShipmentRow>(
      `SELECT s.shipment_id, s.is_test, s.awb_raw, s.snapshot,
              o.shopify_order_number
         FROM shipment s
         JOIN "order" o ON o.order_id = s.order_id
        WHERE s.shop_id = $1 AND s.shipment_id = $2`,
      [shopId, shipmentId],
    );
    return result.rows[0] ?? null;
  }

  private async sendForShipment(
    shopId: string,
    shipmentId: string,
    event: BuyerEvent,
    links: { track?: boolean; ndrCaseId?: string } = {},
  ): Promise<BuyerSendSummary> {
    const summary: BuyerSendSummary = {
      shipmentId,
      attempted: 0,
      sent: 0,
      failed: 0,
      skippedTest: false,
    };
    const shipment = await this.loadShipment(shopId, shipmentId);
    if (!shipment) return summary;
    if (shipment.is_test) {
      // INV-19: test shipments never produce customer-facing messages — and
      // no tokens/links are minted for them either.
      summary.skippedTest = true;
      return summary;
    }

    const vars: Record<string, string> = {
      orderNumber: shipment.shopify_order_number ?? '',
      awb: shipment.awb_raw ?? '',
    };
    if (links.track) {
      const link = await this.trackTokens.issue(shopId, shipmentId);
      vars['trackLink'] = link.url;
    }
    if (links.ndrCaseId) {
      const link = await this.ndrTokens.issue(shopId, links.ndrCaseId);
      vars['respondLink'] = link.url;
    }

    const channels = await this.settings.buyerChannels(shopId, event);

    for (const channel of ['EMAIL', 'SMS', 'WHATSAPP'] as const) {
      if (!channels[channel]) continue;
      const recipient = shipment.snapshot?.recipient;
      const to = channel === 'EMAIL' ? recipient?.email : recipient?.phone;
      if (!to) continue; // nothing to address — nothing to log
      const template = await this.findTemplate(shopId, event, channel);
      if (!template) continue; // no template for the channel: nothing to send
      summary.attempted += 1;
      const result = await this.dispatcher.dispatch({
        shopId,
        channel,
        event,
        to,
        body: renderTemplate(template.body, vars),
        templateId: template.template_id,
        shipmentId,
        ndrCaseId: links.ndrCaseId,
      });
      if (result.state === 'FAILED') summary.failed += 1;
      else summary.sent += 1;
    }
    return summary;
  }

  private async guard(fn: () => Promise<BuyerSendSummary>): Promise<BuyerSendSummary> {
    try {
      return await fn();
    } catch (err) {
      // INV-21: never throw into booking/tracking.
      this.logger.error(
        `buyer notification failed: ${err instanceof Error ? err.name : 'Error'}`,
      );
      return { attempted: 0, sent: 0, failed: 0, skippedTest: false };
    }
  }

  /** ADD-26 "shipped": AWB + the per-shipment track link (§9.16 path 1). */
  async onShipmentBooked(
    shopId: string,
    shipmentId: string,
  ): Promise<BuyerSendSummary> {
    return this.guard(() =>
      this.sendForShipment(shopId, shipmentId, BUYER_EVENTS.SHIPPED, {
        track: true,
      }),
    );
  }

  async onOutForDelivery(
    shopId: string,
    shipmentId: string,
  ): Promise<BuyerSendSummary> {
    return this.guard(() =>
      this.sendForShipment(shopId, shipmentId, BUYER_EVENTS.OUT_FOR_DELIVERY),
    );
  }

  /** ADD-26 NDR attempt — carries the ADD-27 buyer self-serve link. */
  async onUndeliveredAttempt(
    shopId: string,
    shipmentId: string,
    ndrCaseId: string,
  ): Promise<BuyerSendSummary> {
    return this.guard(() =>
      this.sendForShipment(shopId, shipmentId, BUYER_EVENTS.NDR_ATTEMPT, {
        ndrCaseId,
      }),
    );
  }

  async onDelivered(
    shopId: string,
    shipmentId: string,
  ): Promise<BuyerSendSummary> {
    return this.guard(() =>
      this.sendForShipment(shopId, shipmentId, BUYER_EVENTS.DELIVERED),
    );
  }

  async onRtoInitiated(
    shopId: string,
    shipmentId: string,
  ): Promise<BuyerSendSummary> {
    return this.guard(() =>
      this.sendForShipment(shopId, shipmentId, BUYER_EVENTS.RTO_INITIATED),
    );
  }

  /**
   * ADD-28: the COD confirmation request, addressed from the order's
   * recipient snapshot (RV-13) rather than a shipment (nothing is booked
   * yet — that is the point of the flow).
   */
  async sendCodConfirmationRequest(
    shopId: string,
    orderId: string,
    confirmLink: string,
  ): Promise<BuyerSendSummary> {
    return this.guard(async () => {
      const summary: BuyerSendSummary = {
        orderId,
        attempted: 0,
        sent: 0,
        failed: 0,
        skippedTest: false,
      };
      const order = await this.pool.query<{
        shopify_order_number: string | null;
        cod_outstanding: string | null;
        is_test_order: boolean;
        recipient_snapshot: {
          phone?: string | null;
          email?: string | null;
        } | null;
      }>(
        `SELECT shopify_order_number, cod_outstanding, is_test_order, recipient_snapshot
           FROM "order" WHERE shop_id = $1 AND order_id = $2`,
        [shopId, orderId],
      );
      const row = order.rows[0];
      if (!row) return summary;
      if (row.is_test_order) {
        summary.skippedTest = true; // INV-19
        return summary;
      }
      const channels = await this.settings.buyerChannels(
        shopId,
        BUYER_EVENTS.COD_CONFIRMATION_REQUEST,
      );
      const vars: Record<string, string> = {
        orderNumber: row.shopify_order_number ?? '',
        amount: row.cod_outstanding ?? '',
        confirmLink,
      };
      for (const channel of ['EMAIL', 'SMS', 'WHATSAPP'] as const) {
        if (!channels[channel]) continue;
        const to =
          channel === 'EMAIL'
            ? row.recipient_snapshot?.email
            : row.recipient_snapshot?.phone;
        if (!to) continue;
        const template = await this.findTemplate(
          shopId,
          BUYER_EVENTS.COD_CONFIRMATION_REQUEST,
          channel,
        );
        if (!template) continue;
        summary.attempted += 1;
        const result = await this.dispatcher.dispatch({
          shopId,
          channel,
          event: BUYER_EVENTS.COD_CONFIRMATION_REQUEST,
          to,
          body: renderTemplate(template.body, vars),
          templateId: template.template_id,
        });
        if (result.state === 'FAILED') summary.failed += 1;
        else summary.sent += 1;
      }
      return summary;
    });
  }
}
