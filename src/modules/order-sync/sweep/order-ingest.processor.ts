import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { Job, Worker } from 'bullmq';
import { REDIS } from '../../../redis/redis.module';
import { OrderSweepService } from './order-sweep.service';
import { ORDER_INGEST_QUEUE, SWEEP_JOB_NAME } from './order-ingest.scheduler';

/**
 * Worker half of the §5.7 `order-ingest` queue: runs the S-15 sweep for the
 * shop named by the repeatable job. Failures surface to BullMQ's retry/DLQ
 * machinery (§8.6); the sweep itself is idempotent (same upsert path as the
 * webhooks), so a retried run is safe.
 */
@Injectable()
export class OrderIngestProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderIngestProcessor.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly sweep: OrderSweepService,
  ) {}

  onModuleInit(): void {
    // BullMQ blocking commands need their own connection with
    // maxRetriesPerRequest: null — duplicate the shared client.
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.worker = new Worker(
      ORDER_INGEST_QUEUE,
      async (job: Job<{ shopId?: string }>) => {
        if (job.name !== SWEEP_JOB_NAME || !job.data.shopId) return;
        await this.sweep.runShopSweep(job.data.shopId);
      },
      { connection },
    );
    this.worker.on('failed', (job, err) => {
      // §5.7 control 4: job IDs only.
      this.logger.error(`order-ingest job ${job?.id} failed: ${err.name}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
