import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnouncementService } from '../../src/modules/support/announcement.service';
import {
  ADMIN_ID,
  ANNOUNCEMENT_ID,
  MEMBER_B_ID,
  MEMBER_ID,
  mockPool,
  routeBySql,
  SHOP_B_ID,
  SHOP_ID,
} from './helpers';

function announcementRow(over: Record<string, unknown> = {}) {
  return {
    announcement_id: ANNOUNCEMENT_ID,
    title: 'Scheduled maintenance',
    body: 'Sunday 02:00–03:00 IST.',
    type: 'INFO',
    audience_kind: 'ALL',
    audience_ref: null,
    published_at: null,
    expires_at: null,
    created_at: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

describe('AnnouncementService (§9.19, §3.29)', () => {
  let pool: ReturnType<typeof mockPool>['pool'];
  let notifications: { notify: ReturnType<typeof vi.fn> };
  let service: AnnouncementService;

  beforeEach(() => {
    ({ pool } = mockPool());
    notifications = { notify: vi.fn().mockResolvedValue({ delivered: 1 }) };
    service = new AnnouncementService(pool as never, notifications as never);
  });

  describe('compose — the ALL ⇒ null audience_ref CHECK (§3.29)', () => {
    it('rejects audience_ref on ALL as a 400, never a 500 from the CHECK', async () => {
      await expect(
        service.compose(ADMIN_ID, {
          title: 't',
          body: 'b',
          type: 'INFO',
          audienceKind: 'ALL',
          audienceRef: { planCode: 'GROWTH' },
        }),
      ).rejects.toThrow(BadRequestException);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('BY_PLAN requires {planCode}', async () => {
      await expect(
        service.compose(ADMIN_ID, {
          title: 't',
          body: 'b',
          type: 'UPDATE',
          audienceKind: 'BY_PLAN',
          audienceRef: { shopIds: [SHOP_ID] },
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('SPECIFIC_SHOPS requires a non-empty {shopIds}', async () => {
      await expect(
        service.compose(ADMIN_ID, {
          title: 't',
          body: 'b',
          type: 'INFO',
          audienceKind: 'SPECIFIC_SHOPS',
          audienceRef: { shopIds: [] },
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('ALL with null ref stores a null audience_ref', async () => {
      routeBySql(pool.query, [
        ['INSERT INTO announcement', () => ({ rows: [announcementRow()] })],
      ]);
      const row = await service.compose(ADMIN_ID, {
        title: 't',
        body: 'b',
        type: 'INFO',
        audienceKind: 'ALL',
      });
      expect(row.audience_ref).toBeNull();
      const [, params] = pool.query.mock.calls[0];
      expect(params?.[4]).toBeNull();
    });
  });

  describe('publish — WARNING-only email rule (A2-09)', () => {
    it('WARNING notifies every targeted shop with announcementType WARNING', async () => {
      routeBySql(pool.query, [
        [
          'UPDATE announcement',
          () => ({
            rows: [
              announcementRow({
                type: 'WARNING',
                published_at: '2026-08-02T00:00:00.000Z',
              }),
            ],
          }),
        ],
        [
          'FROM shop WHERE uninstalled_at IS NULL',
          () => ({ rows: [{ shop_id: SHOP_ID }, { shop_id: SHOP_B_ID }] }),
        ],
      ]);
      await service.publish(ADMIN_ID, ANNOUNCEMENT_ID);
      expect(notifications.notify).toHaveBeenCalledTimes(2);
      expect(notifications.notify).toHaveBeenCalledWith(
        SHOP_ID,
        'announcement',
        expect.objectContaining({ announcementType: 'WARNING' }),
      );
      expect(notifications.notify).toHaveBeenCalledWith(
        SHOP_B_ID,
        'announcement',
        expect.objectContaining({ announcementType: 'WARNING' }),
      );
    });

    it('INFO still goes through the matrix (in-app only there) and a shop failure never gates (INV-21)', async () => {
      notifications.notify
        .mockRejectedValueOnce(new Error('redis down'))
        .mockResolvedValueOnce({ delivered: 1 });
      routeBySql(pool.query, [
        [
          'UPDATE announcement',
          () => ({
            rows: [
              announcementRow({
                type: 'INFO',
                published_at: '2026-08-02T00:00:00.000Z',
              }),
            ],
          }),
        ],
        [
          'FROM shop WHERE uninstalled_at IS NULL',
          () => ({ rows: [{ shop_id: SHOP_ID }, { shop_id: SHOP_B_ID }] }),
        ],
      ]);
      const row = await service.publish(ADMIN_ID, ANNOUNCEMENT_ID);
      expect(row.published_at).not.toBeNull();
      expect(notifications.notify).toHaveBeenCalledTimes(2);
      expect(notifications.notify).toHaveBeenCalledWith(
        SHOP_ID,
        'announcement',
        expect.objectContaining({ announcementType: 'INFO' }),
      );
    });
  });

  describe('audience resolution for publish (§3.29)', () => {
    it('BY_PLAN targets shops subscribed to the plan code', async () => {
      routeBySql(pool.query, [
        [
          'UPDATE announcement',
          () => ({
            rows: [
              announcementRow({
                audience_kind: 'BY_PLAN',
                audience_ref: { planCode: 'GROWTH' },
                published_at: '2026-08-02T00:00:00.000Z',
              }),
            ],
          }),
        ],
        [
          'FROM subscription s',
          (params) => {
            expect(params).toEqual(['GROWTH']);
            return { rows: [{ shop_id: SHOP_ID }] };
          },
        ],
      ]);
      await service.publish(ADMIN_ID, ANNOUNCEMENT_ID);
      expect(notifications.notify).toHaveBeenCalledTimes(1);
      expect(notifications.notify).toHaveBeenCalledWith(
        SHOP_ID,
        'announcement',
        expect.anything(),
      );
    });

    it('SPECIFIC_SHOPS targets exactly the listed shops', async () => {
      routeBySql(pool.query, [
        [
          'UPDATE announcement',
          () => ({
            rows: [
              announcementRow({
                audience_kind: 'SPECIFIC_SHOPS',
                audience_ref: { shopIds: [SHOP_B_ID] },
                published_at: '2026-08-02T00:00:00.000Z',
              }),
            ],
          }),
        ],
      ]);
      await service.publish(ADMIN_ID, ANNOUNCEMENT_ID);
      expect(notifications.notify).toHaveBeenCalledTimes(1);
      expect(notifications.notify).toHaveBeenCalledWith(
        SHOP_B_ID,
        'announcement',
        expect.anything(),
      );
    });
  });

  describe('merchant side — matching, unread, dismiss (§9.19)', () => {
    const VISIBLE_SQL = 'FROM announcement a';

    function routeVisible(rows: unknown[], planCode: string | null = 'GROWTH') {
      routeBySql(pool.query, [
        [VISIBLE_SQL, () => ({ rows })],
        ['FROM subscription s', () => ({ rows: planCode ? [{ code: planCode }] : [] })],
      ]);
    }

    it('listVisible resolves the shop plan code and matches audience in SQL', async () => {
      routeVisible([]);
      await service.listVisible(SHOP_ID, MEMBER_ID);
      const [sql, params] = pool.query.mock.calls.find(([s]) =>
        String(s).includes(VISIBLE_SQL),
      )!;
      // §3.29: ALL / BY_PLAN via plan code / SPECIFIC_SHOPS via shop list.
      expect(String(sql)).toContain("a.audience_kind = 'ALL'");
      expect(String(sql)).toContain("a.audience_ref ->> 'planCode' = $3");
      expect(String(sql)).toContain("a.audience_ref -> 'shopIds' ? $1");
      // Visibility window: published and not expired.
      expect(String(sql)).toContain('a.published_at <= now()');
      expect(String(sql)).toContain('a.expires_at IS NULL OR a.expires_at > now()');
      expect(params).toEqual([SHOP_ID, MEMBER_ID, 'GROWTH']);
    });

    it('unread badge counts visible rows with no announcement_read row', async () => {
      routeVisible([
        { announcement_id: 'a1', read_at: null, dismissed_at: null },
        { announcement_id: 'a2', read_at: '2026-08-02T00:00:00.000Z', dismissed_at: null },
        { announcement_id: 'a3', read_at: null, dismissed_at: '2026-08-02T00:00:00.000Z' },
      ]);
      await expect(service.unreadCount(SHOP_ID, MEMBER_ID)).resolves.toBe(2);
    });

    it('banner is the latest undismissed visible announcement', async () => {
      routeVisible([
        { announcement_id: 'a1', read_at: null, dismissed_at: null },
        { announcement_id: 'a2', read_at: null, dismissed_at: '2026-08-02T00:00:00.000Z' },
      ]);
      const banner = await service.banner(SHOP_ID, MEMBER_ID);
      expect(banner?.announcement_id).toBe('a1');
    });

    it('banner is null when everything is dismissed', async () => {
      routeVisible([
        { announcement_id: 'a2', read_at: null, dismissed_at: '2026-08-02T00:00:00.000Z' },
      ]);
      await expect(service.banner(SHOP_ID, MEMBER_ID)).resolves.toBeNull();
    });

    it('dismiss upserts the per-member announcement_read row', async () => {
      routeVisible([{ announcement_id: ANNOUNCEMENT_ID, read_at: null, dismissed_at: null }]);
      // The upsert is a second query shape — extend the routes.
      const upserts: unknown[][] = [];
      pool.query.mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO announcement_read')) {
          upserts.push(params ?? []);
          return { rows: [] };
        }
        if (sql.includes(VISIBLE_SQL)) {
          return {
            rows: [{ announcement_id: ANNOUNCEMENT_ID, read_at: null, dismissed_at: null }],
          };
        }
        if (sql.includes('FROM subscription s')) return { rows: [{ code: 'GROWTH' }] };
        throw new Error(`unmocked query: ${sql}`);
      });
      await service.dismiss(SHOP_ID, MEMBER_ID, ANNOUNCEMENT_ID);
      expect(upserts[0]).toEqual([ANNOUNCEMENT_ID, SHOP_ID, MEMBER_ID]);
    });

    it('dismissal is per member: another member keeps their own row state', async () => {
      // MEMBER_B has never read it; MEMBER dismissed it — visibility query is
      // keyed on the requesting member (r.member_id = $2).
      routeVisible([{ announcement_id: ANNOUNCEMENT_ID, read_at: null, dismissed_at: null }]);
      const visible = await service.listVisible(SHOP_ID, MEMBER_B_ID);
      expect(visible[0].dismissed_at).toBeNull();
      const [, params] = pool.query.mock.calls.find(([s]) =>
        String(s).includes(VISIBLE_SQL),
      )!;
      expect(params?.[1]).toBe(MEMBER_B_ID);
    });

    it('dismissing an announcement not visible to the shop is a 404 (INV-1)', async () => {
      routeVisible([]);
      await expect(
        service.dismiss(SHOP_ID, MEMBER_ID, ANNOUNCEMENT_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
