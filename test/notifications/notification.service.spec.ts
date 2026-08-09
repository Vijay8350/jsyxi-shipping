import { Pool } from 'pg';
import Redis from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationService } from '../../src/modules/notifications/notification.service';
import { NotificationSettingsService } from '../../src/modules/notifications/notification-settings.service';
import { MessageDispatcherService } from '../../src/modules/notifications/message-dispatcher.service';
import { InAppService } from '../../src/modules/notifications/in-app.service';
import { ThrottleService } from '../../src/modules/notifications/throttle.service';
import { DigestService } from '../../src/modules/notifications/digest.service';
import {
  NOTIFICATION_EVENTS,
  NotifyContext,
} from '../../src/modules/notifications/notifications.types';
import {
  FakeRedis,
  FINANCE,
  MEMBER_ROWS,
  OPERATOR,
  OWNER,
  SHOP,
  routedQuery,
} from './helpers';

/**
 * The §9.21 matrix: recipients, channels, S-45 toggles, S-46 throttle and
 * the Owner fallback. Dispatcher / in-app / digest are spied so the test
 * reads WHO would receive WHAT over WHICH channel.
 */

const CTX: NotifyContext = { subject: 's', body: 'b' };

function build(members: unknown[] = MEMBER_ROWS, toggles: Record<string, boolean> = {}) {
  const query = routedQuery([
    ['FROM notification_settings', () => ({ rows: [{ event_toggles: toggles, channel_selection: {}, suppressed_addresses: [] }] })],
    ['FROM shop_member', () => ({ rows: members })],
  ]);
  const pool = { query } as unknown as Pool;
  const redis = new FakeRedis();
  const settings = new NotificationSettingsService(pool);
  const dispatcher = {
    dispatch: vi.fn(async () => ({ messageId: 'm', state: 'SENT' as const })),
  };
  const inApp = { writeInApp: vi.fn(async () => 'inapp-1') };
  const digests = { enqueue: vi.fn(async () => undefined) };
  const service = new NotificationService(
    pool,
    dispatcher as unknown as MessageDispatcherService,
    settings,
    inApp as unknown as InAppService,
    new ThrottleService(redis as unknown as Redis),
    digests as unknown as DigestService,
  );
  return { service, dispatcher, inApp, digests };
}

