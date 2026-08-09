import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { Paise, paiseToRupees, rupeesToPaise } from '../../common/money';

/**
 * §7.5 reconciliation settings (S-27–S-30) and the §4.8/A1-06 effective
 * tolerance resolution: a courier_account override column wins when set,
 * otherwise the Shop default from recon_settings applies. The Shop row is
 * created with §7.5 defaults on first read.
 *
 * Writes are Finance+ (the controller declares 'settings.recon.edit'),
 * INV-22 optimistic-concurrency checked, and audited (§12).
 */

export interface ReconSettingsRow {
  shopId: string;
  freightEnabled: boolean; // S-27
  freightTolerance: string; // 2dp text
  weightToleranceKg: string; // S-28, 3dp text
  codEnabled: boolean; // S-29
  codTolerance: string;
  codDueDays: number; // S-30
  version: number;
}

/** §4.8 effective tolerances for one courier account. */
export interface EffectiveTolerances {
  freightTolerance: Paise;
  weightToleranceGrams: bigint;
  /** Which level each value came from — surfaced in the UI (A1-06). */
  freightToleranceSource: 'COURIER_ACCOUNT' | 'SHOP';
  weightToleranceSource: 'COURIER_ACCOUNT' | 'SHOP';
}

export interface ReconSettingsPatch {
  freightEnabled?: boolean;
  freightTolerance?: string;
  weightToleranceKg?: string;
  codEnabled?: boolean;
  codTolerance?: string;
  codDueDays?: number;
}

export interface AccountOverridePatch {
  freightTolerance?: string | null;
  weightToleranceKg?: string | null;
  codTolerance?: string | null;
  codDueDays?: number | null;
}

export type SettingsUpdateResult =
  | { ok: true }
  | { ok: false; code: 'VERSION_CONFLICT' | 'INVALID_VALUE' | 'ACCOUNT_NOT_FOUND'; currentVersion?: number };

interface SettingsDbRow {
  freight_enabled: boolean;
  freight_tolerance: string;
  weight_tolerance_kg: string;
  cod_enabled: boolean;
  cod_tolerance: string;
  cod_due_days: number;
  version: number;
}

function toRow(shopId: string, r: SettingsDbRow): ReconSettingsRow {
  return {
    shopId,
    freightEnabled: r.freight_enabled,
    freightTolerance: paiseToRupees(rupeesToPaise(r.freight_tolerance)),
    weightToleranceKg: r.weight_tolerance_kg,
    codEnabled: r.cod_enabled,
    codTolerance: paiseToRupees(rupeesToPaise(r.cod_tolerance)),
    codDueDays: r.cod_due_days,
    version: r.version,
  };
}

/** "0.010"-style kg text → integer grams (null on garbage). */
function kgTextToGrams(value: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!m) return null;
  return BigInt(m[1]) * 1000n + BigInt(((m[2] ?? '') + '000').slice(0, 3));
}

