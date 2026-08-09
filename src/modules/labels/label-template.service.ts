import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import {
  DEFAULT_LABEL_TOGGLES,
  LABEL_SIZES,
  LabelSize,
  LabelTemplateRow,
  LabelToggles,
} from './labels.types';

/** §9.12 / S-23 / S-24: the editable template fields (Owner-only, §7.4). */
export interface LabelTemplatePatch {
  brandName?: string | null;
  supportPhone?: string | null;
  messageLine?: string | null;
  logoObjectKey?: string | null;
  toggles?: Partial<LabelToggles>;
  size?: LabelSize;
  /** INV-22: the version the writer read; a mismatch rejects with 409. */
  version: number;
}

const TOGGLE_KEYS: ReadonlyArray<keyof LabelToggles> = [
  'productList',
  'sku',
  'orderBarcode',
  'gstNumber',
  'weightDims',
  'routingCode',
  'prices',
  'hideAmountsOnPrepaid',
];

/**
 * §2.6 label_template — one row per Shop (§9.12), created with the S-24
 * defaults on first read. Writes are Owner-only (the controller enforces the
 * role; S-23's print-time size choice is Operator+ and lives on the generate
 * endpoint, not here). Every write carries the version the writer read
 * (INV-22) and is audited (§12 — settings changes, every S-value).
 */
@Injectable()
export class LabelTemplateService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  /** First read materializes the row with S-23/S-24 defaults. */
  async getOrCreate(shopId: string): Promise<LabelTemplateRow> {
    const existing = await this.find(shopId);
    if (existing) return existing;
    // Concurrent first reads race on the shop_id UNIQUE — loser re-reads.
    await this.pool.query(
      `INSERT INTO label_template (shop_id) VALUES ($1)
       ON CONFLICT (shop_id) DO NOTHING`,
      [shopId],
    );
    const created = await this.find(shopId);
    if (!created) throw new Error('label_template insert raced and re-read failed');
    return created;
  }

  private async find(shopId: string): Promise<LabelTemplateRow | null> {
    const { rows } = await this.pool.query<LabelTemplateRow>(
      `SELECT template_id, shop_id, logo_object_key, brand_name, support_phone,
              message_line, toggles, size, version, created_at, updated_at
         FROM label_template WHERE shop_id = $1`,
      [shopId],
    );
    return rows[0] ?? null;
  }

  /**
   * Owner-only template change (S-23/S-24 "Changed by"). INV-22: the update
   * matches on the version the writer read; a mismatch returns 409 with the
   * current row so the actor can refresh and reapply — never a silent merge.
   */
  async update(
    shopId: string,
    actorId: string,
    patch: LabelTemplatePatch,
  ): Promise<LabelTemplateRow> {
    if (patch.size !== undefined && !LABEL_SIZES.includes(patch.size)) {
      throw new ConflictException(`unknown label size (S-23): ${patch.size}`);
    }
    const before = await this.getOrCreate(shopId);

    const toggles: LabelToggles = { ...DEFAULT_LABEL_TOGGLES, ...before.toggles };
    if (patch.toggles) {
      for (const key of TOGGLE_KEYS) {
        const v = patch.toggles[key];
        if (typeof v === 'boolean') toggles[key] = v;
      }
    }

    const { rows, rowCount } = await this.pool.query<LabelTemplateRow>(
      `UPDATE label_template
          SET brand_name = $3, support_phone = $4, message_line = $5,
              logo_object_key = $6, toggles = $7, size = $8,
              version = version + 1
        WHERE shop_id = $1 AND version = $2
        RETURNING template_id, shop_id, logo_object_key, brand_name,
                  support_phone, message_line, toggles, size, version,
                  created_at, updated_at`,
      [
        shopId,
        patch.version,
        patch.brandName === undefined ? before.brand_name : patch.brandName,
        patch.supportPhone === undefined ? before.support_phone : patch.supportPhone,
        patch.messageLine === undefined ? before.message_line : patch.messageLine,
        patch.logoObjectKey === undefined ? before.logo_object_key : patch.logoObjectKey,
        JSON.stringify(toggles),
        patch.size === undefined ? before.size : patch.size,
      ],
    );

    if (rowCount === 0 || !rows[0]) {
      // INV-22: reject and hand back the current state for refresh+reapply.
      const current = await this.find(shopId);
      throw new ConflictException({
        message: 'label template version conflict (INV-22)',
        current,
      });
    }

    // §12: settings changes are audited (every S-value).
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId,
      action: 'LABEL_TEMPLATE_UPDATED',
      objectType: 'label_template',
      objectId: rows[0].template_id,
      before: {
        brand_name: before.brand_name,
        support_phone: before.support_phone,
        message_line: before.message_line,
        logo_object_key: before.logo_object_key,
        toggles: before.toggles,
        size: before.size,
        version: before.version,
      },
      after: {
        brand_name: rows[0].brand_name,
        support_phone: rows[0].support_phone,
        message_line: rows[0].message_line,
        logo_object_key: rows[0].logo_object_key,
        toggles: rows[0].toggles,
        size: rows[0].size,
        version: rows[0].version,
      },
    });
    return rows[0];
  }
}
