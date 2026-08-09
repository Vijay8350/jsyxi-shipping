import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { Job, Queue, Worker } from 'bullmq';
import { REDIS } from '../../redis/redis.module';
import { RollupService } from './rollup.service';

/**
 * The hourly rollup job (§5.7: dashboard figures come from MAINTAINED
 * hourly rollup tables; §5.2: freshness ≤75 min — an hourly cadence plus
 * job latency stays inside that bound).
 *
 * Queue note: §5.7's queue list predates the rollup job and names no queue
 * for it; `dashboard-rollup` is the shop-scoped-safe choice — the reports
 * module owns `reports`, and a stuck report import must never delay the
 * rollup past the §5.2 freshness bound. One repeatable job per hour; the
 * sweep itself fans out per shop inside RollupService.runHourlySweep.
 *
 * Thin shell only — all logic lives in the plain injectable
 * RollupService.runHourlySweep, unit-tested without Redis.
 */

export const DASHBOARD_ROLLUP_QUEUE = 'dashboard-rollup';
export const HOURLY_ROLLUP_JOB = 'hourly-rollup';
export const HOURLY_ROLLUP_INTERVAL_MS = 3600_000;

@Injectable()
export class RollupQueueService implements OnModuleDestroy {
  private queue: Queue | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private instance(): Queue {
    if (!this.queue) {
      this.queue = new Queue(DASHBOARD_ROLLUP_QUEUE, { connection: this.redis });
    }
    return this.queue;
  }

  /** One repeatable hourly sweep. S-48-shaped retry; failures stay for the §8.6 DLQ. */
  async scheduleHourlyRollup(): Promise<void> {
    await this.instance().add(
      HOURLY_ROLLUP_JOB,
      {},
      {
        jobId: HOURLY_ROLLUP_JOB, // one scheduler record for the repeat
        repeat: { every: HOURLY_ROLLUP_INTERVAL_MS },
        attempts: 5,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: 100,
        removeOnFail: false,
      },
    );
  }

  async close(): Promise<void> {
    await this.queue?.close();
    this.queue = null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}

@Injectable()
export class RollupScheduler implements OnModuleInit {
  constructor(private readonly queue: RollupQueueService) {}

  async onModuleInit(): Promise<void> {
    await this.queue.scheduleHourlyRollup();
  }
}

@Injectable()
export class RollupProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RollupProcessor.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly rollup: RollupService,
  ) {}

  onModuleInit(): void {
    // BullMQ blocking commands need their own connection (see tracking-queue).
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.worker = new Worker(
      DASHBOARD_ROLLUP_QUEUE,
      async (job: Job) => {
        if (job.name === HOURLY_ROLLUP_JOB) {
          await this.rollup.runHourlySweep();
        }
      },
      { connection },
    );
    this.worker.on('failed', (job, err) => {
      // §5.7 control 4: job IDs and error class only — no PII, no payloads.
      this.logger.error(`dashboard-rollup job ${job?.id} failed: ${err.name}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
