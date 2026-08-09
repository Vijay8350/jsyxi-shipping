import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import { Job, Worker } from 'bullmq';
import { REDIS } from '../../redis/redis.module';
import { SetupHealthService } from './setup-health.service';
import {
  RECOMPUTE_JOB_NAME,
  SETUP_HEALTH_QUEUE,
} from './setup-health.scheduler';

/**
 * Worker half of the ADD-29 `setup-health` queue: a thin shell that runs
 * SetupHealthService.compute() for the shop named by the repeatable job.
 * All logic lives in the injectable service — unit-testable without Redis.
 * The recompute is idempotent (upsert preserving first_detected_at), so a
 * retried run is safe; failures surface to BullMQ's retry/DLQ machinery.
 */
@Injectable()
export class SetupHealthProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SetupHealthProcessor.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly health: SetupHealthService,
  ) {}

  onModuleInit(): void {
    // BullMQ blocking commands need their own connection with
    // maxRetriesPerRequest: null — duplicate the shared client.
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.worker = new Worker(
      SETUP_HEALTH_QUEUE,
      async (job: Job<{ shopId?: string }>) => {
        if (job.name !== RECOMPUTE_JOB_NAME || !job.data.shopId) return;
        await this.health.computeSweep(job.data.shopId);
      },
      { connection },
    );
    this.worker.on('failed', (job, err) => {
      // §5.7 control 4: job IDs only.
      this.logger.error(`setup-health job ${job?.id} failed: ${err.name}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
