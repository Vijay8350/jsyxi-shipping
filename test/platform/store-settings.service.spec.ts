import { ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import {
  StoreSettingsRow,
  StoreSettingsService,
} from '../../src/modules/platform/settings/store-settings.service';

const SHOP = '11111111-1111-1111-1111-111111111111';
const MEMBER = '22222222-2222-2222-2222-222222222222';

function defaultsRow(overrides: Partial<StoreSettingsRow> = {}): StoreSettingsRow {
  return {
    shop_id: SHOP,
    language: 'en',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    decimal_separator: '.',
    decimal_digits: 2,
    weight_unit: 'kg',
    measurement_unit: 'cm',
    default_parcel_weight_kg: '0.500',
    version: 1,
    created_at: '2026-07-29T00:00:00.000Z',
    updated_at: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('StoreSettingsService', () => {
  let query: ReturnType<typeof vi.fn>;
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: StoreSettingsService;

  beforeEach(() => {
    query = vi.fn();
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    service = new StoreSettingsService(
      { query } as unknown as Pool,
      audit as unknown as AuditService,
    );
  });

  it('creates the row with §7.1 defaults on first read', async () => {
    query.mockResolvedValueOnce({ rows: [defaultsRow()] });
    const view = await service.getOrCreate(SHOP);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO store_settings');
    expect(sql).toContain('ON CONFLICT (shop_id) DO NOTHING');
    expect(params).toEqual([SHOP]);
    // Defaults exactly per §7.1 (S-1…S-7).
    expect(view).toMatchObject({
      language: 'en',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      decimalSeparator: '.',
      decimalDigits: 2,
      weightUnit: 'kg',
      measurementUnit: 'cm',
      defaultParcelWeightKg: '0.500',
      version: 1,
    });
  });

  it('returns the existing row when first-read insert hits the conflict', async () => {
    query
      .mockResolvedValueOnce({ rows: [] }) // ON CONFLICT DO NOTHING
      .mockResolvedValueOnce({ rows: [defaultsRow({ version: 3 })] });
    const view = await service.getOrCreate(SHOP);
    expect(view.version).toBe(3);
  });

  it('rejects any attempt to change currency (S-3 read-only, INV-2)', async () => {
    await expect(
      service.update(SHOP, { version: 1, currency: 'INR' }, { memberId: MEMBER }),
    ).rejects.toThrow(/read-only/);
    expect(query).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('applies a patch, bumps the version and audits before/after (§12)', async () => {
    const updated = defaultsRow({ timezone: 'Asia/Dubai', version: 2 });
    query
      .mockResolvedValueOnce({ rows: [] }) // getOrCreate insert
      .mockResolvedValueOnce({ rows: [defaultsRow()] }) // getOrCreate select
      .mockResolvedValueOnce({ rows: [updated] }); // UPDATE ... RETURNING

    const view = await service.update(
      SHOP,
      { version: 1, timezone: 'Asia/Dubai' },
      { memberId: MEMBER },
    );

    expect(view).toMatchObject({ timezone: 'Asia/Dubai', version: 2 });
    const [sql, params] = query.mock.calls[2];
    expect(sql).toContain('UPDATE store_settings');
    expect(sql).toContain('version = version + 1');
    expect(sql).toContain('AND version = $');
    expect(params).toContain('Asia/Dubai');
    expect(params[params.length - 2]).toBe(SHOP);
    expect(params[params.length - 1]).toBe(1);

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      shopId: SHOP,
      actorKind: 'MEMBER',
      actorId: MEMBER,
      action: 'settings.store.update',
      before: expect.objectContaining({ timezone: 'Asia/Kolkata' }),
      after: expect.objectContaining({ timezone: 'Asia/Dubai' }),
    });
  });

  it('rejects a version mismatch with 409 and the current row (INV-22)', async () => {
    const current = defaultsRow({ timezone: 'Asia/Dhaka', version: 2 });
    query
      .mockResolvedValueOnce({ rows: [] }) // getOrCreate insert
      .mockResolvedValueOnce({ rows: [defaultsRow()] }) // getOrCreate select
      .mockResolvedValueOnce({ rows: [] }) // UPDATE matched no row
      .mockResolvedValueOnce({ rows: [] }) // getOrCreate insert (conflict)
      .mockResolvedValueOnce({ rows: [current] }); // getOrCreate select

    const err = await service
      .update(SHOP, { version: 1, timezone: 'Asia/Dubai' }, { memberId: MEMBER })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    const response = (err as ConflictException).getResponse() as {
      current: unknown;
    };
    expect(response.current).toMatchObject({
      timezone: 'Asia/Dhaka',
      version: 2,
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects an invalid timezone (S-2)', async () => {
    await expect(
      service.update(
        SHOP,
        { version: 1, timezone: 'Not/AZone' },
        { memberId: MEMBER },
      ),
    ).rejects.toThrow(/IANA timezone/);
  });
});
