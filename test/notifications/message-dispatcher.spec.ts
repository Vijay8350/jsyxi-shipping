import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { EnvelopeCipher } from '../../src/common/envelope';
import { saltedPiiHash } from '../../src/common/crypto';
import {
  DevEmailSender,
  MessageSender,
  MessageSenderRegistry,
  OutboundMessage,
  SendResult,
  UnapprovedTemplateError,
} from '../../src/modules/notifications/message-sender';
import { MessageDispatcherService } from '../../src/modules/notifications/message-dispatcher.service';
import { NotificationSettingsService } from '../../src/modules/notifications/notification-settings.service';
import { InAppService } from '../../src/modules/notifications/in-app.service';
import {
  MASTER_KEY_HEX,
  OWNER,
  SALT,
  SHOP,
  fakeConfig,
  routedQuery,
} from './helpers';

/**
 * ADD-25: registry + delivery-log transitions + the ADD-26 approval gate +
 * §9.21 bounce suppression. The pool is a routed fake; message_log writes are
 * captured for assertion.
 */

class FakeSender implements MessageSender {
  readonly channel: 'EMAIL' | 'SMS' | 'WHATSAPP';
  readonly provider: string;
  calls: Array<{ message: OutboundMessage; credentials: Record<string, string> }> = [];
  result: SendResult = { ok: true, providerRef: 'prov-1' };

  constructor(channel: 'EMAIL' | 'SMS' | 'WHATSAPP', provider: string) {
    this.channel = channel;
    this.provider = provider;
  }

  async send(
    message: OutboundMessage,
    credentials: Record<string, string>,
  ): Promise<SendResult> {
    this.calls.push({ message, credentials });
    return this.result;
  }
}

function build(poolQuery: ReturnType<typeof routedQuery>, senders: MessageSender[]) {
  const registry = new MessageSenderRegistry([new DevEmailSender(fakeConfig() as never), ...senders]);
  const settings = new NotificationSettingsService({ query: poolQuery } as unknown as Pool);
  const inApp = new InAppService({ query: poolQuery } as unknown as Pool);
  const dispatcher = new MessageDispatcherService(
    { query: poolQuery } as unknown as Pool,
    fakeConfig() as never,
    registry,
    settings,
    inApp,
  );
  return { dispatcher, registry };
}

