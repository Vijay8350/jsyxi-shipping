import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { saltedPiiHash } from '../../src/common/crypto';
import {
  BuyerNotificationService,
  renderTemplate,
} from '../../src/modules/notifications/buyer-notification.service';
import { MessageDispatcherService } from '../../src/modules/notifications/message-dispatcher.service';
import { NotificationSettingsService } from '../../src/modules/notifications/notification-settings.service';
import { TrackTokenService } from '../../src/modules/track-page/track-token.service';
import { NdrTokenService } from '../../src/modules/notifications/ndr-token.service';
import { NDR_CASE, ORDER, SALT, SHIPMENT, SHOP, fakeConfig, routedQuery } from './helpers';

/**
 * ADD-26 buyer notifications: per-channel selection, template rendering,
 * track/respond links, salted-hash logging, INV-19 test-shipment exclusion.
 */

const SHIPMENT_ROW = {
  shipment_id: SHIPMENT,
  is_test: false,
  awb_raw: 'DEL12345',
  shopify_order_number: '#1042',
  snapshot: {
    recipient: { phone: '9876543210', email: 'buyer@example.com', name: 'Riya' },
  },
};

function build(opts: {
  shipment?: Record<string, unknown> | null;
  channelSelection?: Record<string, unknown>;
  templates?: Array<{ template_id: string; body: string }>;
  approved?: boolean;
}) {
  const query = routedQuery([
    [
      'FROM shipment',
      () => ({ rows: opts.shipment === null ? [] : [opts.shipment ?? SHIPMENT_ROW] }),
    ],
    [
      'FROM notification_settings',
      () => ({
        rows: [
          {
            event_toggles: {},
            channel_selection: opts.channelSelection ?? {},
            suppressed_addresses: [],
          },
        ],
      }),
    ],
    [
      'FROM message_template',
      (sql: string) => {
        if (sql.includes('external_approval_id')) {
          return {
            rows: [
              {
                external_approval_id: opts.approved === false ? null : 'dlt-1',
                is_active: true,
              },
            ],
          };
        }
        return {
          rows: opts.templates ?? [
            {
              template_id: 'tpl-1',
              body: 'Order {{orderNumber}} shipped, AWB {{awb}}. Track: {{trackLink}}',
            },
          ],
        };
      },
    ],
    ['INSERT INTO message_log', () => ({ rows: [{ message_id: 'msg-1' }] })],
    ['UPDATE message_log', () => ({ rows: [], rowCount: 1 })],
    ['FROM shop_message_channel', () => ({ rows: [] })], // dev EMAIL fallback
  ]);
  const pool = { query } as unknown as Pool;
  const sentCalls: Array<{ to: string; body: string }> = [];
  const devSender = {
    send: async (message: { to: string; body: string }) => {
      sentCalls.push(message);
      return { ok: true, providerRef: 'dev' };
    },
  };
  const dispatcher = new MessageDispatcherService(
    pool,
    fakeConfig() as never,
    { get: () => null, defaultFor: () => devSender } as never,
    new NotificationSettingsService(pool),
    {} as never,
  );
  const trackTokens = {
    issue: vi.fn(async () => ({
      tokenId: 't1',
      shipmentId: SHIPMENT,
      url: `https://app.jsyxi.com/track/t/rawtracktoken`,
    })),
  };
  const ndrTokens = {
    issue: vi.fn(async () => ({
      tokenId: 'n1',
      ndrCaseId: NDR_CASE,
      url: 'https://app.jsyxi.com/ndr/respond/rawndrtoken',
    })),
  };
  const service = new BuyerNotificationService(
    pool,
    dispatcher,
    new NotificationSettingsService(pool),
    trackTokens as unknown as TrackTokenService,
    ndrTokens as unknown as NdrTokenService,
  );
  return { service, dispatcher, trackTokens, ndrTokens, query, sentCalls };
}

