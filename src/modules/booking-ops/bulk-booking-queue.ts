import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { REDIS } from '../../redis/redis.module';
import { BOOKING_BULK_QUEUE, BulkBookingJobData } from './booking-ops.types';

/**
 * The §9.5.2 bulk-booking queue (a sibling of the §5.7 `booking` queue, so a
 * 1,000-order batch never starves single bookings). Enqueue only — the
 * worker shell lives in bulk-booking.processor.ts, which keeps this file
 * dependency-free so BulkBookingService can inject it without a cycle.
 *
 * jobId = batch_id: a repeat enqueue of the same batch is a BullMQ no-op.
 * BullMQ retries apply to worker crashes only; processBatch is resumable
 * (orders already recorded in booking_batch.results are skipped).
 */
@Injectable()
export class BulkBookingQueueService implements OnModuleDestroy {
  private queue: Queue<BulkBookingJobData> | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private instance(): Queue<BulkBookingJobData> {
    if (!this.queue) {
      this.queue = new Queue<BulkBookingJobData>(BOOKING_BULK_QUEUE, { connection: this.redis });
    }
    return this.queue;
  }

  async enqueueBulkJob(data: BulkBookingJobData): Promise<void> {
    await this.instance().add('bulk', data, {
      jobId: data.batchId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: false, // failures stay inspectable; DLQ replay is §8.6
    });
  }

  async close(): Promise<void> {
    await this.queue?.close();
    this.queue = null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
