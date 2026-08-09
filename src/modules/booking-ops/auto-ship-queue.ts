import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { Job, Queue, Worker } from 'bullmq';
import { REDIS } from '../../redis/redis.module';
import { AutoShipService } from './auto-ship.service';
import {
  AUTO_SHIP_QUEUE,
  AUTO_SHIP_SWEEP_INTERVAL_MS,
  AUTO_SHIP_SWEEP_JOB,
} from './booking-ops.types';

/**
 * §9.5.3 auto-ship scheduling (A3-03): a BullMQ REPEATABLE job on the
 * `auto-ship` queue at the default cadence (every 5 minutes,
 * AUTO_SHIP_SWEEP_INTERVAL_MS). This is the ONLY trigger — auto-ship never
 * runs on the order webhook; no webhook handler anywhere references
 * AutoShipService.
 *
 * The processor is a thin shell over AutoShipService.runSweep — a plain
 * injectable method, unit-testable without Redis.
 */
@Injectable()
export class AutoShipScheduler implements OnModuleInit, OnModuleDestroy {
  private queue: Queue | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    this.queue = new Queue(AUTO_SHIP_QUEUE, { connection: this.redis });
    await this.queue.add(
      AUTO_SHIP_SWEEP_JOB,
      {},
      {
        jobId: AUTO_SHIP_SWEEP_JOB, // one scheduler record, not per-run jobs
        repeat: { every: AUTO_SHIP_SWEEP_INTERVAL_MS },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    this.queue = null;
  }
}

@Injectable()
export class AutoShipProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoShipProcessor.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly autoShip: AutoShipService,
  ) {}

  onModuleInit(): void {
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.worker = new Worker(
      AUTO_SHIP_QUEUE,
      async (job: Job) => {
        if (job.name !== AUTO_SHIP_SWEEP_JOB) return;
        await this.autoShip.runSweep();
      },
      { connection },
    );
    this.worker.on('failed', (job, err) => {
      // §5.7 control 4: job IDs and error class only — no PII.
      this.logger.error(`auto-ship job ${job?.id} failed: ${err.name}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