@Injectable()
export class ReconSettingsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  /** Read the Shop row, creating it with the §7.5 defaults on first read. */
  async get(shopId: string): Promise<ReconSettingsRow> {
    await this.pool.query(
      `INSERT INTO recon_settings (shop_id) VALUES ($1) ON CONFLICT (shop_id) DO NOTHING`,
      [shopId],
    );
    const { rows } = await this.pool.query<SettingsDbRow>(
      `SELECT freight_enabled, freight_tolerance, weight_tolerance_kg,
              cod_enabled, cod_tolerance, cod_due_days, version
         FROM recon_settings WHERE shop_id = $1`,
      [shopId],
    );
    return toRow(shopId, rows[0]);
  }

  /**
   * §4.8 / A1-06: courier_account override when set, else the Shop default.
   * An unknown account id yields the Shop defaults (the batch upload path
   * validates the account separately).
   */
  async effective(shopId: string, courierAccountId: string): Promise<EffectiveTolerances> {
    const settings = await this.get(shopId);
    const { rows } = await this.pool.query<{
      freight_tolerance: string | null;
      weight_tolerance_kg: string | null;
    }>(
      `SELECT freight_tolerance, weight_tolerance_kg
         FROM courier_account
        WHERE courier_account_id = $1 AND shop_id = $2`,
      [courierAccountId, shopId],
    );
    const account = rows[0];
    const freight = account?.freight_tolerance ?? null;
    const weight = account?.weight_tolerance_kg ?? null;
    return {
      freightTolerance: rupeesToPaise(freight ?? settings.freightTolerance),
      weightToleranceGrams:
        kgTextToGrams(weight ?? settings.weightToleranceKg) ?? 10n, // S-28 default 0.010 kg
      freightToleranceSource: freight !== null ? 'COURIER_ACCOUNT' : 'SHOP',
      weightToleranceSource: weight !== null ? 'COURIER_ACCOUNT' : 'SHOP',
    };
  }

  /** S-27–S-30 write (Finance+), INV-22 checked, audited (§12). */
  async update(
    shopId: string,
    patch: ReconSettingsPatch,
    expectedVersion: number,
    actorMemberId: string,
  ): Promise<SettingsUpdateResult> {
    const before = await this.get(shopId);

    // §4.1: tolerances non-negative; S-30 positive. Values normalize to
    // storage forms (2dp / 3dp) or fail validation.
    let freightTolerance: string | null = null;
    let codTolerance: string | null = null;
    let weightToleranceKg: string | null = null;
    try {
      if (patch.freightTolerance !== undefined) {
        const p = rupeesToPaise(patch.freightTolerance);
        if (p < 0n) throw new Error('negative');
        freightTolerance = paiseToRupees(p);
      }
      if (patch.codTolerance !== undefined) {
        const p = rupeesToPaise(patch.codTolerance);
        if (p < 0n) throw new Error('negative');
        codTolerance = paiseToRupees(p);
      }
      if (patch.weightToleranceKg !== undefined) {
        const g = kgTextToGrams(patch.weightToleranceKg);
        if (g === null || g < 0n) throw new Error('invalid weight');
        weightToleranceKg = `${g / 1000n}.${(g % 1000n).toString().padStart(3, '0')}`;
      }
    } catch {
      return { ok: false, code: 'INVALID_VALUE' };
    }
    if (patch.codDueDays !== undefined && (!Number.isInteger(patch.codDueDays) || patch.codDueDays <= 0)) {
      return { ok: false, code: 'INVALID_VALUE' };
    }

    const { rows } = await this.pool.query<{ version: number }>(
      `UPDATE recon_settings
          SET freight_enabled     = COALESCE($2, freight_enabled),
              freight_tolerance   = COALESCE($3, freight_tolerance),
              weight_tolerance_kg = COALESCE($4, weight_tolerance_kg),
              cod_enabled         = COALESCE($5, cod_enabled),
              cod_tolerance       = COALESCE($6, cod_tolerance),
              cod_due_days        = COALESCE($7, cod_due_days),
              version             = version + 1
        WHERE shop_id = $1 AND version = $8
        RETURNING version`,
      [
        shopId,
        patch.freightEnabled ?? null,
        freightTolerance,
        weightToleranceKg,
        patch.codEnabled ?? null,
        codTolerance,
        patch.codDueDays ?? null,
        expectedVersion,
      ],
    );
    if (rows.length === 0) {
      // INV-22: reject with the current state for refresh-and-reapply.
      return { ok: false, code: 'VERSION_CONFLICT', currentVersion: before.version };
    }
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: actorMemberId,
      action: 'recon.settings_updated', // §12
      objectType: 'recon_settings',
      objectId: shopId,
      before,
      after: { ...patch, version: rows[0].version },
    });
    return { ok: true };
  }

  /**
   * Per-courier-account overrides (A1-06; null inherits the Shop default).
   * Finance+, INV-22 on courier_account.version, audited.
   */
  async updateAccountOverrides(
    shopId: string,
    courierAccountId: string,
    patch: AccountOverridePatch,
    expectedVersion: number,
    actorMemberId: string,
  ): Promise<SettingsUpdateResult> {
    const { rows: beforeRows } = await this.pool.query<{
      freight_tolerance: string | null;
      weight_tolerance_kg: string | null;
      cod_tolerance: string | null;
      cod_due_days: number | null;
      version: number;
    }>(
      `SELECT freight_tolerance, weight_tolerance_kg, cod_tolerance, cod_due_days, version
         FROM courier_account
        WHERE courier_account_id = $1 AND shop_id = $2`,
      [courierAccountId, shopId],
    );
    const before = beforeRows[0];
    if (!before) return { ok: false, code: 'ACCOUNT_NOT_FOUND' };

    const money = (v: string | null | undefined): string | null | undefined => {
      if (v === undefined || v === null) return v;
      const p = rupeesToPaise(v);
      if (p < 0n) throw new Error('negative');
      return paiseToRupees(p);
    };
    const weight = (v: string | null | undefined): string | null | undefined => {
      if (v === undefined || v === null) return v;
      const g = kgTextToGrams(v);
      if (g === null || g < 0n) throw new Error('invalid weight');
      return `${g / 1000n}.${(g % 1000n).toString().padStart(3, '0')}`;
    };
    let normalized: Required<AccountOverridePatch>;
    try {
      normalized = {
        freightTolerance: money(patch.freightTolerance) ?? null,
        weightToleranceKg: weight(patch.weightToleranceKg) ?? null,
        codTolerance: money(patch.codTolerance) ?? null,
        codDueDays: patch.codDueDays ?? null,
      };
    } catch {
      return { ok: false, code: 'INVALID_VALUE' };
    }
    if (normalized.codDueDays !== null && (!Number.isInteger(normalized.codDueDays) || normalized.codDueDays <= 0)) {
      return { ok: false, code: 'INVALID_VALUE' };
    }

    // COALESCE cannot distinguish "leave alone" from "set to NULL", so the
    // statement is built per present key (fixed fragments, values bound).
    const sets: string[] = [];
    const params: unknown[] = [courierAccountId, shopId];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.freightTolerance !== undefined) push('freight_tolerance', normalized.freightTolerance);
    if (patch.weightToleranceKg !== undefined) push('weight_tolerance_kg', normalized.weightToleranceKg);
    if (patch.codTolerance !== undefined) push('cod_tolerance', normalized.codTolerance);
    if (patch.codDueDays !== undefined) push('cod_due_days', normalized.codDueDays);
    if (sets.length === 0) return { ok: true }; // nothing to change
    params.push(expectedVersion);
    const { rows } = await this.pool.query<{ version: number }>(
      `UPDATE courier_account
          SET ${sets.join(', ')}, version = version + 1
        WHERE courier_account_id = $1 AND shop_id = $2 AND version = $${params.length}
        RETURNING version`,
      params,
    );
    if (rows.length === 0) {
      return { ok: false, code: 'VERSION_CONFLICT', currentVersion: before.version };
    }
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: actorMemberId,
      action: 'recon.account_overrides_updated', // §12
      objectType: 'courier_account',
      objectId: courierAccountId,
      before: {
        freightTolerance: before.freight_tolerance,
        weightToleranceKg: before.weight_tolerance_kg,
        codTolerance: before.cod_tolerance,
        codDueDays: before.cod_due_days,
      },
      after: { ...patch, version: rows[0].version },
    });
    return { ok: true };
  }
}
