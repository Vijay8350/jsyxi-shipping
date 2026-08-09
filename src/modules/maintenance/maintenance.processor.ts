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
import { RetentionService } from './retention.service';
import { PartitionMaintenanceService } from './partition-maintenance.service';
import {
  MAINTENANCE_QUEUE,
  PARTITION_MAINTENANCE_JOB,
  RETENTION_SWEEP_JOB,
} from './maintenance.scheduler';

/**
 * Worker half of the `maintenance` queue: a thin shell that dispatches the
 * two repeatable jobs to their injectable services. Every step of both jobs
 * is idempotent (bounded re-deletes, IF NOT EXISTS partition creation,
 * idempotent object erasure), so BullMQ retries are safe; failures surface
 * to BullMQ's retry/DLQ machinery.
 */
@Injectable()
export class MaintenanceProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceProcessor.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly retention: RetentionService,
    private readonly partitions: PartitionMaintenanceService,
  ) {}

  onModuleInit(): void {
    // BullMQ blocking commands need their own connection with
    // maxRetriesPerRequest: null — duplicate the shared client.
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.worker = new Worker(
      MAINTENANCE_QUEUE,
      async (job: Job) => {
        if (job.name === RETENTION_SWEEP_JOB) {
          await this.retention.sweep(new Date());
        } else if (job.name === PARTITION_MAINTENANCE_JOB) {
          await this.partitions.ensurePartitions(new Date());
        }
      },
      { connection },
    );
    this.worker.on('failed', (job, err) => {
      // §5.7 control 4: job IDs only.
      this.logger.error(`maintenance job ${job?.id} failed: ${err.name}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
