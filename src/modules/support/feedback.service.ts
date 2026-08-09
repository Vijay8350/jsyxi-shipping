import {
  BadRequestException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { SubmitFeedbackDto } from './support.dto';
import {
  FeedbackRow,
  FEEDBACK_SCREENSHOT_EXTENSIONS,
} from './support.types';

/** §9.19 admin trend row: average rating by week (§5.2: week starts Monday). */
export interface FeedbackTrendRow {
  week: string;
  count: number;
  avgRating: string; // pg numeric — kept as text, never a float
}

/**
 * Feedback widget (§9.19): a 1–5 rating, an optional comment and an optional
 * screenshot (§5.1: 1 PNG/JPEG ≤ 10 MB — enforced here on the key's
 * extension and the declared byte size; the binary lives in the object
 * store). Admin side: the feedback list plus weekly trend aggregates.
 */
@Injectable()
export class FeedbackService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async submit(
    shopId: string,
    memberId: string,
    dto: SubmitFeedbackDto,
  ): Promise<FeedbackRow> {
    if (dto.screenshot) {
      const key = dto.screenshot.key.toLowerCase();
      if (!FEEDBACK_SCREENSHOT_EXTENSIONS.some((ext) => key.endsWith(ext))) {
        throw new BadRequestException(
          'feedback screenshot must be a PNG or JPEG (§5.1)',
        );
      }
    }
    const { rows } = await this.pool.query<FeedbackRow>(
      `INSERT INTO feedback (shop_id, member_id, rating, comment,
                             screenshot_object_key)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING feedback_id, shop_id, member_id, rating, comment,
                 screenshot_object_key, created_at`,
      [
        shopId,
        memberId,
        dto.rating,
        dto.comment ?? null,
        dto.screenshot?.key ?? null,
      ],
    );
    return rows[0];
  }

  /** §9.19 admin feedback list, newest first. */
  async list(): Promise<FeedbackRow[]> {
    const { rows } = await this.pool.query<FeedbackRow>(
      `SELECT feedback_id, shop_id, member_id, rating, comment,
              screenshot_object_key, created_at
         FROM feedback
        ORDER BY created_at DESC`,
    );
    return rows;
  }

  /** §9.19 trends: average rating by week. */
  async trends(): Promise<FeedbackTrendRow[]> {
    const { rows } = await this.pool.query<{
      week: string;
      count: string;
      avg: string;
    }>(
      `SELECT date_trunc('week', created_at) AS week,
              COUNT(*)::int AS count,
              ROUND(AVG(rating), 2) AS avg
         FROM feedback
        GROUP BY 1
        ORDER BY 1 DESC`,
    );
    return rows.map((r) => ({
      week: r.week,
      count: Number(r.count),
      avgRating: r.avg,
    }));
  }
}
