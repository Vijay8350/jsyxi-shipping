import { describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { CodDueSweepService } from '../../src/modules/recon-cod/cod-due-sweep.service';
import { CodSettingsService } from '../../src/modules/recon-cod/cod-settings.service';
import { FnPool, mockAudit, SQL, SHOP_ID, MEMBER_ID } from './helpers';

describe('due sweep (F-21)', () => {
  it('flips AWAITING/SHORT expectations past due to PENDING_OVERDUE, shop-local aware, audited per shop', async () => {
    const pool = new FnPool();
    pool.on(/UPDATE recon_cod_expected e/, [
      { shop_id: SHOP_ID, n: 3 },
      { shop_id: 'shop-2', n: 1 },
    ]);
    const audit = mockAudit();
    const service = new CodDueSweepService(pool.asPool(), audit as never);

    const result = await service.run();

    expect(result).toEqual([
      { shopId: SHOP_ID, flipped: 3 },
      { shopId: 'shop-2', flipped: 1 },
    ]);
    const sql = pool.matching(/UPDATE recon_cod_expected e/)[0].sql;
    expect(sql).toContain(`e.state IN ('AWAITING', 'SHORT')`);
    expect(sql).toContain('PENDING_OVERDUE');
    expect(sql).toContain('store_settings'); // S-2 timezone per shop (§5.2)
    expect(audit.entries).toHaveLength(2);
    expect(audit.entries[0]).toMatchObject({
      actorKind: 'SYSTEM',
      action: 'recon_cod.due_sweep',
      after: { flipped_to_pending_overdue: 3 },
    });
  });
});

describe('settings (§9.17.4, S-29/S-30)', () => {
  it('reads §7.5 defaults when the shop has no recon_settings row', async () => {
    const pool = new FnPool();
    pool.on(SQL.reconSettings, []);
    const service = new CodSettingsService(pool.asPool(), mockAudit() as never);

    const view = await service.get(SHOP_ID);

    expect(view).toEqual({ cod_enabled: true, cod_tolerance: '1.00', cod_due_days: 7, version: 0 });
  });

  it('PATCH writes ONLY the COD columns — freight S-27/S-28 are never named', async () => {
    const pool = new FnPool();
    pool.on(SQL.reconSettings, [
      { cod_enabled: true, cod_tolerance: '1.0000', cod_due_days: 7, version: 4 },
    ]);
    pool.on(SQL.upsertSettings, [
      { cod_enabled: true, cod_tolerance: '2.5000', cod_due_days: 10, version: 5 },
    ]);
    const audit = mockAudit();
    const service = new CodSettingsService(pool.asPool(), audit as never);

    const view = await service.update(
      SHOP_ID,
      { codTolerance: '2.50', codDueDays: 10 },
      4,
      MEMBER_ID,
    );

    const upsert = pool.matching(SQL.upsertSettings)[0];
    expect(upsert.sql).toContain('cod_enabled');
    expect(upsert.sql).toContain('cod_tolerance');
    expect(upsert.sql).toContain('cod_due_days');
    expect(upsert.sql).not.toContain('freight');
    expect(upsert.sql).not.toContain('weight_tolerance');
    // INV-22: the read version is enforced inside the same statement.
    expect(upsert.params[4]).toBe(4);
    expect(view).toMatchObject({ cod_tolerance: '2.50', cod_due_days: 10, version: 5 });
    // §12: settings changes are audited with before/after.
    expect(audit.entries[0]).toMatchObject({
      actorKind: 'MEMBER',
      action: 'settings.recon_cod.update',
      before: { cod_tolerance: '1.00', cod_due_days: 7 },
      after: { cod_tolerance: '2.50', cod_due_days: 10 },
    });
  });

  it('INV-22: a version mismatch rejects and returns the current state', async () => {
    const pool = new FnPool();
    pool.on(SQL.reconSettings, [
      { cod_enabled: true, cod_tolerance: '1.0000', cod_due_days: 7, version: 4 },
    ]);
    pool.on(SQL.upsertSettings, [], 0); // WHERE version = $5 excluded the row
    const service = new CodSettingsService(pool.asPool(), mockAudit() as never);

    await expect(
      service.update(SHOP_ID, { codDueDays: 10 }, 3, MEMBER_ID),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('invalid values are refused before any write', async () => {
    const pool = new FnPool();
    const service = new CodSettingsService(pool.asPool(), mockAudit() as never);

    await expect(service.update(SHOP_ID, { codDueDays: 0 }, 0, MEMBER_ID)).rejects.toThrow();
    await expect(
      service.update(SHOP_ID, { codTolerance: '-1.00' }, 0, MEMBER_ID),
    ).rejects.toThrow();
    expect(pool.matching(SQL.upsertSettings)).toHaveLength(0);
  });

  it('effective values resolve account override → shop default (A1-06)', async () => {
    const pool = new FnPool();
    pool.on(SQL.effectiveTolerance, [{ tol: '2.5000' }]);
    pool.on(SQL.effectiveDueDays, [{ due_days: 10 }]);
    const service = new CodSettingsService(pool.asPool(), mockAudit() as never);

    expect(await service.effectiveCodTolerance(SHOP_ID, 'acct-1')).toBe(250n);
    expect(await service.effectiveCodDueDays(SHOP_ID, 'acct-1')).toBe(10);
    // The COALESCE chain names both the account override and the shop default.
    expect(pool.matching(SQL.effectiveTolerance)[0].sql).toContain('COALESCE(ca.cod_tolerance, rs.cod_tolerance');
  });
});