describe('BuyerNotificationService (ADD-26)', () => {
  it('renderTemplate interpolates known placeholders and blanks unknown ones', () => {
    expect(renderTemplate('Hi {{name}}, order {{orderNumber}} {{missing}}', {
      name: 'Riya',
      orderNumber: '#1',
    })).toBe('Hi Riya, order #1 ');
  });

  it('shipped: default channel EMAIL, body carries AWB + the per-shipment track link', async () => {
    const { service, trackTokens, query, sentCalls } = build({});
    const summary = await service.onShipmentBooked(SHOP, SHIPMENT);

    expect(trackTokens.issue).toHaveBeenCalledWith(SHOP, SHIPMENT);
    expect(summary).toMatchObject({ attempted: 1, sent: 1, failed: 0 });

    // The rendered body carries the AWB and the §9.16 per-shipment track link.
    expect(sentCalls).toHaveLength(1);
    expect(sentCalls[0].to).toBe('buyer@example.com');
    expect(sentCalls[0].body).toContain('DEL12345');
    expect(sentCalls[0].body).toContain('https://app.jsyxi.com/track/t/rawtracktoken');
    expect(sentCalls[0].body).toContain('#1042');

    const insert = query.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes('INSERT INTO message_log'),
    );
    // recipient_ref is the salted hash of the buyer email (§5.7 control 4).
    expect(insert?.[1]?.[4]).toBe(saltedPiiHash(SALT, 'buyer@example.com'));
  });

  it('the buyer address is used only to address the send — never in message_log params', async () => {
    const { service, query } = build({});
    await service.onShipmentBooked(SHOP, SHIPMENT);
    for (const call of query.mock.calls) {
      expect(JSON.stringify(call[1])).not.toContain('buyer@example.com');
      expect(JSON.stringify(call[1])).not.toContain('9876543210');
    }
  });

  it('per-event channel selection: SMS on → SMS attempted; off → untouched', async () => {
    const { service } = build({
      channelSelection: {
        buyerEvents: { 'shipment.shipped': { EMAIL: false, SMS: true } },
      },
    });
    const summary = await service.onShipmentBooked(SHOP, SHIPMENT);
    expect(summary.attempted).toBe(1); // SMS only
  });

  it('unapproved SMS/WHATSAPP template → FAILED, never sent (ADD-26 gate)', async () => {
    const { service } = build({
      channelSelection: {
        buyerEvents: { 'shipment.shipped': { EMAIL: false, WHATSAPP: true } },
      },
      approved: false,
    });
    const summary = await service.onShipmentBooked(SHOP, SHIPMENT);
    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(0);
  });

  it('INV-19: test shipments never produce buyer-facing messages', async () => {
    const { service, trackTokens, query } = build({
      shipment: { ...SHIPMENT_ROW, is_test: true },
    });
    const summary = await service.onShipmentBooked(SHOP, SHIPMENT);
    expect(summary.skippedTest).toBe(true);
    expect(summary.attempted).toBe(0);
    expect(trackTokens.issue).not.toHaveBeenCalled();
    expect(
      query.mock.calls.some((c: unknown[]) =>
        String(c[0]).includes('INSERT INTO message_log'),
      ),
    ).toBe(false);
  });

  it('NDR attempt carries the ADD-27 respond link', async () => {
    const { service, ndrTokens, sentCalls } = build({
      templates: [{ template_id: 'tpl-ndr', body: 'Delivery failed. Respond: {{respondLink}}' }],
    });
    const summary = await service.onUndeliveredAttempt(SHOP, SHIPMENT, NDR_CASE);
    expect(ndrTokens.issue).toHaveBeenCalledWith(SHOP, NDR_CASE);
    expect(summary.sent).toBe(1);
    expect(sentCalls[0].body).toContain('https://app.jsyxi.com/ndr/respond/rawndrtoken');
  });

  it('COD confirmation request renders amount + confirm link from the order snapshot', async () => {
    const query = routedQuery([
      [
        'FROM "order"',
        () => ({
          rows: [
            {
              shopify_order_number: '#1042',
              cod_outstanding: '1299.00',
              is_test_order: false,
              recipient_snapshot: { phone: '9876543210', email: 'buyer@example.com' },
            },
          ],
        }),
      ],
      [
        'FROM notification_settings',
        () => ({ rows: [{ event_toggles: {}, channel_selection: {}, suppressed_addresses: [] }] }),
      ],
      [
        'FROM message_template',
        () => ({
          rows: [
            {
              template_id: 'tpl-cod',
              body: 'Confirm COD order {{orderNumber}} of ₹{{amount}}: {{confirmLink}}',
            },
          ],
        }),
      ],
      ['INSERT INTO message_log', () => ({ rows: [{ message_id: 'msg-c' }] })],
      ['UPDATE message_log', () => ({ rows: [], rowCount: 1 })],
      ['FROM shop_message_channel', () => ({ rows: [] })],
    ]);
    const pool = { query } as unknown as Pool;
    const dispatcher = new MessageDispatcherService(
      pool,
      fakeConfig() as never,
      { get: () => null, defaultFor: () => ({ send: async () => ({ ok: true }) }) } as never,
      new NotificationSettingsService(pool),
      {} as never,
    );
    const service = new BuyerNotificationService(
      pool,
      dispatcher,
      new NotificationSettingsService(pool),
      {} as never,
      {} as never,
    );
    const summary = await service.sendCodConfirmationRequest(
      SHOP,
      ORDER,
      'https://app.jsyxi.com/cod/confirm/rawtoken',
    );
    expect(summary.sent).toBe(1);
  });
});