describe('NotificationService §9.21 matrix', () => {
  beforeEach(() => vi.clearAllMocks());

  it('courier.disconnected → Owner, email + in-app, S-46-throttled with a count', async () => {
    const { service, dispatcher, inApp } = build();

    const r1 = await service.notify(SHOP, NOTIFICATION_EVENTS.COURIER_DISCONNECTED, CTX);
    expect(r1.delivered).toBe(2); // in-app + email
    expect(inApp.writeInApp).toHaveBeenCalledWith(SHOP, OWNER, expect.anything());
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'EMAIL', event: 'courier.disconnected', to: 'owner@shop.example' }),
    );

    // Same event inside the hour → suppressed, counted.
    const r2 = await service.notify(SHOP, NOTIFICATION_EVENTS.COURIER_DISCONNECTED, CTX);
    expect(r2.suppressed).toBe(1);
    expect(r2.delivered).toBe(0);
  });

  it('booking.batch_complete → the actor in-app; email only when the actor is offline', async () => {
    const online = {
      ...MEMBER_ROWS[1],
      last_active_at: new Date().toISOString(),
    };
    const { service, dispatcher, inApp } = build([MEMBER_ROWS[0], online]);

    const r = await service.notify(SHOP, NOTIFICATION_EVENTS.BOOKING_BATCH_COMPLETE, {
      ...CTX,
      actorMemberId: OPERATOR,
    });
    expect(inApp.writeInApp).toHaveBeenCalledWith(SHOP, OPERATOR, expect.anything());
    expect(dispatcher.dispatch).not.toHaveBeenCalled(); // online → no email
    expect(r.delivered).toBe(1);
  });

  it('booking.batch_complete emails the actor when offline (stale last_active_at)', async () => {
    const offline = {
      ...MEMBER_ROWS[1],
      last_active_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    };
    const { service, dispatcher } = build([MEMBER_ROWS[0], offline]);

    await service.notify(SHOP, NOTIFICATION_EVENTS.BOOKING_BATCH_COMPLETE, {
      ...CTX,
      actorMemberId: OPERATOR,
    });
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ops@shop.example' }),
    );
  });

  it('recon.batch_disputed → Finance (not Owner, not Operator)', async () => {
    const { service, dispatcher, inApp } = build();
    await service.notify(SHOP, NOTIFICATION_EVENTS.RECON_BATCH_DISPUTED, CTX);
    expect(inApp.writeInApp).toHaveBeenCalledWith(SHOP, FINANCE, expect.anything());
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'fin@shop.example' }),
    );
  });

  it('role-absent recipient falls back to the Owner (§9.21 pass-3 (c))', async () => {
    const noFinance = MEMBER_ROWS.filter((m) => m.role !== 'FINANCE');
    const { service, inApp } = build(noFinance);
    await service.notify(SHOP, NOTIFICATION_EVENTS.RECON_BATCH_DISPUTED, CTX);
    expect(inApp.writeInApp).toHaveBeenCalledWith(SHOP, OWNER, expect.anything());
  });

  it('announcement → all Members in-app only; WARNING adds email', async () => {
    const { service, dispatcher, inApp } = build();
    await service.notify(SHOP, NOTIFICATION_EVENTS.ANNOUNCEMENT, {
      ...CTX,
      announcementType: 'INFO',
    });
    expect(inApp.writeInApp).toHaveBeenCalledTimes(3);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();

    await service.notify(SHOP, NOTIFICATION_EVENTS.ANNOUNCEMENT, {
      ...CTX,
      announcementType: 'WARNING',
    });
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(3); // everyone emailed
  });

  it('report.ready → only the requester, email with the expiring link', async () => {
    const { service, dispatcher, inApp } = build();
    await service.notify(SHOP, NOTIFICATION_EVENTS.REPORT_READY, {
      ...CTX,
      requesterMemberId: FINANCE,
      link: 'https://app.jsyxi.com/documents/d1/download?expires=1&signature=x',
    });
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'fin@shop.example',
        body: expect.stringContaining('signature=x'),
      }),
    );
    expect(inApp.writeInApp).not.toHaveBeenCalled();
  });

  it('ticket.reply → thread participants only, email + in-app', async () => {
    const { service, dispatcher, inApp } = build();
    await service.notify(SHOP, NOTIFICATION_EVENTS.TICKET_REPLY, {
      ...CTX,
      participantMemberIds: [OWNER, OPERATOR],
    });
    expect(inApp.writeInApp).toHaveBeenCalledTimes(2);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it('digest events accumulate instead of sending (S-42 / daily)', async () => {
    const { service, dispatcher, inApp, digests } = build();

    await service.notify(SHOP, NOTIFICATION_EVENTS.NDR_RECEIVED, {
      ...CTX,
      lines: ['AWB 1: CUSTOMER_REFUSED', 'AWB 2: UNCONTACTABLE'],
    });
    expect(digests.enqueue).toHaveBeenCalledTimes(2);
    expect(digests.enqueue).toHaveBeenCalledWith(SHOP, 'ndr', 'AWB 1: CUSTOMER_REFUSED');
    expect(dispatcher.dispatch).not.toHaveBeenCalled();

    await service.notify(SHOP, NOTIFICATION_EVENTS.SHIPMENT_DELAYED, CTX);
    expect(digests.enqueue).toHaveBeenCalledWith(SHOP, 'ops', expect.stringContaining('shipment.delayed'));
  });

  it('cod.unassigned → Owner + Finance in-app card immediately + daily digest line', async () => {
    const { service, inApp, digests } = build();
    await service.notify(SHOP, NOTIFICATION_EVENTS.COD_UNASSIGNED, CTX);
    expect(inApp.writeInApp).toHaveBeenCalledWith(SHOP, OWNER, expect.anything());
    expect(inApp.writeInApp).toHaveBeenCalledWith(SHOP, FINANCE, expect.anything());
    expect(digests.enqueue).toHaveBeenCalledWith(SHOP, 'finance', expect.any(String));
  });

  it('S-45 toggle off → the event is skipped entirely', async () => {
    const { service, dispatcher, inApp } = build(MEMBER_ROWS, {
      'courier.disconnected': false,
    });
    const r = await service.notify(SHOP, NOTIFICATION_EVENTS.COURIER_DISCONNECTED, CTX);
    expect(r.skipped).toBe(true);
    expect(inApp.writeInApp).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('INV-21: a downstream failure is swallowed and reported, never thrown', async () => {
    const { service, dispatcher } = build();
    dispatcher.dispatch.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.notify(SHOP, NOTIFICATION_EVENTS.ALLOWANCE_100, CTX),
    ).resolves.toBeDefined();
  });
});
