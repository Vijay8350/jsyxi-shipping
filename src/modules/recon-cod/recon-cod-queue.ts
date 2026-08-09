import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { Job, Queue, Worker } from 'bullmq';
import { REDIS } from '../../redis/redis.module';
import { CodImportService } from './cod-import.service';
import { CodDueSweepService } from './cod-due-sweep.service';

export const RECON_COD_QUEUE = 'recon-cod';
export const JOB_PROCESS_BATCH = 'cod-process-batch';
export const JOB_DUE_SWEEP = 'cod-due-sweep';
const DUE_SWEEP_SCHEDULER_ID = 'cod-due-sweep-daily';
const STAGING_TTL_SECONDS = 24 * 3600;

export interface ProcessBatchJobData {
  shopId: string;
  batchId: string;
}

/** INV-1: staging keys are shop-scoped like every other queue/cache key. */
const stagingKey = (shopId: string, batchId: string): string =>
  `recon-cod:staging:${shopId}:${batchId}`;

/**
 * The recon-processing queue for COD remittance batches (§9.17.1: async
 * processing; plain method + thin shell, the booking/reports pattern).
 *
 * The uploaded file is staged in Redis (≤50 MB, §5.1, 24 h TTL) because a
 * BullMQ job payload is no place for it; the job carries IDs only. jobId =
 * batch id: a repeat enqueue of the same batch is a BullMQ no-op, and the
 * allocation path itself is idempotent on its per-row key.
 *
 * Also owns the daily F-21 due sweep repeatable job.
 */
@Injectable()
export class CodReconQueueService implements OnModuleInit, OnModuleDestroy {
  private queue: Queue | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private instance(): Queue {
    if (!this.queue) {
      this.queue = new Queue(RECON_COD_QUEUE, { connection: this.redis });
    }
    return this.queue;
  }

  async onModuleInit(): Promise<void> {
    // F-21 sweep: daily; the shop-local evaluation lives in the service.
    await this.instance().upsertJobScheduler(
      DUE_SWEEP_SCHEDULER_ID,
      { pattern: '30 0 * * *' },
      { name: JOB_DUE_SWEEP, data: {} },
    );
  }

  async stageFile(shopId: string, batchId: string, contentText: string): Promise<void> {
    await this.redis.set(stagingKey(shopId, batchId), contentText, 'EX', STAGING_TTL_SECONDS);
  }

  async enqueueBatchProcessing(data: ProcessBatchJobData): Promise<void> {
    await this.instance().add(JOB_PROCESS_BATCH, data, {
      jobId: `cod-batch:${data.batchId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: false,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    this.queue = null;
  }
}

/**
 * Thin BullMQ shell over CodImportService.processBatch /
 * CodDueSweepService.run — both plain injectable methods, unit-testable
 * without Redis. §5.7 control 4: logs carry job IDs and error classes only.
 */
@Injectable()
export class CodReconProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CodReconProcessor.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly importer: CodImportService,
    private readonly sweep: CodDueSweepService,
  ) {}

  onModuleInit(): void {
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.worker = new Worker(
      RECON_COD_QUEUE,
      async (job: Job) => {
        if (job.name === JOB_DUE_SWEEP) {
          await this.sweep.run();
          return;
        }
        if (job.name === JOB_PROCESS_BATCH) {
          const { shopId, batchId } = job.data as ProcessBatchJobData;
          const key = stagingKey(shopId, batchId);
          const contentText = await this.redis.get(key);
          if (contentText === null) {
            throw new Error(`staged file missing for batch ${batchId}`);
          }
          await this.importer.processBatch({ shopId, batchId, contentText });
          await this.redis.del(key);
        }
      },
      { connection, concurrency: 2 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`recon-cod job ${job?.id} failed: ${err.name}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
