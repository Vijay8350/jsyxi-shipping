import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { DEFAULT_TIMEZONE } from './cod-state';

/**
 * F-21 due sweep: AWAITING / SHORT expectations whose due date has passed
 * become PENDING_OVERDUE (§3.15, §4.8). TALLIED and EXCESS are full
 * allocations and are left alone; RTO_UNCOLLECTED is terminal.
 *
 * Shop-local aware (§5.2): "past due" compares the DATE column against the
 * shop's own local current date, computed per row from store_settings.timezone
 * (S-2, default Asia/Kolkata). Runs daily from the recon-cod queue scheduler.
 */
@Injectable()
export class CodDueSweepService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  /** One daily pass over every shop. Returns per-shop flip counts. */
  async run(): Promise<{ shopId: string; flipped: number }[]> {
    const res = await this.pool.query<{ shop_id: string; n: number }>(
      `WITH flipped AS (
         UPDATE recon_cod_expected e
            SET state = 'PENDING_OVERDUE', version = e.version + 1
          WHERE e.state IN ('AWAITING', 'SHORT')
            AND e.due_at < (now() AT TIME ZONE COALESCE(
                  (SELECT ss.timezone FROM store_settings ss
                    WHERE ss.shop_id = e.shop_id),
                  $1))::date
          RETURNING e.shop_id
       )
       SELECT shop_id, count(*)::int AS n FROM flipped GROUP BY shop_id`,
      [DEFAULT_TIMEZONE],
    );
    for (const row of res.rows) {
      await this.audit.record({
        shopId: row.shop_id,
        actorKind: 'SYSTEM',
        action: 'recon_cod.due_sweep',
        objectType: 'recon_cod_expected',
        after: { flipped_to_pending_overdue: row.n },
      });
    }
    return res.rows.map((r) => ({ shopId: r.shop_id, flipped: r.n }));
  }
}
