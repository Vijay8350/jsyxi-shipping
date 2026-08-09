import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { Job, Queue, Worker } from 'bullmq';
import { REDIS } from '../../redis/redis.module';
import { AccountSweepService } from './account-sweep.service';
import {
  BILLING_QUEUE,
  BILLING_SWEEP_INTERVAL_MS,
  BILLING_SWEEP_JOB,
} from './billing.types';

/**
 * §3.11/§9.14 daily account-state sweep scheduling: one BullMQ REPEATABLE
 * job on the `billing` queue. The processor is a thin shell over
 * AccountSweepService.runDailySweep — a plain injectable method,
 * unit-testable without Redis.
 */
@Injectable()
export class BillingScheduler implements OnModuleInit, OnModuleDestroy {
  private queue: Queue | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    this.queue = new Queue(BILLING_QUEUE, { connection: this.redis });
    await this.queue.add(
      BILLING_SWEEP_JOB,
      {},
      {
        jobId: BILLING_SWEEP_JOB, // one scheduler record, not per-run jobs
        repeat: { every: BILLING_SWEEP_INTERVAL_MS },
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
export class BillingProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingProcessor.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly sweep: AccountSweepService,
  ) {}

  onModuleInit(): void {
    // BullMQ blocking commands need their own connection with
    // maxRetriesPerRequest: null — duplicate the shared client.
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.worker = new Worker(
      BILLING_QUEUE,
      async (job: Job) => {
        if (job.name !== BILLING_SWEEP_JOB) return;
        await this.sweep.runDailySweep();
      },
      { connection },
    );
    this.worker.on('failed', (job, err) => {
      // §5.7 control 4: job IDs and error class only — no PII.
      this.logger.error(`billing job ${job?.id} failed: ${err.name}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
