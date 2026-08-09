import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, forwardRef } from '@nestjs/common';
import Redis from 'ioredis';
import { Job, Queue, Worker } from 'bullmq';
import { REDIS } from '../../redis/redis.module';
import { REPORTS_QUEUE, ReportJobData } from './reports.types';
import { ReportRunnerService } from './report-runner.service';
import { ReportScheduleService } from './report-schedule.service';

/**
 * The `reports` BullMQ queue (§9.11 — all reports run asynchronously).
 * Enqueue only; the worker shell lives below, keeping this file free of the
 * runner so nothing imports a cycle. jobId = report_job_id: a repeat enqueue
 * of the same report job is a BullMQ no-op.
 */
@Injectable()
export class ReportsQueueService implements OnModuleDestroy {
  private queue: Queue<ReportJobData> | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private instance(): Queue<ReportJobData> {
    if (!this.queue) {
      this.queue = new Queue<ReportJobData>(REPORTS_QUEUE, { connection: this.redis });
    }
    return this.queue;
  }

  async enqueueReportJob(data: ReportJobData): Promise<void> {
    await this.instance().add('report', data, {
      jobId: data.reportJobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: false, // failures stay inspectable; DLQ replay is §8.6
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    this.queue = null;
  }
}

/**
 * Thin BullMQ shell over ReportRunnerService.runJob — a plain injectable
 * method, unit-testable without Redis (the booking module's pattern).
 * A worker crash mid-run leaves the row RUNNING; the retry re-claims it
 * (runJob claims QUEUED or RUNNING), and when attempts are exhausted the
 * 'failed' handler parks the row FAILED. §5.7 control 4: logs carry job IDs
 * and error classes only.
 */
@Injectable()
export class ReportsProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReportsProcessor.name);
  private worker: Worker<ReportJobData> | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly runner: ReportRunnerService,
  ) {}

  onModuleInit(): void {
    // BullMQ blocking commands need their own connection with
    // maxRetriesPerRequest: null — duplicate the shared client.
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.worker = new Worker<ReportJobData>(
      REPORTS_QUEUE,
      async (job: Job<ReportJobData>) => {
        await this.runner.runJob(job.data);
      },
      { connection, concurrency: 2 },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`report job ${job?.id} failed: ${err.name}`);
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void this.runner.markFailed(job.data.reportJobId, err.name);
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}

/**
 * Thin shell over ReportScheduleService.runDueSchedules (§5.2: scheduled
 * work runs in shop-local time — the shop-local computation lives in the
 * service; this is only the ticker). One sweep per minute; the per-schedule
 * optimistic next_run_at claim inside the service makes overlapping
 * instances safe.
 */
@Injectable()
export class ReportsSchedulerShell implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReportsSchedulerShell.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(forwardRef(() => ReportScheduleService))
    private readonly schedules: ReportScheduleService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.schedules.runDueSchedules().catch((err: Error) => {
        this.logger.error(`report schedule sweep failed: ${err.name}`);
      });
    }, 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
