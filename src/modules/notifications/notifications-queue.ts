import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import { Job, Queue, Worker } from 'bullmq';
import { REDIS } from '../../redis/redis.module';
import { DigestService } from './digest.service';
import { CodConfirmationService } from './cod-confirmation.service';

/**
 * The notifications queue (§5.7 background-work pattern): two repeatable
 * jobs —
 *   digest-tick  every hour   → DigestService.runDigestTick (§9.21 digests,
 *                               shop-local due check inside, §5.2)
 *   cod-sweep    every minute → CodConfirmationService.sweepExpired (ADD-28)
 *
 * The worker shell only wires BullMQ; all behaviour lives in plain
 * injectable methods, unit-testable without Redis.
 */
export const NOTIFICATIONS_QUEUE = 'notifications';

export const DIGEST_TICK_JOB = 'digest-tick';
export const COD_SWEEP_JOB = 'cod-sweep';

const DIGEST_TICK_EVERY_MS = 60 * 60 * 1000;
const COD_SWEEP_EVERY_MS = 60 * 1000;

@Injectable()
export class NotificationsQueueService implements OnModuleInit, OnModuleDestroy {
  private queue: Queue | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    this.queue = new Queue(NOTIFICATIONS_QUEUE, { connection: this.redis });
    await this.queue.upsertJobScheduler(DIGEST_TICK_JOB, {
      every: DIGEST_TICK_EVERY_MS,
    });
    await this.queue.upsertJobScheduler(COD_SWEEP_JOB, {
      every: COD_SWEEP_EVERY_MS,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    this.queue = null;
  }
}

@Injectable()
export class NotificationsProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsProcessor.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly digests: DigestService,
    private readonly codConfirmations: CodConfirmationService,
  ) {}

  onModuleInit(): void {
    // BullMQ blocking commands need their own connection (booking-queue pattern).
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.worker = new Worker(
      NOTIFICATIONS_QUEUE,
      async (job: Job) => {
        if (job.name === DIGEST_TICK_JOB) await this.digests.runDigestTick();
        else if (job.name === COD_SWEEP_JOB) {
          await this.codConfirmations.sweepExpired();
        }
      },
      { connection },
    );
    this.worker.on('failed', (job, err) => {
      // §5.7 control 4: job id and error class only — no payloads.
      this.logger.error(`notifications job ${job?.id} failed: ${err.name}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
