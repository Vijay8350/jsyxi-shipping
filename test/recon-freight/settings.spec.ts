import { describe, expect, it } from 'vitest';
import { ReconSettingsService } from '../../src/modules/recon-freight/recon-settings.service';
import { AuditService } from '../../src/audit/audit.service';
import { paiseToRupees } from '../../src/common/money';
import { ACCOUNT_ID, FnPool, MEMBER_ID, SHOP_ID, fakeAudit } from './helpers';

/**
 * §7.5 settings and the §4.8/A1-06 tolerance resolution order:
 * courier-account override when set, else the Shop default (created with
 * §7.5 defaults on first read). Writes are INV-22 checked and audited.
 */

const SHOP_DEFAULTS = {
  freight_enabled: true,
  freight_tolerance: '1.00', // S-27
  weight_tolerance_kg: '0.010', // S-28
  cod_enabled: true,
  cod_tolerance: '1.00',
  cod_due_days: 7,
  version: 1,
};

function harness(pool: FnPool) {
  const audit = fakeAudit();
  const service = new ReconSettingsService(pool.asPool(), audit as unknown as AuditService);
  return { service, audit };
}

function settingsPool(accountOverrides: {
  freight_tolerance: string | null;
  weight_tolerance_kg: string | null;
}): FnPool {
  const pool = new FnPool();
  pool
    .on(/INSERT INTO recon_settings/, [], 0)
    .on(/FROM recon_settings WHERE shop_id/, [SHOP_DEFAULTS])
    .on(/FROM courier_account/, [accountOverrides]);
  return pool;
}

describe('ReconSettingsService.effective (§4.8, A1-06)', () => {
  it('courier-account overrides win when set', async () => {
    const { service } = harness(
      settingsPool({ freight_tolerance: '2.50', weight_tolerance_kg: '0.100' }),
    );
    const eff = await service.effective(SHOP_ID, ACCOUNT_ID);
    expect(paiseToRupees(eff.freightTolerance)).toBe('2.50');
    expect(eff.weightToleranceGrams).toBe(100n);
    expect(eff.freightToleranceSource).toBe('COURIER_ACCOUNT');
    expect(eff.weightToleranceSource).toBe('COURIER_ACCOUNT');
  });

  it('null overrides inherit the Shop defaults (S-27 ₹1.00, S-28 0.010 kg)', async () => {
    const { service } = harness(
      settingsPool({ freight_tolerance: null, weight_tolerance_kg: null }),
    );
    const eff = await service.effective(SHOP_ID, ACCOUNT_ID);
    expect(eff.freightTolerance).toBe(100n);
    expect(eff.weightToleranceGrams).toBe(10n);
    expect(eff.freightToleranceSource).toBe('SHOP');
    expect(eff.weightToleranceSource).toBe('SHOP');
  });

  it('the Shop row is created with §7.5 defaults on first read', async () => {
    const pool = settingsPool({ freight_tolerance: null, weight_tolerance_kg: null });
    const { service } = harness(pool);
    await service.effective(SHOP_ID, ACCOUNT_ID);
    expect(pool.matching(/INSERT INTO recon_settings \(shop_id\) VALUES \(\$1\) ON CONFLICT/)).toHaveLength(1);
  });
});

describe('settings writes (§9.17.4, INV-22, §12)', () => {
  it('update applies the patch under the version check and audits', async () => {
    const pool = settingsPool({ freight_tolerance: null, weight_tolerance_kg: null });
    pool.on(/UPDATE recon_settings/, [{ version: 2 }]);
    const { service, audit } = harness(pool);
    const result = await service.update(SHOP_ID, { freightTolerance: '2.00' }, 1, MEMBER_ID);
    expect(result).toEqual({ ok: true });
    const update = pool.matching(/UPDATE recon_settings/)[0];
    expect(update.params).toContain('2.00');
    expect(update.params[7]).toBe(1); // INV-22 version predicate
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'recon.settings_updated', objectId: SHOP_ID }),
    );
  });

  it('a version mismatch rejects and returns the current version (INV-22)', async () => {
    const pool = settingsPool({ freight_tolerance: null, weight_tolerance_kg: null });
    pool.on(/UPDATE recon_settings/, [], 0);
    const { service } = harness(pool);
    const result = await service.update(SHOP_ID, { freightTolerance: '2.00' }, 99, MEMBER_ID);
    expect(result).toEqual({ ok: false, code: 'VERSION_CONFLICT', currentVersion: 1 });
  });

  it('rejects negative tolerances and non-positive due days (§4.1, S-30)', async () => {
    const { service } = harness(settingsPool({ freight_tolerance: null, weight_tolerance_kg: null }));
    expect((await service.update(SHOP_ID, { freightTolerance: '-1.00' }, 1, MEMBER_ID)).ok).toBe(false);
    expect((await service.update(SHOP_ID, { codDueDays: 0 }, 1, MEMBER_ID)).ok).toBe(false);
  });

  it('account overrides update (null = inherit) under INV-22, audited', async () => {
    const pool = new FnPool();
    pool
      .on(/FROM courier_account/, [
        {
          freight_tolerance: null,
          weight_tolerance_kg: null,
          cod_tolerance: null,
          cod_due_days: null,
          version: 4,
        },
      ])
      .on(/UPDATE courier_account/, [{ version: 5 }]);
    const { service, audit } = harness(pool);
    const result = await service.updateAccountOverrides(
      SHOP_ID,
      ACCOUNT_ID,
      { freightTolerance: '3.00', weightToleranceKg: null },
      4,
      MEMBER_ID,
    );
    expect(result).toEqual({ ok: true });
    const update = pool.matching(/UPDATE courier_account/)[0];
    expect(update.sql).toContain('freight_tolerance = $3');
    expect(update.sql).toContain('weight_tolerance_kg = $4');
    expect(update.params).toEqual([ACCOUNT_ID, SHOP_ID, '3.00', null, 4]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'recon.account_overrides_updated' }),
    );
  });

  it('account override write on an unknown account → ACCOUNT_NOT_FOUND', async () => {
    const pool = new FnPool();
    pool.on(/FROM courier_account/, []);
    const { service } = harness(pool);
    const result = await service.updateAccountOverrides(SHOP_ID, ACCOUNT_ID, { freightTolerance: '1.00' }, 1, MEMBER_ID);
    expect(result).toEqual({ ok: false, code: 'ACCOUNT_NOT_FOUND' });
  });
});
