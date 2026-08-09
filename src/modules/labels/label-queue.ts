import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { REDIS } from '../../redis/redis.module';
import { LABEL_QUEUE, LabelJobData } from './labels.types';

/**
 * The §5.7 `label` queue — enqueue only; the worker shell lives in
 * label.processor.ts, keeping this file dependency-free so
 * BulkLabelsService can inject it without a cycle (the bulk-booking pattern).
 *
 * jobId = document_job.job_id: a repeat enqueue of the same job is a BullMQ
 * no-op, and processBulkJob is idempotent against worker retries.
 */
@Injectable()
export class LabelQueueService implements OnModuleDestroy {
  private queue: Queue<LabelJobData> | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private instance(): Queue<LabelJobData> {
    if (!this.queue) {
      this.queue = new Queue<LabelJobData>(LABEL_QUEUE, { connection: this.redis });
    }
    return this.queue;
  }

  async enqueueLabelJob(data: LabelJobData): Promise<void> {
    await this.instance().add('bulk-label', data, {
      jobId: data.jobId,
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
