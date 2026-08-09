import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { UpsertScreenGuideDto } from './screen-guide.dto';
import { AdminContext } from './admin.types';

/**
 * ADD-33 per-screen guides: admin-managed video + short doc attached to any
 * named surface (rules, rate cards, reconciliation, …), live instantly —
 * plain DB writes on screen_guide, no release needed. The app shell reads
 * one row per screen through the merchant-facing endpoint.
 *
 * screen_guide is [global] (migration 0017): platform reference data, not
 * merchant data, so the merchant read carries no shop scoping by design.
 */
@Injectable()
export class ScreenGuideService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  async listGuides(): Promise<unknown[]> {
    const { rows } = await this.pool.query(
      `SELECT guide_id, surface_key, video_url, doc_text, updated_by, created_at, updated_at
         FROM screen_guide
        ORDER BY surface_key ASC`,
    );
    return rows;
  }

  /** Merchant-facing read (ADD-33): the app shell calls this per screen. */
  async getGuide(surfaceKey: string): Promise<unknown> {
    const { rows } = await this.pool.query(
      `SELECT surface_key, video_url, doc_text, updated_at
         FROM screen_guide
        WHERE surface_key = $1`,
      [surfaceKey],
    );
    if (rows.length === 0) throw new NotFoundException('no guide for this surface');
    return rows[0];
  }

  async upsertGuide(
    actor: AdminContext,
    surfaceKey: string,
    dto: UpsertScreenGuideDto,
  ): Promise<{ guideId: string }> {
    const before = await this.pool.query(
      `SELECT guide_id, video_url, doc_text FROM screen_guide WHERE surface_key = $1`,
      [surfaceKey],
    );
    try {
      const { rows } = await this.pool.query<{ guide_id: string }>(
        `INSERT INTO screen_guide (surface_key, video_url, doc_text, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (surface_key)
         DO UPDATE SET video_url = EXCLUDED.video_url,
                       doc_text = EXCLUDED.doc_text,
                       updated_by = EXCLUDED.updated_by
         RETURNING guide_id`,
        [surfaceKey, dto.videoUrl ?? null, dto.docText ?? null, actor.adminId],
      );
      await this.audit.record({
        actorKind: 'ADMIN',
        actorId: actor.adminId,
        action: before.rows.length > 0 ? 'admin_screen_guide.updated' : 'admin_screen_guide.created',
        objectType: 'screen_guide',
        objectId: rows[0].guide_id,
        before: before.rows[0] ?? undefined,
        after: { surface_key: surfaceKey, video_url: dto.videoUrl, doc_text: dto.docText },
      });
      return { guideId: rows[0].guide_id };
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('guide race — retry');
      throw err;
    }
  }

  async deleteGuide(actor: AdminContext, surfaceKey: string): Promise<void> {
    const { rows, rowCount } = await this.pool.query<{ guide_id: string }>(
      `DELETE FROM screen_guide WHERE surface_key = $1 RETURNING guide_id, video_url, doc_text`,
      [surfaceKey],
    );
    if (!rowCount) throw new NotFoundException('no guide for this surface');
    await this.audit.record({
      actorKind: 'ADMIN',
      actorId: actor.adminId,
      action: 'admin_screen_guide.deleted',
      objectType: 'screen_guide',
      objectId: rows[0].guide_id,
      before: { surface_key: surfaceKey, ...rows[0] },
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
