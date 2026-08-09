import { Pool } from 'pg';
import Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { tokenHash } from '../../src/common/crypto';
import { AuditService } from '../../src/audit/audit.service';
import {
  CodConfirmationService,
} from '../../src/modules/notifications/cod-confirmation.service';
import { BuyerNotificationService } from '../../src/modules/notifications/buyer-notification.service';
import { NotificationSettingsService } from '../../src/modules/notifications/notification-settings.service';
import { CodConfirmationBooker } from '../../src/modules/notifications/cod-booker-seam';
import { COD_CONFIRM_DEFAULT_WINDOW_MINUTES } from '../../src/modules/notifications/notifications.types';
import { FakeRedis, ORDER, SHOP, fakeConfig, routedQuery } from './helpers';

/**
 * ADD-28: COD confirmation lifecycle — start, confirm-before-expiry, and the
 * sweep's two expiry branches (book-anyway default / COD_UNCONFIRMED hold).
 */

function build(opts: {
  paymentMode?: string;
  channelSelection?: Record<string, unknown>;
  pending?: Array<Record<string, unknown>>;
  existingConfirmation?: boolean;
  booker?: CodConfirmationBooker;
}) {
  const buyer = {
    sendCodConfirmationRequest: vi.fn(async () => ({
      attempted: 1,
      sent: 1,
      failed: 0,
      skippedTest: false,
    })),
  };
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const query = routedQuery([
    [
      'SELECT payment_mode FROM "order"',
      () => ({ rows: [{ payment_mode: opts.paymentMode ?? 'COD' }] }),
    ],
    [
      'INSERT INTO cod_confirmation',
      (_sql: string, params: unknown[]) => {
        writes.push({ sql: _sql, params });
        return {
          rows: opts.existingConfirmation ? [] : [{ confirmation_id: 'conf-1' }],
          rowCount: opts.existingConfirmation ? 0 : 1,
        };
      },
    ],
    [
      'FROM cod_confirmation',
      () => ({ rows: opts.pending ?? [] }),
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
      'UPDATE cod_confirmation',
      (_sql: string, params: unknown[]) => {
        writes.push({ sql: _sql, params });
        return {
          rows: [{ confirmation_id: 'conf-1', shop_id: SHOP, order_id: ORDER }],
          rowCount: 1,
        };
      },
    ],
    [
      'UPDATE shipment',
      (_sql: string, params: unknown[]) => {
        writes.push({ sql: _sql, params });
        return { rows: [], rowCount: 1 };
      },
    ],
    ['INSERT INTO audit_log', () => ({ rows: [] })],
  ]);
  const pool = { query } as unknown as Pool;
  const booker = opts.booker ?? { bookAnyway: vi.fn(async () => undefined) };
  const service = new CodConfirmationService(
    pool,
    new FakeRedis() as unknown as Redis,
    fakeConfig() as never,
    new NotificationSettingsService(pool),
    buyer as unknown as BuyerNotificationService,
    new AuditService(pool),
    booker,
  );
  return { service, buyer, booker, writes, query };
}

