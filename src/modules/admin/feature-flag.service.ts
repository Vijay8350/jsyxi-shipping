import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { UpsertFeatureFlagDto } from './feature-flag.dto';
import { AdminContext } from './admin.types';

/**
 * §9.13 feature flags (PLATFORM_ADMIN, §10.3). feature_flag is [global] with
 * GLOBAL or SHOP scope (migration 0002); a SHOP-scoped row names its shop_id,
 * a GLOBAL row never does. The unique index is (key, COALESCE(shop_id, …)),
 * so upsert keys on (key, shop_id-or-null).
 */
@Injectable()
export class FeatureFlagService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  async listFlags(shopId?: string): Promise<unknown[]> {
    const { rows } = await this.pool.query(
      `SELECT flag_id, key, scope, shop_id, enabled, created_at, updated_at
         FROM feature_flag
        WHERE ($1::uuid IS NULL OR shop_id = $1)
        ORDER BY key ASC, scope ASC`,
      [shopId ?? null],
    );
    return rows;
  }

  async upsertFlag(actor: AdminContext, dto: UpsertFeatureFlagDto): Promise<{ flagId: string }> {
    const shopId = dto.scope === 'SHOP' ? dto.shopId ?? null : null;
    if (dto.scope === 'SHOP' && !shopId) {
      throw new BadRequestException('shopId is required for SHOP scope');
    }
    if (dto.scope === 'GLOBAL' && dto.shopId) {
      throw new BadRequestException('a GLOBAL flag never names a shop');
    }
    const { rows } = await this.pool.query<{ flag_id: string; was_update: boolean }>(
      `INSERT INTO feature_flag (key, scope, shop_id, enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key, COALESCE(shop_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO UPDATE SET enabled = EXCLUDED.enabled
       RETURNING flag_id, (xmax <> 0) AS was_update`,
      [dto.key, dto.scope, shopId, dto.enabled],
    );
    await this.audit.record({
      actorKind: 'ADMIN',
      actorId: actor.adminId,
      action: rows[0].was_update ? 'admin_feature_flag.updated' : 'admin_feature_flag.created',
      objectType: 'feature_flag',
      objectId: rows[0].flag_id,
      after: { key: dto.key, scope: dto.scope, shop_id: shopId, enabled: dto.enabled },
    });
    return { flagId: rows[0].flag_id };
  }

  async deleteFlag(actor: AdminContext, flagId: string): Promise<void> {
    const { rows, rowCount } = await this.pool.query(
      `DELETE FROM feature_flag WHERE flag_id = $1
       RETURNING flag_id, key, scope, shop_id, enabled`,
      [flagId],
    );
    if (!rowCount) throw new NotFoundException('feature flag not found');
    await this.audit.record({
      actorKind: 'ADMIN',
      actorId: actor.adminId,
      action: 'admin_feature_flag.deleted',
      objectType: 'feature_flag',
      objectId: flagId,
      before: rows[0],
    });
  }
}
