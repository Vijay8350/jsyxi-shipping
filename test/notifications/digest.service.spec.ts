import { Pool } from 'pg';
import Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { DigestService } from '../../src/modules/notifications/digest.service';
import {
  DispatchInput,
  MessageDispatcherService,
} from '../../src/modules/notifications/message-dispatcher.service';
import { NotificationSettingsService } from '../../src/modules/notifications/notification-settings.service';
import { FakeRedis, MEMBER_ROWS, SHOP, routedQuery } from './helpers';

/** §9.21 digests: shop-local scheduling (§5.2) + S-42 frequency + recipients. */

function build(opts: {
  timezone?: string;
  digestFrequency?: string;
  ndrRecipients?: string[];
  channelSelection?: Record<string, unknown>;
}) {
  const redis = new FakeRedis();
  const query = routedQuery([
    [
      'FROM shop ',
      () => ({ rows: [{ shop_id: SHOP, iana_timezone: opts.timezone ?? 'Asia/Kolkata' }] }),
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
      'FROM ndr_settings',
      () => ({
        rows:
          opts.digestFrequency || opts.ndrRecipients
            ? [
                {
                  digest_frequency: opts.digestFrequency ?? 'daily',
                  recipients: opts.ndrRecipients ?? [],
                },
              ]
            : [],
      }),
    ],
    [
      'FROM shop_member',
      (sql: string, params: unknown[]) => {
        // Honour the digest recipient queries: filter by member ids or roles.
        if (sql.includes('member_id = ANY')) {
          const ids = params[1] as string[];
          return { rows: MEMBER_ROWS.filter((m) => ids.includes(m.member_id)) };
        }
        if (sql.includes('role = ANY')) {
          const roles = params[1] as string[];
          return { rows: MEMBER_ROWS.filter((m) => roles.includes(m.role)) };
        }
        if (sql.includes(`role = 'OWNER'`)) {
          return { rows: MEMBER_ROWS.filter((m) => m.role === 'OWNER') };
        }
        return { rows: MEMBER_ROWS };
      },
    ],
  ]);
  const pool = { query } as unknown as Pool;
  const dispatcher = {
    dispatch: vi.fn(async (_input: DispatchInput) => ({
      messageId: 'm',
      state: 'SENT' as const,
    })),
  };
  const service = new DigestService(
    pool,
    redis as unknown as Redis,
    dispatcher as unknown as MessageDispatcherService,
    new NotificationSettingsService(pool),
  );
  return { service, redis, dispatcher };
}

describe('DigestService (§9.21, §5.2 shop-local)', () => {
  it('localTime converts the tick into the shop timezone', () => {
    const { service } = build({});
    // 2026-08-05T04:00Z is 09:30 in Asia/Kolkata, 06:00 in Europe/Paris.
    const now = new Date('2026-08-05T04:00:00Z'); // a Wednesday
    expect(service.localTime('Asia/Kolkata', now)).toEqual({ hour: 9, monday: false });
    expect(service.localTime('Europe/Paris', now).hour).toBe(6);
    expect(service.localTime('Asia/Kolkata', new Date('2026-08-03T04:00:00Z')).monday).toBe(true);
  });

  it('sends the daily ops/finance digests at 09:00 shop-local, not before', async () => {
    const { service, redis, dispatcher } = build({});
    await redis.rpush(`notif:digest:${SHOP}:ops`, '[shipment.delayed] AWB 1 EDD+25h');
    await redis.rpush(`notif:digest:${SHOP}:finance`, '[cod.unassigned] order #1001');

    // 08:00 IST (02:30Z) → not yet.
    await service.runDigestTick(new Date('2026-08-05T02:30:00Z'));
    expect(dispatcher.dispatch).not.toHaveBeenCalled();

    // 09:00 IST (03:30Z) → due. Operator gets ops; Owner+Finance get finance.
    await service.runDigestTick(new Date('2026-08-05T03:30:00Z'));
    const calls = dispatcher.dispatch.mock.calls.map((c) => c[0]);
    const ops = calls.filter((c) => c.event === 'ops.digest');
    const finance = calls.filter((c) => c.event === 'finance.digest');
    expect(ops.map((c) => c.to)).toEqual(['ops@shop.example']);
    expect(finance.map((c) => c.to).sort()).toEqual([
      'fin@shop.example',
      'owner@shop.example',
    ]);
    expect(ops[0]!.body).toContain('AWB 1 EDD+25h');

    // Drained: a second tick at the same hour sends nothing.
    dispatcher.dispatch.mockClear();
    await service.runDigestTick(new Date('2026-08-05T03:30:00Z'));
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('NDR digest frequency hourly sends every tick (S-42)', async () => {
    const { service, redis, dispatcher } = build({ digestFrequency: 'hourly' });
    await redis.rpush(`notif:digest:${SHOP}:ndr`, 'AWB 9: CUSTOMER_REFUSED');

    await service.runDigestTick(new Date('2026-08-05T13:07:00Z')); // 18:37 IST
    const calls = dispatcher.dispatch.mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.event === 'ndr.digest')).toBe(true);
  });

  it('weekly NDR digest goes out Monday 09:00 shop-local only', async () => {
    const { service, redis, dispatcher } = build({ digestFrequency: 'weekly' });
    await redis.rpush(`notif:digest:${SHOP}:ndr`, 'AWB 9: CUSTOMER_REFUSED');

    // Wednesday 09:00 IST → nothing.
    await service.runDigestTick(new Date('2026-08-05T03:30:00Z'));
    expect(dispatcher.dispatch).not.toHaveBeenCalled();

    // Monday 09:00 IST (2026-08-10 is a Monday).
    await service.runDigestTick(new Date('2026-08-10T03:30:00Z'));
    expect(
      dispatcher.dispatch.mock.calls.map((c) => c[0]).some((c) => c.event === 'ndr.digest'),
    ).toBe(true);
  });

  it('S-41 recipients: explicit list wins; empty list falls back to the Owner', async () => {
    const explicit = build({ ndrRecipients: [MEMBER_ROWS[1].member_id] }); // the Operator
    await explicit.redis.rpush(`notif:digest:${SHOP}:ndr`, 'AWB 1');
    await explicit.service.runDigestTick(new Date('2026-08-05T03:30:00Z'));
    expect(
      explicit.dispatcher.dispatch.mock.calls.map((c) => c[0].to),
    ).toEqual(['ops@shop.example']);

    const fallback = build({}); // no ndr_settings row
    await fallback.redis.rpush(`notif:digest:${SHOP}:ndr`, 'AWB 1');
    await fallback.service.runDigestTick(new Date('2026-08-05T03:30:00Z'));
    expect(
      fallback.dispatcher.dispatch.mock.calls.map((c) => c[0].to),
    ).toEqual(['owner@shop.example']);
  });

  it('honours a per-shop digestHourLocal override', async () => {
    const { service, redis, dispatcher } = build({
      channelSelection: { digestHourLocal: 18 },
    });
    await redis.rpush(`notif:digest:${SHOP}:ops`, 'line');
    await service.runDigestTick(new Date('2026-08-05T03:30:00Z')); // 09:00 IST
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    await service.runDigestTick(new Date('2026-08-05T12:30:00Z')); // 18:00 IST
    expect(dispatcher.dispatch).toHaveBeenCalled();
  });
});