describe('MessageDispatcherService (ADD-25)', () => {
  it('writes QUEUED → SENT with the provider ref and a salted recipient hash', async () => {
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const sender = new FakeSender('EMAIL', 'postmark');
    const query = routedQuery([
      ['FROM notification_settings', () => ({ rows: [{ event_toggles: {}, channel_selection: {}, suppressed_addresses: [] }] })],
      ['FROM shop_message_channel', () => ({ rows: [{ provider: 'postmark', credentials_encrypted: null }] })],
      [
        'INSERT INTO message_log',
        (_sql: string, params: unknown[]) => {
          writes.push({ sql: _sql, params });
          return { rows: [{ message_id: 'msg-1' }] };
        },
      ],
      [
        'UPDATE message_log',
        (_sql: string, params: unknown[]) => {
          writes.push({ sql: _sql, params });
          return { rows: [], rowCount: 1 };
        },
      ],
    ]);
    const { dispatcher } = build(query, [sender]);

    const result = await dispatcher.dispatch({
      shopId: SHOP,
      channel: 'EMAIL',
      event: 'courier.disconnected',
      to: 'Owner@Shop.example',
      subject: 'Courier disconnected',
      body: 'Delhivery credentials failed',
    });

    expect(result).toEqual({ messageId: 'msg-1', state: 'SENT' });
    // QUEUED insert carried the salted hash, never the raw address (§5.7 c4).
    const insert = writes.find((w) => w.sql.includes('INSERT INTO message_log'));
    expect(insert?.params[4]).toBe(saltedPiiHash(SALT, 'Owner@Shop.example'));
    expect(JSON.stringify(insert?.params)).not.toContain('Owner@Shop.example');
    // SENT transition with provider ref.
    const update = writes.find((w) => w.sql.includes(`state = 'SENT'`));
    expect(update?.params).toEqual(['msg-1', 'prov-1']);
    expect(sender.calls).toHaveLength(1);
  });

  it('decrypts per-shop credentials at send time only (INV-18)', async () => {
    const cipher = EnvelopeCipher.fromHex(MASTER_KEY_HEX);
    const blob = cipher.encrypt(JSON.stringify({ apiKey: 'secret-key-1' }));
    const sender = new FakeSender('SMS', 'gupshup');
    const query = routedQuery([
      ['FROM notification_settings', () => ({ rows: [{ event_toggles: {}, channel_selection: {}, suppressed_addresses: [] }] })],
      ['FROM shop_message_channel', () => ({ rows: [{ provider: 'gupshup', credentials_encrypted: blob }] })],
      ['INSERT INTO message_log', () => ({ rows: [{ message_id: 'msg-2' }] })],
      ['UPDATE message_log', () => ({ rows: [], rowCount: 1 })],
    ]);
    const { dispatcher } = build(query, [sender]);

    await dispatcher.dispatch({
      shopId: SHOP,
      channel: 'SMS',
      event: 'shipment.shipped',
      to: '9876543210',
      body: 'hi',
      // no templateId — the approval gate is covered separately below
    });

    expect(sender.calls[0].credentials).toEqual({ apiKey: 'secret-key-1' });
  });

  it('falls back to the log-only dev EMAIL sender when no channel is configured', async () => {
    const query = routedQuery([
      ['FROM notification_settings', () => ({ rows: [{ event_toggles: {}, channel_selection: {}, suppressed_addresses: [] }] })],
      ['FROM shop_message_channel', () => ({ rows: [] })],
      ['INSERT INTO message_log', () => ({ rows: [{ message_id: 'msg-3' }] })],
      ['UPDATE message_log', () => ({ rows: [], rowCount: 1 })],
    ]);
    const { dispatcher } = build(query, []);

    const result = await dispatcher.dispatch({
      shopId: SHOP,
      channel: 'EMAIL',
      event: 'ticket.reply',
      to: 'a@b.c',
      body: 'reply',
    });
    expect(result.state).toBe('SENT');
  });

  it('marks FAILED when no sender exists for the channel (SMS without config)', async () => {
    const failures: unknown[][] = [];
    const query = routedQuery([
      ['FROM notification_settings', () => ({ rows: [{ event_toggles: {}, channel_selection: {}, suppressed_addresses: [] }] })],
      ['FROM shop_message_channel', () => ({ rows: [] })],
      ['INSERT INTO message_log', () => ({ rows: [{ message_id: 'msg-4' }] })],
      [
        'UPDATE message_log',
        (_sql: string, params: unknown[]) => {
          failures.push(params);
          return { rows: [], rowCount: 1 };
        },
      ],
    ]);
    const { dispatcher } = build(query, []);

    const result = await dispatcher.dispatch({
      shopId: SHOP,
      channel: 'SMS',
      event: 'shipment.shipped',
      to: '9876543210',
      body: 'hi',
    });
    expect(result.state).toBe('FAILED');
    expect(String(failures[0]?.[1])).toContain('no enabled SMS provider');
  });

  it('REFUSES an unapproved SMS template with a typed error — never sent (ADD-26)', async () => {
    const sender = new FakeSender('SMS', 'gupshup');
    const query = routedQuery([
      ['FROM notification_settings', () => ({ rows: [{ event_toggles: {}, channel_selection: {}, suppressed_addresses: [] }] })],
      // external_approval_id NULL → unapproved
      ['FROM message_template', () => ({ rows: [{ external_approval_id: null, is_active: true }] })],
      ['INSERT INTO message_log', () => ({ rows: [{ message_id: 'msg-5' }] })],
      ['UPDATE message_log', () => ({ rows: [], rowCount: 1 })],
    ]);
    const { dispatcher } = build(query, [sender]);

    await expect(
      dispatcher.assertTemplateApproved('tpl-1', 'SMS'),
    ).rejects.toBeInstanceOf(UnapprovedTemplateError);

    const result = await dispatcher.dispatch({
      shopId: SHOP,
      channel: 'SMS',
      event: 'shipment.shipped',
      to: '9876543210',
      body: 'hi',
      templateId: 'tpl-1',
    });
    expect(result.state).toBe('FAILED');
    expect(result.failureReason).toBe('TEMPLATE_UNAPPROVED');
    expect(sender.calls).toHaveLength(0); // never reached the provider
  });

  it('sends on an approved WHATSAPP template', async () => {
    const sender = new FakeSender('WHATSAPP', 'interakt');
    const query = routedQuery([
      ['FROM notification_settings', () => ({ rows: [{ event_toggles: {}, channel_selection: {}, suppressed_addresses: [] }] })],
      ['FROM message_template', () => ({ rows: [{ external_approval_id: 'meta-tpl-9', is_active: true }] })],
      ['INSERT INTO message_log', () => ({ rows: [{ message_id: 'msg-6' }] })],
      ['UPDATE message_log', () => ({ rows: [], rowCount: 1 })],
      ['FROM shop_message_channel', () => ({ rows: [{ provider: 'interakt', credentials_encrypted: null }] })],
    ]);
    const { dispatcher } = build(query, [sender]);

    const result = await dispatcher.dispatch({
      shopId: SHOP,
      channel: 'WHATSAPP',
      event: 'shipment.delivered',
      to: '9876543210',
      body: 'delivered',
      templateId: 'tpl-2',
    });
    expect(result.state).toBe('SENT');
    expect(sender.calls).toHaveLength(1);
  });

  it('suppresses a hard-bounced address, warns the Owner in-app, and never sends to it again (§9.21)', async () => {
    const sender = new FakeSender('EMAIL', 'postmark');
    sender.result = { ok: false, failureReason: 'hard bounce', bounceType: 'HARD' };
    const suppressed: string[] = [];
    const inAppRows: unknown[][] = [];
    const query = routedQuery([
      [
        'FROM notification_settings',
        () => ({ rows: [{ event_toggles: {}, channel_selection: {}, suppressed_addresses: suppressed }] }),
      ],
      [
        'ON CONFLICT (shop_id) DO UPDATE',
        (_sql: string, params: unknown[]) => {
          if (_sql.includes('suppressed_addresses')) suppressed.push(params[1] as string);
          return { rows: [], rowCount: 1 };
        },
      ],
      ['FROM shop_member', () => ({ rows: [{ member_id: OWNER }] })],
      [
        'INSERT INTO message_template',
        (_sql: string, params: unknown[]) => {
          inAppRows.push(params);
          return { rows: [{ template_id: 'tpl-inapp' }] };
        },
      ],
      ['FROM shop_message_channel', () => ({ rows: [{ provider: 'postmark', credentials_encrypted: null }] })],
      ['INSERT INTO message_log', () => ({ rows: [{ message_id: 'msg-7' }] })],
      ['UPDATE message_log', () => ({ rows: [], rowCount: 1 })],
    ]);
    const { dispatcher } = build(query, [sender]);

    const bounced = await dispatcher.dispatch({
      shopId: SHOP,
      channel: 'EMAIL',
      event: 'ticket.reply',
      to: 'dead@buyer.example',
      body: 'hi',
    });
    expect(bounced.state).toBe('FAILED');
    expect(suppressed).toEqual([saltedPiiHash(SALT, 'dead@buyer.example')]);
    expect(inAppRows).toHaveLength(1); // the Owner in-app warning

    // Second send to the same address: no provider call, logged SUPPRESSED.
    const again = await dispatcher.dispatch({
      shopId: SHOP,
      channel: 'EMAIL',
      event: 'ticket.reply',
      to: 'dead@buyer.example',
      body: 'hi again',
    });
    expect(again.state).toBe('FAILED');
    expect(again.failureReason).toBe('SUPPRESSED_HARD_BOUNCE');
    expect(sender.calls).toHaveLength(1); // only the first attempt
  });

  it('markState drives provider-webhook transitions SENT → DELIVERED/READ/FAILED', async () => {
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    const query = routedQuery([
      [
        'UPDATE message_log',
        (_sql: string, params: unknown[]) => {
          updates.push({ sql: _sql, params });
          return { rows: [], rowCount: 1 };
        },
      ],
    ]);
    const { dispatcher } = build(query, []);

    await dispatcher.markState('msg-9', 'DELIVERED');
    await dispatcher.markState('msg-9', 'READ');
    await dispatcher.markState('msg-9', 'FAILED', 'provider said no');

    expect(updates[0].sql).toContain('delivered_at = now()');
    expect(updates[1].sql).toContain('read_at = now()');
    expect(updates[2].params).toEqual(['msg-9', 'FAILED', 'provider said no']);
  });
});
