import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { Job, Worker } from 'bullmq';
import { REDIS } from '../../redis/redis.module';
import { LABEL_QUEUE, LabelJobData } from './labels.types';
import { BulkLabelsService } from './bulk-labels.service';

/**
 * Thin BullMQ shell over BulkLabelsService.processBulkJob — a plain
 * injectable method, unit-testable without Redis (the booking module's
 * pattern). §5.7 control 4: logs carry job IDs and error classes only.
 */
@Injectable()
export class LabelProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LabelProcessor.name);
  private worker: Worker<LabelJobData> | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly bulk: BulkLabelsService,
  ) {}

  onModuleInit(): void {
    // BullMQ blocking commands need their own connection with
    // maxRetriesPerRequest: null — duplicate the shared client.
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.worker = new Worker<LabelJobData>(
      LABEL_QUEUE,
      async (job: Job<LabelJobData>) => {
        await this.bulk.processBulkJob(job.data);
      },
      // S-21-style bound: two concurrent label jobs per worker.
      { connection, concurrency: 2 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`label job ${job?.id} failed: ${err.name}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
