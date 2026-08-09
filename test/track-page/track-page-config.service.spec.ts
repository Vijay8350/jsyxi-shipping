import { ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { TrackPageConfigService } from '../../src/modules/track-page/track-page-config.service';
import {
  TRACK_PAGE_CONFIG_DEFAULTS,
  TrackPageConfigRow,
} from '../../src/modules/track-page/track-page.types';
import { shopPublicRef, shopRefRedisKey } from '../../src/modules/track-page/shop-ref';
import { APP_URL, FakeRedis, MEMBER, SALT, SHOP, fakeConfig } from './helpers';

function defaultsRow(overrides: Partial<TrackPageConfigRow> = {}): TrackPageConfigRow {
  return {
    shop_id: SHOP,
    order_box_label: 'Order ID or AWB number',
    contact_box_label: 'Email or phone used on the order',
    theme: 'light',
    button_colour: '#0F6B6B',
    show_courier_name: true,
    show_item_summary: true,
    replace_tracking_link: false,
    logo_object_key: null,
    version: 1,
    created_at: '2026-07-29T00:00:00.000Z',
    updated_at: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('TrackPageConfigService (§7.6 S-31–S-37, S-49)', () => {
  let query: ReturnType<typeof vi.fn>;
  let redis: FakeRedis;
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: TrackPageConfigService;

  beforeEach(() => {
    query = vi.fn();
    redis = new FakeRedis();
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    service = new TrackPageConfigService(
      { query } as unknown as Pool,
      redis as never,
      fakeConfig() as never,
      audit as unknown as AuditService,
    );
  });

  it('creates the row with §7.6 defaults on first read', async () => {
    query.mockResolvedValueOnce({ rows: [defaultsRow()] });
    const view = await service.getOrCreate(SHOP);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO track_page_config');
    expect(sql).toContain('ON CONFLICT (shop_id) DO NOTHING');
    expect(params).toEqual([SHOP]);
    // Defaults exactly per §7.6: S-31/S-32 labels, S-33 light, S-34 petrol
    // teal, S-35/S-36 on, S-37 off, S-49 inherit.
    expect(view).toMatchObject({
      orderBoxLabel: 'Order ID or AWB number',
      contactBoxLabel: 'Email or phone used on the order',
      theme: 'light',
      buttonColour: '#0F6B6B',
      showCourierName: true,
      showItemSummary: true,
      replaceTrackingLink: false,
      logoObjectKey: null,
      version: 1,
    });
  });

  it('writes the shopPublicRef reverse map (never the shop_id in URLs)', async () => {
    query.mockResolvedValueOnce({ rows: [defaultsRow()] });
    await service.getOrCreate(SHOP);

    const ref = service.publicRef(SHOP);
    expect(ref).toMatch(/^[0-9a-f]{12}$/);
    expect(ref).toBe(shopPublicRef(SHOP, SALT));
    expect(await redis.get(shopRefRedisKey(ref))).toBe(SHOP);
    // Stable + non-sequential: same input same ref, different shop differs.
    expect(service.publicRef(SHOP)).toBe(ref);
    expect(service.publicRef('99999999-9999-9999-9999-999999999999')).not.toBe(ref);
    expect(service.hostedPageUrl(SHOP)).toBe(`${APP_URL}/track/${ref}`);
  });

  it('getForRender falls back to §7.6 defaults without writing', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const view = await service.getForRender(SHOP);
    expect(view).toMatchObject({ shopId: SHOP, version: 1, ...TRACK_PAGE_CONFIG_DEFAULTS });
    expect(query).toHaveBeenCalledTimes(1); // SELECT only
  });

  it('applies a patch, bumps the version and audits before/after (§12)', async () => {
    const updated = defaultsRow({ theme: 'dark', version: 2 });
    query
      .mockResolvedValueOnce({ rows: [] }) // getOrCreate insert (conflict)
      .mockResolvedValueOnce({ rows: [defaultsRow()] }) // getOrCreate select
      .mockResolvedValueOnce({ rows: [updated] }); // UPDATE ... RETURNING

    const view = await service.update(
      SHOP,
      { version: 1, theme: 'dark' },
      { memberId: MEMBER },
    );

    expect(view).toMatchObject({ theme: 'dark', version: 2 });
    const [sql, params] = query.mock.calls[2];
    expect(sql).toContain('UPDATE track_page_config');
    expect(sql).toContain('version = version + 1');
    expect(params).toEqual(['dark', SHOP, 1]);

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      shopId: SHOP,
      actorKind: 'MEMBER',
      actorId: MEMBER,
      action: 'settings.track-page.update',
      objectType: 'track_page_config',
      before: expect.objectContaining({ theme: 'light' }),
      after: expect.objectContaining({ theme: 'dark' }),
    });
  });

  it('rejects a version mismatch with 409 and the current row (INV-22)', async () => {
    query
      .mockResolvedValueOnce({ rows: [defaultsRow()] }) // getOrCreate (before)
      .mockResolvedValueOnce({ rows: [] }) // UPDATE matches no version-1 row
      .mockResolvedValueOnce({ rows: [defaultsRow({ version: 2 })] }); // current

    await expect(
      service.update(SHOP, { version: 1, theme: 'dark' }, { memberId: MEMBER }),
    ).rejects.toThrow(ConflictException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('validates S-34 colour and S-33 theme', async () => {
    await expect(
      service.update(SHOP, { version: 1, buttonColour: 'teal' }, { memberId: MEMBER }),
    ).rejects.toThrow(/#RRGGBB/);
    await expect(
      service.update(
        SHOP,
        { version: 1, theme: 'sepia' as never },
        { memberId: MEMBER },
      ),
    ).rejects.toThrow(/light.*dark/);
    expect(query).not.toHaveBeenCalled();
  });
});
