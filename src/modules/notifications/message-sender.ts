import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageChannel } from './notifications.types';

/**
 * ADD-25: the channel abstraction. One MessageSender per (channel, provider);
 * the registry resolves which sender handles a shop's configured provider
 * (shop_message_channel.provider). Senders are stateless — per-shop
 * credentials are decrypted at send time by MessageDispatcherService and
 * passed in (INV-18: never cached, never logged).
 */

export interface OutboundMessage {
  channel: MessageChannel;
  /** The recipient address (email / E.164 phone). Used ONLY to address the
   *  send — it must never appear in logs or message_log (§5.7 control 4). */
  to: string;
  subject?: string;
  body: string;
}

export interface SendResult {
  ok: boolean;
  providerRef?: string;
  failureReason?: string;
  /** Set when the provider classified a permanent failure — drives the
   *  §9.21 hard-bounce suppression list. */
  bounceType?: 'HARD' | 'SOFT';
}

export interface MessageSender {
  readonly channel: MessageChannel;
  readonly provider: string;
  send(
    message: OutboundMessage,
    credentials: Record<string, string>,
  ): Promise<SendResult>;
}

export const MESSAGE_SENDERS = Symbol('MESSAGE_SENDERS');

@Injectable()
export class MessageSenderRegistry {
  private readonly senders = new Map<string, MessageSender>();

  constructor(senders: MessageSender[]) {
    for (const sender of senders) {
      this.senders.set(`${sender.channel}:${sender.provider}`, sender);
    }
  }

  get(channel: MessageChannel, provider: string): MessageSender | null {
    return this.senders.get(`${channel}:${provider}`) ?? null;
  }

  /** Dev fallback: the log-only EMAIL provider, when a shop has no enabled
   *  EMAIL channel configured (development convenience — never SMS/WHATSAPP). */
  defaultFor(channel: MessageChannel): MessageSender | null {
    if (channel !== 'EMAIL') return null;
    return this.get('EMAIL', DevEmailSender.PROVIDER);
  }
}

/** The provider string of the log-only dev EMAIL sender. */
const DEV_EMAIL_PROVIDER = 'dev-log';

/**
 * ADD-25 dev provider: a log-only EMAIL sender so the full notification
 * pipeline runs with zero external accounts. §5.7 control 4 applies to logs
 * too — the recipient address is never logged; the body is logged only
 * outside production (template text may carry a buyer name).
 */
@Injectable()
export class DevEmailSender implements MessageSender {
  static readonly PROVIDER = DEV_EMAIL_PROVIDER;
  readonly channel = 'EMAIL' as const;
  readonly provider = DEV_EMAIL_PROVIDER;

  private readonly logger = new Logger(DevEmailSender.name);

  constructor(private readonly config: ConfigService) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const providerRef = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const isProd = this.config.get<string>('nodeEnv') === 'production';
    this.logger.log(
      isProd
        ? `email queued ref=${providerRef} subject=${JSON.stringify(message.subject ?? '')}`
        : `email ref=${providerRef} subject=${JSON.stringify(message.subject ?? '')} body=${JSON.stringify(message.body)}`,
    );
    return { ok: true, providerRef };
  }
}

/**
 * ADD-26 India compliance: SMS/WHATSAPP templates REQUIRE
 * external_approval_id (DLT template ID / Meta template name). A send on an
 * unapproved template is REFUSED with this typed error and never reaches a
 * provider.
 */
export class UnapprovedTemplateError extends Error {
  constructor(
    readonly templateId: string,
    readonly channel: MessageChannel,
  ) {
    super(
      `template ${templateId} on ${channel} has no external_approval_id — send refused (ADD-26)`,
    );
    this.name = 'UnapprovedTemplateError';
  }
}

/** No enabled provider row for the channel and no dev fallback applies. */
export class ChannelNotConfiguredError extends Error {
  constructor(
    readonly shopId: string,
    readonly channel: MessageChannel,
  ) {
    super(`shop ${shopId} has no enabled ${channel} provider`);
    this.name = 'ChannelNotConfiguredError';
  }
}
