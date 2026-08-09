import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { Job, Queue, Worker } from 'bullmq';
import { REDIS } from '../../redis/redis.module';
import { TrackingIngestService } from './tracking-ingest.service';
import { TrackingPollingService, PollCohort } from './tracking-polling.service';

/**
 * The §5.7 `tracking-ingest` queue. Two job families share it:
 *
 *  - `raw-event` — normalize one tracking_event_raw row (§8.5: all
 *    normalization is asynchronous; the webhook tier acks in <100 ms after
 *    the durable insert).
 *  - `poll-sweep:{cohort}` — the §8.5 polling fallback, repeatable every 2h
 *    (new shipments) and 4h (in-transit), stopping at terminal states.
 *
 * The worker shells only wire BullMQ; all logic lives in the plain
 * injectable methods TrackingIngestService.processRawEvent and
 * TrackingPollingService.runPollSweep, unit-tested without Redis.
 */

export const TRACKING_INGEST_QUEUE = 'tracking-ingest';
export const RAW_EVENT_JOB = 'raw-event';
export const POLL_SWEEP_JOB_PREFIX = 'poll-sweep:';

export const POLL_NEW_INTERVAL_MS = 2 * 3600_000; // §8.5: new shipments every 2h
export const POLL_IN_TRANSIT_INTERVAL_MS = 4 * 3600_000; // §8.5: in-transit every 4h

export interface RawEventJobData {
  rawEventId: string;
}

export function pollSweepJobName(cohort: PollCohort): string {
  return `${POLL_SWEEP_JOB_PREFIX}${cohort}`;
}

/** Structural type so tests inject a stub without BullMQ. */
export interface RawEventQueue {
  enqueueRawEvent(rawEventId: string): Promise<void>;
}

@Injectable()
export class TrackingIngestQueueService implements RawEventQueue, OnModuleDestroy {
  private queue: Queue | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private instance(): Queue {
    if (!this.queue) {
      this.queue = new Queue(TRACKING_INGEST_QUEUE, { connection: this.redis });
    }
    return this.queue;
  }

  /**
   * Queue one raw event for normalization. jobId = raw_event_id: a repeat
   * enqueue of the same row is a BullMQ no-op (A1-10 idempotent work).
   * S-48-shaped retry: backoff with a cap, failures stay for §8.6 DLQ.
   */
  async enqueueRawEvent(rawEventId: string): Promise<void> {
    await this.instance().add(RAW_EVENT_JOB, { rawEventId } satisfies RawEventJobData, {
      jobId: rawEventId,
      attempts: 10,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: false,
    });
  }

  /** §8.5 polling fallback: one repeatable sweep per cohort. */
  async schedulePollSweeps(): Promise<void> {
    const cohorts: Array<[PollCohort, number]> = [
      ['NEW', POLL_NEW_INTERVAL_MS],
      ['IN_TRANSIT', POLL_IN_TRANSIT_INTERVAL_MS],
    ];
    for (const [cohort, every] of cohorts) {
      await this.instance().add(
        pollSweepJobName(cohort),
        { cohort },
        {
          jobId: pollSweepJobName(cohort), // one scheduler record per cohort
          repeat: { every },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
    }
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
export class TrackingPollScheduler implements OnModuleInit {
  constructor(private readonly queue: TrackingIngestQueueService) {}

  async onModuleInit(): Promise<void> {
    await this.queue.schedulePollSweeps();
  }
}

@Injectable()
export class TrackingIngestProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrackingIngestProcessor.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly ingest: TrackingIngestService,
    private readonly polling: TrackingPollingService,
  ) {}

  onModuleInit(): void {
    // BullMQ blocking commands need their own connection (see booking-queue).
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.worker = new Worker(
      TRACKING_INGEST_QUEUE,
      async (job: Job) => {
        if (job.name === RAW_EVENT_JOB) {
          const data = job.data as RawEventJobData;
          await this.ingest.processRawEvent(data.rawEventId);
          return;
        }
        if (job.name.startsWith(POLL_SWEEP_JOB_PREFIX)) {
          const cohort = job.name.slice(POLL_SWEEP_JOB_PREFIX.length) as PollCohort;
          await this.polling.runPollSweep(cohort);
        }
      },
      { connection },
    );
    this.worker.on('failed', (job, err) => {
      // §5.7 control 4: job IDs and error class only — no PII, no payloads.
      this.logger.error(`tracking-ingest job ${job?.id} failed: ${err.name}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
