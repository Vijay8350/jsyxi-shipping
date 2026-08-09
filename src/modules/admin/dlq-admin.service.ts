import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { AdminContext } from './admin.types';

/**
 * §8.6 / §3.17 DLQ listing + admin replay (A1-10). Replay is admin-only —
 * §10.2 denies it to every merchant role and §10.3 grants it to
 * PLATFORM_ADMIN (enforced at the controller). Every replay is audited (§12).
 *
 * For outbox-backed queues (the Shopify sync-outbox, §3.17) replay returns
 * the underlying sync_outbox row to PENDING so the normal worker picks it up;
 * the dlq_item itself is marked replayed_at + replayed_by in every case.
 * dlq_item rows are listed per shop / queue — the list is platform-wide for
 * admins but each row remains shop-scoped data (INV-1 at the row level).
 */

/** Queues whose dlq_item payload carries a sync_outbox reference (§3.17). */
export const OUTBOX_BACKED_QUEUES: readonly string[] = ['sync_outbox', 'shopify-sync'];

export interface DlqListOptions {
  shopId?: string;
  queue?: string;
  includeReplayed?: boolean;
  limit?: number;
  offset?: number;
}

@Injectable()
export class DlqAdminService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  async listItems(options: DlqListOptions = {}): Promise<unknown[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const { rows } = await this.pool.query(
      `SELECT dlq_id, shop_id, queue, error, attempts, failed_at, replayed_at, replayed_by
         FROM dlq_item
        WHERE ($1::uuid IS NULL OR shop_id = $1)
          AND ($2::text IS NULL OR queue = $2)
          AND ($3::boolean OR replayed_at IS NULL)
        ORDER BY failed_at DESC
        LIMIT $4 OFFSET $5`,
      [options.shopId ?? null, options.queue ?? null, options.includeReplayed ?? false, limit, offset],
    );
    return rows;
  }

  /**
   * §3.17: "DEAD is exited only by an authorized admin replay, which returns
   * the item to PENDING; every replay is audited (A1-10)."
   */
  async replay(actor: AdminContext, dlqId: string): Promise<{ outboxReturnedToPending: boolean }> {
    const found = await this.pool.query<{
      dlq_id: string;
      shop_id: string;
      queue: string;
      payload: Record<string, unknown>;
      replayed_at: Date | null;
    }>(
      `SELECT dlq_id, shop_id, queue, payload, replayed_at
         FROM dlq_item WHERE dlq_id = $1`,
      [dlqId],
    );
    const item = found.rows[0];
    if (!item) throw new NotFoundException('dlq item not found');
    if (item.replayed_at) throw new ConflictException('dlq item already replayed');

    let outboxReturnedToPending = false;
    const outboxId =
      typeof item.payload === 'object' && item.payload !== null
        ? (item.payload['outbox_id'] as string | undefined)
        : undefined;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (OUTBOX_BACKED_QUEUES.includes(item.queue) && outboxId) {
        // Return the dead outbox row to PENDING — INV-5's ambiguous-booking
        // carve-out never lands in this queue, so the generic path is safe.
        const updated = await client.query(
          `UPDATE sync_outbox
              SET state = 'PENDING', next_attempt_at = now(), version = version + 1
            WHERE outbox_id = $1 AND shop_id = $2 AND state = 'DEAD'`,
          [outboxId, item.shop_id],
        );
        outboxReturnedToPending = (updated.rowCount ?? 0) > 0;
      }
      await client.query(
        `UPDATE dlq_item SET replayed_at = now(), replayed_by = $2 WHERE dlq_id = $1`,
        [dlqId, actor.adminId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await this.audit.record({
      shopId: item.shop_id,
      actorKind: 'ADMIN',
      actorId: actor.adminId,
      action: 'dlq.replayed', // §12 always-audited list: "DLQ replay"
      objectType: 'dlq_item',
      objectId: dlqId,
      before: { queue: item.queue, replayed_at: null },
      after: { queue: item.queue, outbox_returned_to_pending: outboxReturnedToPending },
    });
    return { outboxReturnedToPending };
  }
}
