import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { ShopifySyncMutations } from './shopify-sync.mutations';
import { SyncCostBudget, THROTTLE_DEFER_MS } from './cost-budget';
import { SYNC_MAX_ATTEMPTS, nextAttemptAt } from './retry-policy';
import type {
  AddFulfillmentEventPayload,
  CancelFulfillmentPayload,
  CreateFulfillmentPayload,
  SetOrderTagsPayload,
  SyncOutboxRow,
} from './sync-back.types';

/**
 * The §3.17 outbox machine (PENDING/RETRYING → IN_FLIGHT → SUCCEEDED |
 * RETRYING | DEAD) over §8.4 Shopify writes. All logic lives in plain
 * injectable methods — the BullMQ shell in sync-back-queue.ts only calls
 * processDueBatch, so everything here is unit-testable without Redis/BullMQ.
 *
 *  - Claim: due rows (next_attempt_at ≤ now) FOR UPDATE SKIP LOCKED, so
 *    concurrent workers never double-execute (A1-10).
 *  - §8.4 cost budget: throttled rows are deferred without consuming an
 *    attempt — pacing, not failure.
 *  - S-48 (§8.6): failure → attempts++, RETRYING with the deterministic
 *    backoff; the 10th failure → DEAD + Shop-scoped dlq_item + audit.
 *  - Logs carry ids and error classes only (§5.7 control 4, INV-18).
 */

export const SYNC_BACK_QUEUE_NAME = 'shopify-sync';

@Injectable()
export class SyncBackWorkerService {
  private readonly logger = new Logger(SyncBackWorkerService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly mutations: ShopifySyncMutations,
    private readonly budget: SyncCostBudget,
    private readonly audit: AuditService,
  ) {}

  /** Claim due rows and move them to IN_FLIGHT. */
  async claimDueBatch(limit = 25, now: Date = new Date()): Promise<SyncOutboxRow[]> {
    const { rows } = await this.pool.query<SyncOutboxRow>(
      `UPDATE sync_outbox
          SET state = 'IN_FLIGHT', version = version + 1
        WHERE outbox_id IN (
          SELECT outbox_id FROM sync_outbox
           WHERE state IN ('PENDING', 'RETRYING')
             AND next_attempt_at <= $1
           ORDER BY next_attempt_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING outbox_id, shop_id, order_id, shipment_id, operation, payload,
                  state, attempts, next_attempt_at, idempotency_key, version`,
      [now.toISOString(), limit],
    );
    return rows;
  }

  /** The BullMQ processor's entry point: claim a due batch and execute it. */
  async processDueBatch(limit = 25, now: Date = new Date()): Promise<void> {
    const claimed = await this.claimDueBatch(limit, now);
    for (const row of claimed) {
      await this.processClaimed(row, now);
    }
  }

  /**
   * Execute one IN_FLIGHT row through the §3.17 machine. Exported for the
   * tests; the queue only ever calls processDueBatch.
   */
  async processClaimed(row: SyncOutboxRow, now: Date = new Date()): Promise<void> {
    // §8.4 per-Shop cost budget: defer, never consume an attempt.
    const allowed = await this.budget.tryConsume(row.shop_id);
    if (!allowed) {
      await this.defer(row, now);
      return;
    }
    try {
      const fulfillmentGid = await this.execute(row);
      await this.markSucceeded(row, fulfillmentGid);
    } catch (err) {
      await this.handleFailure(row, err as Error, now);
    }
  }

  /** Throttled by the §8.4 budget: back to its pre-claim state, +1s, no attempt. */
  private async defer(row: SyncOutboxRow, now: Date): Promise<void> {
    const backTo = row.attempts > 0 ? 'RETRYING' : 'PENDING';
    await this.pool.query(
      `UPDATE sync_outbox
          SET state = $2, next_attempt_at = $3, version = version + 1
        WHERE outbox_id = $1`,
      [row.outbox_id, backTo, new Date(now.getTime() + THROTTLE_DEFER_MS).toISOString()],
    );
    this.logger.debug(`sync outbox ${row.outbox_id} deferred by cost budget`);
  }

