import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import { AuditService } from '../../audit/audit.service';
import { shopPublicRef, shopRefRedisKey } from './shop-ref';
import {
  TrackPageConfigRow,
  TrackPageConfigView,
  configRowToView,
  TRACK_PAGE_CONFIG_DEFAULTS,
} from './track-page.types';

/**
 * Track-page configuration (§9.16, S-31–S-37 + S-49).
 *
 * - First read creates the row with the §7.6 defaults (they live in migration
 *   0010; nothing is repeated here).
 * - S-38's throttle numbers are admin settings applied globally — they are
 *   NOT stored per shop (migration 0010 comment) and are not editable here.
 * - INV-22: every PATCH carries the version the writer read; a mismatch is
 *   a 409 with the current row.
 * - Every change is audited (§12: settings changes — every S-value).
 * - Owner-only per §7.6 "Changed by" — enforced by OwnerGuard on the
 *   controller (local role check, §10.2).
 */

export interface TrackPageConfigPatch {
  version: number;
  orderBoxLabel?: string; // S-31
  contactBoxLabel?: string; // S-32
  theme?: 'light' | 'dark'; // S-33
  buttonColour?: string; // S-34
  showCourierName?: boolean; // S-35
  showItemSummary?: boolean; // S-36
  replaceTrackingLink?: boolean; // S-37
  logoObjectKey?: string | null; // S-49
}

export interface ConfigActor {
  memberId: string;
}

@Injectable()
export class TrackPageConfigService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /** The shop's public ref for hosted-page URLs (never the shop_id, §9.16). */
  publicRef(shopId: string): string {
    return shopPublicRef(shopId, this.config.get<string>('crypto.piiHashSalt') ?? '');
  }

  /** Base URL of the hosted page: `{appUrl}/track/{shopPublicRef}`. */
  hostedPageUrl(shopId: string): string {
    const appUrl = (
      this.config.get<string>('shopify.appUrl') ?? 'http://localhost:3000'
    ).replace(/\/$/, '');
    return `${appUrl}/track/${this.publicRef(shopId)}`;
  }

  /**
   * First read creates the row with §7.6 defaults (shop-scoped, INV-1) and
   * refreshes the shopPublicRef → shop_id reverse map the public lookup path
   * resolves through (see shop-ref.ts).
   */
  async getOrCreate(shopId: string): Promise<TrackPageConfigView> {
    const result = await this.pool.query<TrackPageConfigRow>(
      `INSERT INTO track_page_config (shop_id) VALUES ($1)
       ON CONFLICT (shop_id) DO NOTHING
       RETURNING *`,
      [shopId],
    );
    let row = result.rows[0];
    if (!row) {
      const existing = await this.pool.query<TrackPageConfigRow>(
        `SELECT * FROM track_page_config WHERE shop_id = $1`,
        [shopId],
      );
      row = existing.rows[0];
    }
    await this.rememberPublicRef(shopId);
    return configRowToView(row);
  }

  /**
   * Render-side read for the public paths: SELECT only, falling back to the
   * §7.6 defaults when the merchant never opened the settings screen. The
   * public page must never perform a write.
   */
  async getForRender(shopId: string): Promise<TrackPageConfigView> {
    const result = await this.pool.query<TrackPageConfigRow>(
      `SELECT * FROM track_page_config WHERE shop_id = $1`,
      [shopId],
    );
    if (result.rows[0]) return configRowToView(result.rows[0]);
    return { shopId, version: 1, ...TRACK_PAGE_CONFIG_DEFAULTS };
  }

  /** Persist the shopPublicRef → shop_id reverse map (no expiry). */
  private async rememberPublicRef(shopId: string): Promise<void> {
    await this.redis.set(shopRefRedisKey(this.publicRef(shopId)), shopId);
  }

  async update(
    shopId: string,
    patch: TrackPageConfigPatch,
    actor: ConfigActor,
  ): Promise<TrackPageConfigView> {
    if (!Number.isInteger(patch.version) || patch.version < 1) {
      throw new BadRequestException('version is required (INV-22)');
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (patch.orderBoxLabel !== undefined) {
      const v = patch.orderBoxLabel.trim();
      if (v.length === 0 || v.length > 120) {
        throw new BadRequestException('order box label must be 1–120 chars (S-31)');
      }
      push('order_box_label', v);
    }
    if (patch.contactBoxLabel !== undefined) {
      const v = patch.contactBoxLabel.trim();
      if (v.length === 0 || v.length > 120) {
        throw new BadRequestException('contact box label must be 1–120 chars (S-32)');
      }
      push('contact_box_label', v);
    }
    if (patch.theme !== undefined) {
      if (patch.theme !== 'light' && patch.theme !== 'dark') {
        throw new BadRequestException("theme must be 'light' or 'dark' (S-33)");
      }
      push('theme', patch.theme);
    }
    if (patch.buttonColour !== undefined) {
      if (!/^#[0-9A-Fa-f]{6}$/.test(patch.buttonColour)) {
        throw new BadRequestException('button colour must be a #RRGGBB hex value (S-34)');
      }
      push('button_colour', patch.buttonColour);
    }
    if (patch.showCourierName !== undefined) {
      push('show_courier_name', patch.showCourierName); // S-35
    }
    if (patch.showItemSummary !== undefined) {
      push('show_item_summary', patch.showItemSummary); // S-36
    }
    if (patch.replaceTrackingLink !== undefined) {
      push('replace_tracking_link', patch.replaceTrackingLink); // S-37
    }
    if (patch.logoObjectKey !== undefined) {
      if (patch.logoObjectKey !== null && patch.logoObjectKey.length > 512) {
        throw new BadRequestException('logo object key too long (S-49)');
      }
      push('logo_object_key', patch.logoObjectKey); // S-49; null = inherit brand logo
    }
    if (sets.length === 0) {
      throw new BadRequestException('nothing to update');
    }

    const before = await this.getOrCreate(shopId);

    // INV-22: the write carries the version the writer read.
    values.push(shopId, patch.version);
    const result = await this.pool.query<TrackPageConfigRow>(
      `UPDATE track_page_config
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
        message: 'track page settings changed elsewhere; refresh and reapply (INV-22)',
        current,
      });
    }

    const after = configRowToView(result.rows[0]);
    // §12: settings changes are always audited (every S-value).
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: actor.memberId,
      action: 'settings.track-page.update',
      objectType: 'track_page_config',
      objectId: shopId,
      before,
      after,
    });
    return after;
  }
}
