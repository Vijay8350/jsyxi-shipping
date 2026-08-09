import { describe, expect, it } from 'vitest';
import { LabelTemplateService } from '../../src/modules/labels/label-template.service';
import { DEFAULT_LABEL_TOGGLES } from '../../src/modules/labels/labels.types';
import { FnPool, MEMBER_ID, mockAudit, SHOP_ID, templateRow } from './helpers';

/**
 * §2.6 / §9.12 label template: create-with-defaults on first read (S-23/S-24),
 * INV-22 optimistic concurrency, §12 audit of settings changes.
 */

function env() {
  const pool = new FnPool();
  const audit = mockAudit();
  const service = new LabelTemplateService(pool.asPool(), audit as never);
  return { pool, audit, service };
}

describe('getOrCreate — first read materializes the S-23/S-24 defaults', () => {
  it('inserts with defaults when no row exists', async () => {
    const { pool, service } = env();
    const row = templateRow();
    pool
      .onFn(/FROM label_template WHERE shop_id/, (() => {
        let calls = 0;
        return () => ({ rows: calls++ === 0 ? [] : [row], rowCount: 1 });
      })())
      .on(/INSERT INTO label_template/, [], 1);

    const result = await service.getOrCreate(SHOP_ID);
    expect(result.toggles).toEqual(DEFAULT_LABEL_TOGGLES);
    expect(result.size).toBe('THERMAL_4X6');
    // S-24: the COD amount is NOT a toggle — no such key exists.
    expect(Object.keys(result.toggles)).not.toContain('cod');
    expect(Object.keys(result.toggles)).not.toContain('codEmphasis');
    const insert = pool.matching(/INSERT INTO label_template/)[0];
    expect(insert.params).toEqual([SHOP_ID]);
    expect(insert.sql).toContain('ON CONFLICT (shop_id) DO NOTHING');
  });

  it('a second read does not insert again', async () => {
    const { pool, service } = env();
    pool.on(/FROM label_template WHERE shop_id/, [templateRow()]);
    const result = await service.getOrCreate(SHOP_ID);
    expect(result.template_id).toBe(templateRow().template_id);
    expect(pool.matching(/INSERT INTO label_template/)).toHaveLength(0);
  });
});

describe('update — INV-22 optimistic concurrency + §12 audit', () => {
  it('applies a partial toggle patch, bumps the version and audits', async () => {
    const { pool, audit, service } = env();
    const before = templateRow({ version: 3 });
    const after = templateRow({
      version: 4,
      brand_name: 'New Brand',
      toggles: { ...DEFAULT_LABEL_TOGGLES, prices: true },
    });
    pool.on(/FROM label_template WHERE shop_id/, [before]);
    pool.on(/UPDATE label_template/, [after], 1);

    const result = await service.update(SHOP_ID, MEMBER_ID, {
      brandName: 'New Brand',
      toggles: { prices: true },
      version: 3,
    });

    expect(result.version).toBe(4);
    const update = pool.matching(/UPDATE label_template/)[0];
    // Shop-scoped write matching the read version (INV-1 + INV-22).
    expect(update.sql).toContain('WHERE shop_id = $1 AND version = $2');
    expect(update.params[0]).toBe(SHOP_ID);
    expect(update.params[1]).toBe(3);
    // Untouched toggle keys keep their values; only `prices` flipped.
    const writtenToggles = JSON.parse(update.params[6] as string);
    expect(writtenToggles).toEqual({ ...DEFAULT_LABEL_TOGGLES, prices: true });

    // §12: settings changes are audited with before/after.
    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0] as Record<string, unknown>;
    expect(entry.action).toBe('LABEL_TEMPLATE_UPDATED');
    expect(entry.actorKind).toBe('MEMBER');
    expect(entry.actorId).toBe(MEMBER_ID);
    expect(entry.shopId).toBe(SHOP_ID);
    expect((entry.before as { version: number }).version).toBe(3);
    expect((entry.after as { version: number }).version).toBe(4);
  });

  it('a version mismatch rejects with 409 and the current row (INV-22)', async () => {
    const { pool, audit, service } = env();
    const current = templateRow({ version: 5 });
    pool.on(/FROM label_template WHERE shop_id/, [current]);
    pool.on(/UPDATE label_template/, [], 0); // concurrent writer won

    await expect(
      service.update(SHOP_ID, MEMBER_ID, { brandName: 'X', version: 3 }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ current: expect.objectContaining({ version: 5 }) }),
    });
    // A rejected write is not audited as a change.
    expect(audit.entries).toHaveLength(0);
  });

  it('rejects an unknown size', async () => {
    const { pool, service } = env();
    pool.on(/FROM label_template WHERE shop_id/, [templateRow()]);
    await expect(
      service.update(SHOP_ID, MEMBER_ID, { size: 'A5_8UP' as never, version: 1 }),
    ).rejects.toThrow(/unknown label size/);
    expect(pool.matching(/UPDATE label_template/)).toHaveLength(0);
  });
});
