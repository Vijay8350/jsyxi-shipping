import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { Job, Queue, Worker } from 'bullmq';
import { REDIS } from '../../redis/redis.module';
import { ReconProcessingService } from './recon-processing.service';
import {
  RECON_PROCESSING_QUEUE,
  RECON_PROCESS_BATCH_JOB,
} from './recon-freight.types';

/**
 * The `recon-processing` BullMQ shell (§5.7 queue list). Thin only — every
 * rule lives in ReconProcessingService.processBatch, unit-tested without
 * Redis. S-48-shaped retry (§8.6); a batch whose job exhausts attempts is
 * already FAILED or lands in the §8.6 DLQ with an alert.
 */

export interface ReconProcessJobData {
  batchId: string;
}

@Injectable()
export class ReconFreightQueue implements OnModuleDestroy {
  private queue: Queue | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private instance(): Queue {
    if (!this.queue) {
      this.queue = new Queue(RECON_PROCESSING_QUEUE, { connection: this.redis });
    }
    return this.queue;
  }

  async enqueueProcessBatch(batchId: string): Promise<void> {
    await this.instance().add(
      RECON_PROCESS_BATCH_JOB,
      { batchId } satisfies ReconProcessJobData,
      {
        jobId: `freight-batch-${batchId}`, // one job per batch — retries dedupe
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 100,
        removeOnFail: false,
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    this.queue = null;
  }
}

@Injectable()
export class ReconFreightProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconFreightProcessor.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly processing: ReconProcessingService,
  ) {}

  onModuleInit(): void {
    // BullMQ blocking commands need their own connection (see tracking-queue).
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.worker = new Worker(
      RECON_PROCESSING_QUEUE,
      async (job: Job<ReconProcessJobData>) => {
        if (job.name === RECON_PROCESS_BATCH_JOB) {
          await this.processing.processBatch(job.data.batchId);
        }
      },
      { connection },
    );
    this.worker.on('failed', (job, err) => {
      // §5.7 control 4: job ids and error class only — no file content.
      this.logger.error(`recon-processing job ${job?.id} failed: ${err.name}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
