import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { Job, Queue, Worker } from 'bullmq';
import { REDIS } from '../../redis/redis.module';
import { SyncBackWorkerService, SYNC_BACK_QUEUE_NAME } from './sync-back-worker.service';

/**
 * The §8.4 `shopify-sync` queue — a thin BullMQ shell over
 * SyncBackWorkerService.processDueBatch (a plain injectable method, unit-
 * testable without Redis). A repeatable sweep job drains due outbox rows;
 * retry timing lives on sync_outbox.next_attempt_at (S-48), not in BullMQ,
 * so the schedule survives worker restarts and is assertable from the DB.
 */

export const SYNC_BACK_QUEUE = SYNC_BACK_QUEUE_NAME;
const SWEEP_JOB = 'sweep';
const SWEEP_EVERY_MS = 15_000;

@Injectable()
export class SyncBackQueueService implements OnModuleInit, OnModuleDestroy {
  private queue: Queue | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private instance(): Queue {
    if (!this.queue) {
      this.queue = new Queue(SYNC_BACK_QUEUE, { connection: this.redis });
    }
    return this.queue;
  }

  async onModuleInit(): Promise<void> {
    // jobId keeps the repeat registration idempotent across restarts.
    await this.instance().add(
      SWEEP_JOB,
      {},
      { repeat: { every: SWEEP_EVERY_MS }, jobId: SWEEP_JOB, removeOnComplete: 100 },
    );
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
export class SyncBackProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncBackProcessor.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly syncWorker: SyncBackWorkerService,
  ) {}

  onModuleInit(): void {
    // BullMQ blocking commands need their own connection with
    // maxRetriesPerRequest: null — duplicate the shared client.
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.worker = new Worker(
      SYNC_BACK_QUEUE,
      async (job: Job) => {
        if (job.name !== SWEEP_JOB) return;
        await this.syncWorker.processDueBatch();
      },
      { connection },
    );
    this.worker.on('failed', (job, err) => {
      // §5.7 control 4: job ids and error class only — no PII, no payloads.
      this.logger.error(`shopify-sync job ${job?.id} failed: ${err.name}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
