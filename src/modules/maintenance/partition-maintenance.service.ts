import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import {
  monthsToEnsure,
  PARTITION_MONTHS_AHEAD,
  PartitionMonth,
} from './retention-horizons';

/** §5.1: the three tables partitioned by month. shipment is partitioned on
 *  created_at (0003); the tracking tables on received_at (0010). */
export const SHIPMENT_PARTITION_TABLE = 'shipment';
export const TRACKING_PARTITION_TABLES = [
  'tracking_event_raw',
  'tracking_event',
] as const;

/**
 * §5.1 partition maintenance. Ensures the monthly partitions for the current
 * month and PARTITION_MONTHS_AHEAD months ahead exist for all three
 * partitioned tables, by calling the DB helpers installed by the migrations
 * — create_shipment_partition(year, month) (0003) and
 * create_tracking_partition(table, year, month) (0010). Both helpers create
 * with IF NOT EXISTS, so the job is idempotent by construction and safe to
 * run on every startup as well as monthly.
 *
 * Plain injectable: the BullMQ shell schedules it monthly and the scheduler
 * invokes it once on startup (the on-startup check).
 */
@Injectable()
export class PartitionMaintenanceService {
  private readonly logger = new Logger(PartitionMaintenanceService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Returns the months ensured, for job logs and tests. */
  async ensurePartitions(now: Date = new Date()): Promise<PartitionMonth[]> {
    const months = monthsToEnsure(now, PARTITION_MONTHS_AHEAD);
    for (const m of months) {
      await this.pool.query(`SELECT create_shipment_partition($1, $2)`, [
        m.year,
        m.month,
      ]);
      for (const table of TRACKING_PARTITION_TABLES) {
        await this.pool.query(`SELECT create_tracking_partition($1, $2, $3)`, [
          table,
          m.year,
          m.month,
        ]);
      }
    }
    this.logger.log(
      `partitions ensured through ${months[months.length - 1].year}-` +
        `${String(months[months.length - 1].month).padStart(2, '0')}`,
    );
    return months;
  }
}