  /** Returns the fulfillment GID when a CREATE succeeded, else null. */
  private async execute(row: SyncOutboxRow): Promise<string | null> {
    switch (row.operation) {
      case 'CREATE_FULFILLMENT':
        return this.mutations.createFulfillment(row.shop_id, row.payload as CreateFulfillmentPayload);
      case 'ADD_FULFILLMENT_EVENT': {
        const payload = row.payload as AddFulfillmentEventPayload;
        // Re-resolve at run time: the create may have succeeded after this
        // event was enqueued.
        payload.fulfillmentGid =
          payload.fulfillmentGid ?? (await this.succeededFulfillmentGid(row));
        await this.mutations.addFulfillmentEvent(row.shop_id, payload);
        return null;
      }
      case 'CANCEL_FULFILLMENT': {
        const payload = row.payload as CancelFulfillmentPayload;
        payload.fulfillmentGid =
          payload.fulfillmentGid ?? (await this.succeededFulfillmentGid(row));
        await this.mutations.cancelFulfillment(row.shop_id, payload);
        return null;
      }
      case 'SET_ORDER_TAGS':
        await this.mutations.setOrderTags(row.shop_id, row.payload as SetOrderTagsPayload);
        return null;
    }
  }

  private async succeededFulfillmentGid(row: SyncOutboxRow): Promise<string | null> {
    if (!row.shipment_id) return null;
    const { rows } = await this.pool.query<{ gid: string | null }>(
      `SELECT payload ->> 'fulfillmentGid' AS gid
         FROM sync_outbox
        WHERE shop_id = $1 AND shipment_id = $2
          AND operation = 'CREATE_FULFILLMENT' AND state = 'SUCCEEDED'
        ORDER BY updated_at DESC
        LIMIT 1`,
      [row.shop_id, row.shipment_id],
    );
    return rows[0]?.gid ?? null;
  }

  /** §3.17: SUCCEEDED is terminal. */
  private async markSucceeded(row: SyncOutboxRow, fulfillmentGid: string | null): Promise<void> {
    if (fulfillmentGid) {
      // Persist the GID so CANCEL/EVENT executions can find it (§8.4).
      await this.pool.query(
        `UPDATE sync_outbox
            SET state = 'SUCCEEDED',
                payload = payload || jsonb_build_object('fulfillmentGid', $2::text),
                version = version + 1
          WHERE outbox_id = $1`,
        [row.outbox_id, fulfillmentGid],
      );
      return;
    }
    await this.pool.query(
      `UPDATE sync_outbox
          SET state = 'SUCCEEDED', version = version + 1
        WHERE outbox_id = $1`,
      [row.outbox_id],
    );
  }

  /**
   * S-48 (§8.6): attempts++, RETRYING with the deterministic backoff; the
   * 10th failure moves the row to DEAD with a Shop-scoped dlq_item + audit
   * (A1-10). DEAD exits only via the audited admin replay (§3.17).
   */
  private async handleFailure(row: SyncOutboxRow, err: Error, now: Date): Promise<void> {
    const attempts = row.attempts + 1;
    this.logger.warn(`sync outbox ${row.outbox_id} attempt ${attempts} failed: ${err.name}`);
    if (attempts >= SYNC_MAX_ATTEMPTS) {
      await this.pool.query(
        `UPDATE sync_outbox
            SET state = 'DEAD', attempts = $2, version = version + 1
          WHERE outbox_id = $1`,
        [row.outbox_id, attempts],
      );
      await this.pool.query(
        `INSERT INTO dlq_item (shop_id, queue, payload, error, attempts)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          row.shop_id,
          SYNC_BACK_QUEUE_NAME,
          JSON.stringify({ outbox_id: row.outbox_id, operation: row.operation }),
          // Error class + message only — payloads and PII never (§5.7.4).
          `${err.name}: ${err.message}`.slice(0, 500),
          attempts,
        ],
      );
      await this.audit.record({
        shopId: row.shop_id,
        actorKind: 'SYSTEM',
        action: 'sync_outbox.dead',
        objectType: 'sync_outbox',
        objectId: row.outbox_id,
        before: { state: 'IN_FLIGHT', attempts: row.attempts },
        after: { state: 'DEAD', attempts },
        reason: `${err.name}`,
      });
      return;
    }
    await this.pool.query(
      `UPDATE sync_outbox
          SET state = 'RETRYING', attempts = $2, next_attempt_at = $3,
              version = version + 1
        WHERE outbox_id = $1`,
      [row.outbox_id, attempts, nextAttemptAt(now, attempts, row.idempotency_key).toISOString()],
    );
  }
}