describe('CodConfirmationService (ADD-28)', () => {
  it('start: creates the PENDING row with a hashed token and messages the buyer', async () => {
    const { service, buyer, writes } = build({});
    const id = await service.start(SHOP, ORDER);

    expect(id).toBe('conf-1');
    const insert = writes.find((w) => w.sql.includes('INSERT INTO cod_confirmation'));
    expect(insert?.params[0]).toBe(SHOP);
    expect(insert?.params[1]).toBe(ORDER);
    expect(String(insert?.params[2])).toMatch(/^[0-9a-f]{64}$/); // hash only
    // The buyer message carries the public confirm link.
    expect(buyer.sendCodConfirmationRequest).toHaveBeenCalledWith(
      SHOP,
      ORDER,
      expect.stringContaining('/cod/confirm/'),
    );
  });

  it('start is a no-op for prepaid orders and for orders that already have one', async () => {
    const prepaid = build({ paymentMode: 'PREPAID' });
    expect(await prepaid.service.start(SHOP, ORDER)).toBeNull();
    expect(prepaid.buyer.sendCodConfirmationRequest).not.toHaveBeenCalled();

    const existing = build({ existingConfirmation: true });
    expect(await existing.service.start(SHOP, ORDER)).toBeNull();
    expect(existing.buyer.sendCodConfirmationRequest).not.toHaveBeenCalled();
  });

  it('confirm before expiry marks CONFIRMED (token single-purpose)', async () => {
    const { service, writes } = build({});
    const result = await service.confirm('raw-token', '203.0.113.5');
    expect(result.ok).toBe(true);
    const update = writes.find((w) => w.sql.includes(`SET state = 'CONFIRMED'`));
    expect(update?.params[0]).toBe(tokenHash('raw-token'));
  });

  it('sweep, default branch: BOOK_ANYWAY calls the booking seam and settles EXPIRED_BOOKED', async () => {
    const created = new Date(Date.now() - 2 * 60 * 60_000).toISOString(); // 2h ago
    const { service, booker, writes } = build({
      pending: [
        {
          confirmation_id: 'conf-1',
          shop_id: SHOP,
          order_id: ORDER,
          created_at: created,
        },
      ],
    });

    const resolved = await service.sweepExpired(new Date());

    expect(resolved).toBe(1);
    expect(booker.bookAnyway).toHaveBeenCalledWith(SHOP, ORDER);
    expect(
      writes.some(
        (w) => w.sql.includes('UPDATE cod_confirmation') && w.params[1] === 'EXPIRED_BOOKED',
      ),
    ).toBe(true);
    // The default window really is 60 minutes (2h > 60m → expired).
    expect(COD_CONFIRM_DEFAULT_WINDOW_MINUTES).toBe(60);
  });

  it('sweep, HOLD branch: shipments held with COD_UNCONFIRMED, settled EXPIRED_HELD', async () => {
    const created = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const booker = { bookAnyway: vi.fn(async () => undefined) };
    const { service, writes } = build({
      channelSelection: { codConfirmation: { onExpiry: 'HOLD' } },
      pending: [
        {
          confirmation_id: 'conf-1',
          shop_id: SHOP,
          order_id: ORDER,
          created_at: created,
        },
      ],
      booker,
    });

    const resolved = await service.sweepExpired(new Date());

    expect(resolved).toBe(1);
    expect(booker.bookAnyway).not.toHaveBeenCalled();
    const hold = writes.find((w) => w.sql.includes('UPDATE shipment'));
    expect(hold?.sql).toContain(`'NEEDS_MANUAL_ASSIGNMENT'`);
    expect(hold?.sql).toContain(`'COD_UNCONFIRMED'`);
    expect(hold?.params).toEqual([SHOP, ORDER]);
    expect(
      writes.some(
        (w) => w.sql.includes('UPDATE cod_confirmation') && w.params[1] === 'EXPIRED_HELD',
      ),
    ).toBe(true);
  });

  it('sweep leaves unexpired and confirmed confirmations alone', async () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min ago
    const { service, booker, writes } = build({
      pending: [
        {
          confirmation_id: 'conf-2',
          shop_id: SHOP,
          order_id: ORDER,
          created_at: recent,
        },
      ],
    });

    const resolved = await service.sweepExpired(new Date());
    expect(resolved).toBe(0);
    expect(booker.bookAnyway).not.toHaveBeenCalled();
    expect(writes.filter((w) => w.sql.includes('UPDATE cod_confirmation'))).toHaveLength(0);
  });

  it('a per-shop window override is honoured (30 minutes)', async () => {
    const created = new Date(Date.now() - 45 * 60_000).toISOString(); // 45 min ago
    const { service, booker } = build({
      channelSelection: { codConfirmation: { windowMinutes: 30 } },
      pending: [
        {
          confirmation_id: 'conf-3',
          shop_id: SHOP,
          order_id: ORDER,
          created_at: created,
        },
      ],
    });

    // 45 min > 30 min override → expired, booked anyway.
    expect(await service.sweepExpired(new Date())).toBe(1);
    expect(booker.bookAnyway).toHaveBeenCalledWith(SHOP, ORDER);
  });
});
