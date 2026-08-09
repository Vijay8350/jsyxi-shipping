import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../database/database.module';
import { AuditService } from '../../../audit/audit.service';

/**
 * Store general settings (§7.1, §9.20).
 *
 * - Defaults are exactly per §7.1: language 'en' (S-1), timezone
 *   'Asia/Kolkata' (S-2), currency from the Shopify shop — always 'INR'
 *   (S-3, INV-2), decimal '.' / 2 digits (S-4), weight 'kg' (S-5),
 *   measurement 'cm' (S-6), default parcel weight 0.500 kg (S-7).
 * - First read creates the row with those defaults.
 * - Currency is read-only: any attempt to set it is rejected (S-3, INV-2).
 * - Weight/measurement units are display+input preferences only (§9.20);
 *   canonical storage is always kg/cm — nothing is ever converted here.
 * - INV-22: every PATCH carries the version the writer read; a mismatch is
 *   rejected with the current row, never a last-write-wins merge.
 * - Every change is audited (§12: settings changes — every S-value).
 */

export interface StoreSettingsRow {
  shop_id: string;
  language: string;
  timezone: string;
  currency: string;
  decimal_separator: string;
  decimal_digits: number;
  weight_unit: string;
  measurement_unit: string;
  default_parcel_weight_kg: string; // numeric(10,3) arrives as string
  version: number;
  created_at: string;
  updated_at: string;
}

export interface StoreSettingsView {
  shopId: string;
  language: string;
  timezone: string;
  currency: string;
  decimalSeparator: string;
  decimalDigits: number;
  weightUnit: string;
  measurementUnit: string;
  defaultParcelWeightKg: string;
  version: number;
}

export interface StoreSettingsPatch {
  version: number;
  language?: string;
  timezone?: string;
  decimalSeparator?: string;
  decimalDigits?: number;
  weightUnit?: string;
  measurementUnit?: string;
  defaultParcelWeightKg?: number;
  /** Present only to be rejected — S-3 is read-only (INV-2). */
  currency?: string;
}

export interface SettingsActor {
  memberId: string;
}

const WEIGHT_UNITS = ['kg', 'g'] as const;
const MEASUREMENT_UNITS = ['cm', 'in'] as const;
const DECIMAL_SEPARATORS = ['.', ','] as const;

function toView(row: StoreSettingsRow): StoreSettingsView {
  return {
    shopId: row.shop_id,
    language: row.language,
    timezone: row.timezone,
    currency: row.currency,
    decimalSeparator: row.decimal_separator,
    decimalDigits: row.decimal_digits,
    weightUnit: row.weight_unit,
    measurementUnit: row.measurement_unit,
    defaultParcelWeightKg: row.default_parcel_weight_kg,
    version: row.version,
  };
}

@Injectable()
export class StoreSettingsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  /** First read creates the row with §7.1 defaults (shop-scoped, INV-1). */
  async getOrCreate(shopId: string): Promise<StoreSettingsView> {
    // INSERT ... ON CONFLICT handles the two-concurrent-first-reads race;
    // the defaults live in the migration, so nothing is repeated here.
    const result = await this.pool.query<StoreSettingsRow>(
      `INSERT INTO store_settings (shop_id) VALUES ($1)
       ON CONFLICT (shop_id) DO NOTHING
       RETURNING *`,
      [shopId],
    );
    if (result.rows[0]) return toView(result.rows[0]);
    const existing = await this.pool.query<StoreSettingsRow>(
      `SELECT * FROM store_settings WHERE shop_id = $1`,
      [shopId],
    );
    return toView(existing.rows[0]);
  }

  async update(
    shopId: string,
    patch: StoreSettingsPatch,
    actor: SettingsActor,
  ): Promise<StoreSettingsView> {
    // S-3 is read-only from the Shopify shop (INV-2): any attempt to set it
    // is rejected, even with the current value.
    if (patch.currency !== undefined) {
      throw new BadRequestException(
        'currency is read-only; it comes from the Shopify shop (S-3, INV-2)',
      );
    }
    if (!Number.isInteger(patch.version) || patch.version < 1) {
      throw new BadRequestException('version is required (INV-22)');
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (patch.language !== undefined) {
      if (!/^[a-z]{2}(-[A-Za-z]{2})?$/.test(patch.language)) {
        throw new BadRequestException('invalid language code (S-1)');
      }
      push('language', patch.language);
    }
    if (patch.timezone !== undefined) {
      // IANA validation (S-2): Intl rejects unknown zones.
      try {
        new Intl.DateTimeFormat('en', { timeZone: patch.timezone });
      } catch {
        throw new BadRequestException('invalid IANA timezone (S-2)');
      }
      push('timezone', patch.timezone);
    }
    if (patch.decimalSeparator !== undefined) {
      if (
        !(DECIMAL_SEPARATORS as readonly string[]).includes(
          patch.decimalSeparator,
        )
      ) {
        throw new BadRequestException("decimal separator must be '.' or ',' (S-4)");
      }
      push('decimal_separator', patch.decimalSeparator);
    }
    if (patch.decimalDigits !== undefined) {
      if (
        !Number.isInteger(patch.decimalDigits) ||
        patch.decimalDigits < 0 ||
        patch.decimalDigits > 4
      ) {
        throw new BadRequestException('decimal digits must be 0–4 (S-4)');
      }
      push('decimal_digits', patch.decimalDigits);
    }
    if (patch.weightUnit !== undefined) {
      if (!(WEIGHT_UNITS as readonly string[]).includes(patch.weightUnit)) {
        throw new BadRequestException("weight unit must be 'kg' or 'g' (S-5)");
      }
      push('weight_unit', patch.weightUnit);
    }
    if (patch.measurementUnit !== undefined) {
      if (
        !(MEASUREMENT_UNITS as readonly string[]).includes(
          patch.measurementUnit,
        )
      ) {
        throw new BadRequestException(
          "measurement unit must be 'cm' or 'in' (S-6)",
        );
      }
      push('measurement_unit', patch.measurementUnit);
    }
    if (patch.defaultParcelWeightKg !== undefined) {
      // S-7: positive, fits numeric(10,3); stored in canonical kg (§4.1).
      const w = patch.defaultParcelWeightKg;
      if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0 || w > 9999999.999) {
        throw new BadRequestException(
          'default parcel weight must be positive and fit numeric(10,3) (S-7)',
        );
      }
      push('default_parcel_weight_kg', w.toFixed(3));
    }
    if (sets.length === 0) {
      throw new BadRequestException('nothing to update');
    }

    const before = await this.getOrCreate(shopId);

    // INV-22: the write carries the version the writer read.
    values.push(shopId, patch.version);
    const result = await this.pool.query<StoreSettingsRow>(
      `UPDATE store_settings
          SET ${sets.join(', ')}, version = version + 1
        WHERE shop_id = $${values.length - 1}
          AND version = $${values.length}
        RETURNING *`,
      values,
    );

    if (!result.rows[0]) {
      // Version mismatch: reject and return the current state (INV-22).
      const current = await this.getOrCreate(shopId);
      throw new ConflictException({
        message: 'settings changed elsewhere; refresh and reapply (INV-22)',
        current,
      });
    }

    const after = toView(result.rows[0]);
    // §12: settings changes are always audited (every S-value).
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: actor.memberId,
      action: 'settings.store.update',
      objectType: 'store_settings',
      objectId: shopId,
      before,
      after,
    });
    return after;
  }
}
