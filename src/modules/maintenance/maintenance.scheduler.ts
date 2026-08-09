import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { REDIS } from '../../redis/redis.module';
import { PartitionMaintenanceService } from './partition-maintenance.service';

/**
 * §5.4/§5.1 maintenance scheduling — the thin BullMQ shell half. All logic
 * lives in the injectable services; this only owns the `maintenance` queue
 * and its two repeatable jobs:
 *
 *   retention-sweep          daily 03:30 (§5.4 horizons)
 *   partition-maintenance    monthly, 1st at 02:15 (§5.1)
 *
 * §5.1 also wants an on-startup partition check, so onModuleInit runs
 * ensurePartitions() once after (re)registering the schedulers — the DB
 * helpers create with IF NOT EXISTS, so this is cheap and idempotent.
 *
 * The Queue object is injectable-shaped (built from the shared REDIS
 * connection) so tests mock it — no Redis or BullMQ needed to test the
 * scheduling logic.
 */

export const MAINTENANCE_QUEUE = 'maintenance';
export const RETENTION_SWEEP_JOB = 'retention-sweep';
export const PARTITION_MAINTENANCE_JOB = 'partition-maintenance';

/** Daily at 03:30 server time (§5.4 sweep; low-traffic hour). */
export const RETENTION_SWEEP_CRON = '30 3 * * *';
/** Monthly on the 1st at 02:15 server time (§5.1 partitions ahead). */
export const PARTITION_MAINTENANCE_CRON = '15 2 1 * *';

@Injectable()
export class MaintenanceScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceScheduler.name);
  readonly queue: Queue;

  constructor(
    @Inject(REDIS) redis: Redis,
    private readonly partitions: PartitionMaintenanceService,
  ) {
    this.queue = new Queue(MAINTENANCE_QUEUE, { connection: redis });
  }

  async onModuleInit(): Promise<void> {
    await this.syncSchedules();
    // §5.1 on-startup check: partitions for the current + next months must
    // exist even between monthly runs (fresh deploys, long downtime).
    await this.partitions.ensurePartitions(new Date());
  }

  /** Unit-tested with a mocked queue: the two repeatable jobs, upserted. */
  async syncSchedules(): Promise<void> {
    await this.queue.upsertJobScheduler(
      RETENTION_SWEEP_JOB,
      { pattern: RETENTION_SWEEP_CRON },
      { name: RETENTION_SWEEP_JOB, data: {} },
    );
    await this.queue.upsertJobScheduler(
      PARTITION_MAINTENANCE_JOB,
      { pattern: PARTITION_MAINTENANCE_CRON },
      { name: PARTITION_MAINTENANCE_JOB, data: {} },
    );
    this.logger.log('maintenance schedulers synced (daily sweep, monthly partitions)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
