import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { saltedPiiHash } from '../../common/crypto';
import { EnvelopeCipher } from '../../common/envelope';
import {
  ChannelNotConfiguredError,
  MessageSenderRegistry,
  UnapprovedTemplateError,
} from './message-sender';
import { NotificationSettingsService } from './notification-settings.service';
import { InAppService } from './in-app.service';
import { MessageChannel, MessageDeliveryState } from './notifications.types';

/**
 * ADD-25 dispatcher: every external send goes through here. One message_log
 * row per attempt, QUEUED → SENT/FAILED (DELIVERED/READ are provider-webhook
 * transitions, updated via markState when those land).
 *
 * Rules enforced at this single choke point:
 *  - INV-18: shop_message_channel credentials are decrypted HERE, at send
 *    time only, and never leave this method.
 *  - §5.7 control 4: the raw recipient address is used only to address the
 *    send; message_log.recipient_ref carries the salted hash.
 *  - ADD-26: SMS/WHATSAPP sends with a template require the template's
 *    external_approval_id — unapproved is REFUSED (UnapprovedTemplateError)
 *    and logged FAILED without any provider call.
 *  - §9.21: a suppressed (hard-bounced) address is never sent to again; the
 *    attempt is logged FAILED with reason SUPPRESSED.
 */

export interface DispatchInput {
  shopId: string;
  channel: MessageChannel;
  event: string;
  /** Raw address — never logged, never stored. */
  to: string;
  subject?: string;
  body: string;
  templateId?: string;
  shipmentId?: string;
  ndrCaseId?: string;
}

export interface DispatchResult {
  messageId: string;
  state: MessageDeliveryState;
  failureReason?: string;
}

interface ShopChannelRow {
  provider: string;
  credentials_encrypted: Buffer | null;
}

@Injectable()
export class MessageDispatcherService {
  private readonly logger = new Logger(MessageDispatcherService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
    private readonly registry: MessageSenderRegistry,
    private readonly settings: NotificationSettingsService,
    private readonly inApp: InAppService,
  ) {}

  private salt(): string {
    return this.config.get<string>('crypto.piiHashSalt') ?? '';
  }

  /** INV-18: the ONLY plaintext exit for channel credentials. */
  private decrypt(blob: Buffer): Record<string, string> {
    const hex = this.config.get<string>('crypto.masterKeyHex') ?? '';
    const cipher = EnvelopeCipher.fromHex(hex);
    return JSON.parse(cipher.decrypt(blob).toString('utf8')) as Record<string, string>;
  }

  private async fail(
    messageId: string,
    reason: string,
  ): Promise<DispatchResult> {
    await this.pool.query(
      `UPDATE message_log SET state = 'FAILED', failure_reason = $2
        WHERE message_id = $1`,
      [messageId, reason],
    );
    return { messageId, state: 'FAILED', failureReason: reason };
  }

