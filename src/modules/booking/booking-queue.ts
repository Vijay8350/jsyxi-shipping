import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { Job, Queue, Worker } from 'bullmq';
import { REDIS } from '../../redis/redis.module';
import type { BookingJobData } from './booking.types';
import { BookingWorkerService } from './booking-worker.service';

/**
 * The §5.7 `booking` queue — partitioned per Service: the job name carries
 * the service id (`book:{serviceId}`), so per-service metrics and any future
 * per-service worker split key off it; the per-courier rate limiter and
 * circuit breaker live in AdapterCallerService on the processing path.
 *
 * The worker shell (BookingProcessor) only wires BullMQ; every state
 * transition lives in BookingWorkerService.processBooking — a plain
 * injectable method, unit-testable without Redis.
 */

export const BOOKING_QUEUE = 'booking';

/** §5.7: the job name/key includes the Service. */
export function bookingJobName(serviceId: string): string {
  return `book:${serviceId}`;
}

@Injectable()
export class BookingQueueService implements OnModuleDestroy {
  private queue: Queue<BookingJobData> | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private instance(): Queue<BookingJobData> {
    if (!this.queue) {
      this.queue = new Queue<BookingJobData>(BOOKING_QUEUE, { connection: this.redis });
    }
    return this.queue;
  }

  /**
   * Enqueue one booking attempt. jobId = booking_intent_id, so a repeat
   * enqueue of the same attempt is a BullMQ no-op (§9.5.4 exactly-once).
   * BullMQ retries apply only to worker crashes — never to an ambiguous
   * create, which the worker settles as OUTCOME_UNKNOWN instead (INV-5).
   */
  async enqueueBooking(data: BookingJobData): Promise<void> {
    await this.instance().add(bookingJobName(data.serviceId), data, {
      jobId: data.bookingIntentId,
      attempts: 5,
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

@Injectable()
export class BookingProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingProcessor.name);
  private worker: Worker<BookingJobData> | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly bookingWorker: BookingWorkerService,
  ) {}

  onModuleInit(): void {
    // BullMQ blocking commands need their own connection with
    // maxRetriesPerRequest: null — duplicate the shared client.
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.worker = new Worker<BookingJobData>(
      BOOKING_QUEUE,
      async (job: Job<BookingJobData>) => {
        if (!job.name.startsWith('book:')) return;
        await this.bookingWorker.processBooking(job.data);
      },
      { connection },
    );
    this.worker.on('failed', (job, err) => {
      // §5.7 control 4: job IDs and error class only — no PII, no payloads.
      this.logger.error(`booking job ${job?.id} failed: ${err.name}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
