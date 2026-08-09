import { Inject, Injectable } from '@nestjs/common';
import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { paiseToRupees, rupeesToPaise } from '../../common/money';
import { COD_SETTINGS_DEFAULTS } from './recon-cod.types';

export interface CodSettingsView {
  cod_enabled: boolean;
  /** 2dp rupee string (S-29). */
  cod_tolerance: string;
  cod_due_days: number;
  version: number;
}

/**
 * §9.17.4 / §7.5: S-29 (COD enabled + ₹ tolerance) and S-30 (COD settlement
 * due days). These live on the SHARED recon_settings row owned together with
 * the freight module's S-27/S-28 — every write here is a targeted UPDATE of
 * the COD columns only and never touches the freight fields.
 *
 * Effective-value resolution (§4.8, A1-06): the courier_account override when
 * set, else the Shop default. Implemented locally (a few lines) so this
 * module never imports the in-flight freight module.
 */
@Injectable()
export class CodSettingsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  /** S-29/S-30 read; Shop defaults (§7.5) when no recon_settings row exists. */
  async get(shopId: string): Promise<CodSettingsView> {
    const res = await this.pool.query<{
      cod_enabled: boolean;
      cod_tolerance: string;
      cod_due_days: number;
      version: number;
    }>(
      `SELECT cod_enabled, cod_tolerance::text, cod_due_days, version
         FROM recon_settings WHERE shop_id = $1`,
      [shopId],
    );
    const row = res.rows[0];
    if (!row) return { ...COD_SETTINGS_DEFAULTS, version: 0 };
    return {
      cod_enabled: row.cod_enabled,
      cod_tolerance: paiseToRupees(rupeesToPaise(row.cod_tolerance)),
      cod_due_days: row.cod_due_days,
      version: row.version,
    };
  }

  /** §4.8 effective COD tolerance in paise: account override else S-29. */
  async effectiveCodTolerance(shopId: string, courierAccountId: string | null): Promise<bigint> {
    const res = await this.pool.query<{ tol: string }>(
      `SELECT COALESCE(ca.cod_tolerance, rs.cod_tolerance, $3::numeric)::text AS tol
         FROM (SELECT $2::uuid AS courier_account_id) p
         LEFT JOIN courier_account ca
           ON ca.courier_account_id = p.courier_account_id AND ca.shop_id = $1
         LEFT JOIN recon_settings rs ON rs.shop_id = $1`,
      [shopId, courierAccountId, COD_SETTINGS_DEFAULTS.cod_tolerance],
    );
    return rupeesToPaise(res.rows[0]?.tol ?? COD_SETTINGS_DEFAULTS.cod_tolerance);
  }

  /** F-21 effective due days: account override else S-30 (default 7). */
  async effectiveCodDueDays(shopId: string, courierAccountId: string | null): Promise<number> {
    const res = await this.pool.query<{ due_days: number }>(
      `SELECT COALESCE(ca.cod_due_days, rs.cod_due_days, $3)::int AS due_days
         FROM (SELECT $2::uuid AS courier_account_id) p
         LEFT JOIN courier_account ca
           ON ca.courier_account_id = p.courier_account_id AND ca.shop_id = $1
         LEFT JOIN recon_settings rs ON rs.shop_id = $1`,
      [shopId, courierAccountId, COD_SETTINGS_DEFAULTS.cod_due_days],
    );
    return res.rows[0]?.due_days ?? COD_SETTINGS_DEFAULTS.cod_due_days;
  }

  /**
   * S-29/S-30 PATCH (Finance+, §10.2). Targeted COD-column upsert — the
   * freight columns (S-27/S-28) are never named here. INV-22: the expected
   * version is enforced in the same statement; a mismatch rejects with the
   * current state. Settings changes are audited (§12: every S-value).
   */
  async update(
    shopId: string,
    patch: { codEnabled?: boolean; codTolerance?: string; codDueDays?: number },
    expectedVersion: number,
    actorMemberId: string,
  ): Promise<CodSettingsView> {
    if (patch.codTolerance !== undefined) {
      try {
        if (rupeesToPaise(patch.codTolerance) < 0n) throw new Error('negative');
      } catch {
        throw new UnprocessableEntityException(
          `cod_tolerance (S-29) must be a non-negative INR amount, got "${patch.codTolerance}"`,
        );
      }
    }
    if (patch.codDueDays !== undefined && (!Number.isInteger(patch.codDueDays) || patch.codDueDays <= 0)) {
      throw new UnprocessableEntityException('cod_due_days (S-30) must be a positive integer');
    }

    const before = await this.get(shopId);
    const next = {
      cod_enabled: patch.codEnabled ?? before.cod_enabled,
      cod_tolerance: patch.codTolerance ?? before.cod_tolerance,
      cod_due_days: patch.codDueDays ?? before.cod_due_days,
    };

    const res = await this.pool.query<{
      cod_enabled: boolean;
      cod_tolerance: string;
      cod_due_days: number;
      version: number;
    }>(
      `INSERT INTO recon_settings (shop_id, cod_enabled, cod_tolerance, cod_due_days)
       VALUES ($1, $2, $3::numeric, $4)
       ON CONFLICT (shop_id) DO UPDATE SET
         cod_enabled = EXCLUDED.cod_enabled,
         cod_tolerance = EXCLUDED.cod_tolerance,
         cod_due_days = EXCLUDED.cod_due_days,
         version = recon_settings.version + 1
       WHERE recon_settings.version = $5
       RETURNING cod_enabled, cod_tolerance::text, cod_due_days, version`,
      [shopId, next.cod_enabled, next.cod_tolerance, next.cod_due_days, expectedVersion],
    );

    const row = res.rows[0];
    if (!row) {
      // INV-22: version mismatch — reject and let the actor re-read.
      throw new ConflictException({
        error: 'VERSION_CONFLICT',
        current: await this.get(shopId),
      });
    }

    const after: CodSettingsView = {
      cod_enabled: row.cod_enabled,
      cod_tolerance: paiseToRupees(rupeesToPaise(row.cod_tolerance)),
      cod_due_days: row.cod_due_days,
      version: row.version,
    };
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: actorMemberId,
      action: 'settings.recon_cod.update',
      objectType: 'recon_settings',
      objectId: shopId,
      before,
      after,
    });
    return after;
  }
}
