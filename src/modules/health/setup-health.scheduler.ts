import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';

/**
 * ADD-29 hourly recompute sweep — scheduling half. On module init each
 * active shop gets one repeatable hourly job keyed
 * `shop-recompute:{shop_id}` (INV-1: queue keys are shop-scoped); shops in
 * UNINSTALLED get none and any stale scheduler of theirs is removed (§5.5).
 * Mirrors the order-ingest scheduler pattern.
 *
 * The Queue object is injectable (SETUP_HEALTH_QUEUE) so tests mock it —
 * no Redis or BullMQ needs to be running to test the scheduling logic.
 */

export const SETUP_HEALTH_QUEUE = 'setup-health';
export const RECOMPUTE_JOB_NAME = 'shop-recompute';
export const RECOMPUTE_REPEAT_MS = 60 * 60 * 1000; // hourly (ADD-29)

export interface ShopScheduleRow {
  shop_id: string;
  account_state: string;
}

@Injectable()
export class SetupHealthScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SetupHealthScheduler.name);
  readonly queue: Queue;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) redis: Redis,
  ) {
    this.queue = new Queue(SETUP_HEALTH_QUEUE, { connection: redis });
  }

  async onModuleInit(): Promise<void> {
    const { rows } = await this.pool.query<ShopScheduleRow>(
      `SELECT shop_id, account_state FROM shop`,
    );
    await this.syncSchedules(rows);
  }

  /** Pure-ish scheduling pass over the shop list — unit-tested with a
   *  mocked queue. */
  async syncSchedules(
    shops: ShopScheduleRow[],
  ): Promise<{ scheduled: number; removed: number }> {
    let scheduled = 0;
    let removed = 0;
    for (const shop of shops) {
      const schedulerId = `${RECOMPUTE_JOB_NAME}:${shop.shop_id}`;
      if (shop.account_state === 'UNINSTALLED') {
        // §5.5: uninstall disables schedules and queued jobs.
        await this.queue.removeJobScheduler(schedulerId);
        removed += 1;
        continue;
      }
      await this.queue.upsertJobScheduler(
        schedulerId,
        { every: RECOMPUTE_REPEAT_MS },
        { name: RECOMPUTE_JOB_NAME, data: { shopId: shop.shop_id } },
      );
      scheduled += 1;
    }
    this.logger.log(
      `setup-health schedulers synced scheduled=${scheduled} removed=${removed}`,
    );
    return { scheduled, removed };
  }

  /** Recompute on demand — enqueue an immediate one-off job for the shop. */
  async enqueueRecompute(shopId: string): Promise<void> {
    await this.queue.add(RECOMPUTE_JOB_NAME, { shopId });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
