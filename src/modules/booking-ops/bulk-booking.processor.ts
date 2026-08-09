import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { Job, Worker } from 'bullmq';
import { REDIS } from '../../redis/redis.module';
import { BOOKING_BULK_QUEUE, BulkBookingJobData } from './booking-ops.types';
import { BulkBookingService } from './bulk-booking.service';

/**
 * Thin BullMQ shell over BulkBookingService.processBatch — a plain
 * injectable method, unit-testable without Redis (the booking module's
 * pattern). §5.7 control 4: logs carry job IDs and error classes only.
 */
@Injectable()
export class BulkBookingProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BulkBookingProcessor.name);
  private worker: Worker<BulkBookingJobData> | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly bulk: BulkBookingService,
  ) {}

  onModuleInit(): void {
    // BullMQ blocking commands need their own connection with
    // maxRetriesPerRequest: null — duplicate the shared client.
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.worker = new Worker<BulkBookingJobData>(
      BOOKING_BULK_QUEUE,
      async (job: Job<BulkBookingJobData>) => {
        await this.bulk.processBatch(job.data);
      },
      // S-21: 2 concurrent bulk jobs per shop; worker-level concurrency of 2
      // plus the per-shop Redis counter in BulkBookingService enforce it.
      { connection, concurrency: 2 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`bulk booking job ${job?.id} failed: ${err.name}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