  /** ADD-26's approval gate. Throws UnapprovedTemplateError — the caller
   *  records FAILED; nothing reaches a provider. Exported for direct tests. */
  async assertTemplateApproved(
    templateId: string,
    channel: MessageChannel,
  ): Promise<void> {
    if (channel === 'EMAIL') return; // in-house, approves implicitly (migration 0014)
    const result = await this.pool.query<{
      external_approval_id: string | null;
      is_active: boolean;
    }>(
      `SELECT external_approval_id, is_active
         FROM message_template WHERE template_id = $1`,
      [templateId],
    );
    const template = result.rows[0];
    if (!template || !template.is_active || !template.external_approval_id) {
      throw new UnapprovedTemplateError(templateId, channel);
    }
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const recipientHash = saltedPiiHash(this.salt(), input.to);

    // §9.21 hard-bounce suppression — the address is never sent to again.
    if (await this.settings.isSuppressed(input.shopId, recipientHash)) {
      const queued = await this.queue(input, recipientHash);
      return this.fail(queued, 'SUPPRESSED_HARD_BOUNCE');
    }

    // ADD-26: refuse unapproved SMS/WHATSAPP templates BEFORE any send.
    if (input.templateId) {
      try {
        await this.assertTemplateApproved(input.templateId, input.channel);
      } catch (err) {
        if (err instanceof UnapprovedTemplateError) {
          const queued = await this.queue(input, recipientHash);
          return this.fail(queued, 'TEMPLATE_UNAPPROVED');
        }
        throw err;
      }
    }

    const messageId = await this.queue(input, recipientHash);

    const channelRow = await this.pool.query<ShopChannelRow>(
      `SELECT provider, credentials_encrypted
         FROM shop_message_channel
        WHERE shop_id = $1 AND channel = $2 AND enabled = true`,
      [input.shopId, input.channel],
    );
    const configured = channelRow.rows[0] ?? null;

    const sender = configured
      ? this.registry.get(input.channel, configured.provider)
      : this.registry.defaultFor(input.channel);
    if (!sender) {
      return this.fail(
        messageId,
        new ChannelNotConfiguredError(input.shopId, input.channel).message,
      );
    }

    // INV-18: decrypt at send time, in this scope only.
    let credentials: Record<string, string> = {};
    if (configured?.credentials_encrypted) {
      try {
        credentials = this.decrypt(configured.credentials_encrypted);
      } catch {
        return this.fail(messageId, 'CREDENTIALS_UNAVAILABLE');
      }
    }

    const result = await sender.send(
      {
        channel: input.channel,
        to: input.to,
        subject: input.subject,
        body: input.body,
      },
      credentials,
    );

    if (!result.ok) {
      const failed = await this.fail(
        messageId,
        result.failureReason ?? 'PROVIDER_ERROR',
      );
      if (result.bounceType === 'HARD') {
        await this.handleHardBounce(input.shopId, recipientHash);
      }
      return failed;
    }

    await this.pool.query(
      `UPDATE message_log SET state = 'SENT', sent_at = now(), provider_ref = $2
        WHERE message_id = $1`,
      [messageId, result.providerRef ?? null],
    );
    return { messageId, state: 'SENT' };
  }

  /** §9.21: suppress the address and warn the Owner in-app. */
  private async handleHardBounce(
    shopId: string,
    recipientHash: string,
  ): Promise<void> {
    await this.settings.suppressAddress(shopId, recipientHash);
    const owner = await this.pool.query<{ member_id: string }>(
      `SELECT member_id FROM shop_member
        WHERE shop_id = $1 AND role = 'OWNER' AND revoked_at IS NULL`,
      [shopId],
    );
    if (owner.rows[0]) {
      await this.inApp.writeInApp(shopId, owner.rows[0].member_id, {
        subject: 'An email address was suppressed after a hard bounce',
        body: `A notification email hard-bounced (recipient ${recipientHash.slice(0, 12)}…). Further mail to that address is suppressed until the address is fixed.`,
      });
    }
  }

  private async queue(input: DispatchInput, recipientHash: string): Promise<string> {
    const result = await this.pool.query<{ message_id: string }>(
      `INSERT INTO message_log
         (shop_id, channel, event, template_id, recipient_ref, shipment_id,
          ndr_case_id, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'QUEUED')
       RETURNING message_id`,
      [
        input.shopId,
        input.channel,
        input.event,
        input.templateId ?? null,
        recipientHash,
        input.shipmentId ?? null,
        input.ndrCaseId ?? null,
      ],
    );
    return result.rows[0].message_id;
  }

  /** Provider-webhook transitions (SENT → DELIVERED/READ, or → FAILED).
   *  Bound by the module that owns the provider webhook; unit-tested here. */
  async markState(
    messageId: string,
    state: 'DELIVERED' | 'READ' | 'FAILED',
    failureReason?: string,
  ): Promise<void> {
    const column =
      state === 'DELIVERED' ? 'delivered_at' : state === 'READ' ? 'read_at' : null;
    if (column) {
      await this.pool.query(
        `UPDATE message_log
            SET state = $2, failure_reason = $3, ${column} = now()
          WHERE message_id = $1`,
        [messageId, state, failureReason ?? null],
      );
    } else {
      await this.pool.query(
        `UPDATE message_log SET state = $2, failure_reason = $3
          WHERE message_id = $1`,
        [messageId, state, failureReason ?? null],
      );
    }
  }
}
