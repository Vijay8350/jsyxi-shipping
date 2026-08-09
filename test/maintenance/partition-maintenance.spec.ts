import { describe, expect, it, vi } from 'vitest';
import { PartitionMaintenanceService } from '../../src/modules/maintenance/partition-maintenance.service';
import { asPool, FakePool, EMPTY } from './helpers';

describe('PartitionMaintenanceService (§5.1)', () => {
  it('creates partitions for the current month and 3 ahead on all three tables', async () => {
    const pool = new FakePool(EMPTY);
    const service = new PartitionMaintenanceService(asPool(pool));
    const now = new Date('2026-11-15T00:00:00Z');
    const months = await service.ensurePartitions(now);

    expect(months).toEqual([
      { year: 2026, month: 11 },
      { year: 2026, month: 12 },
      { year: 2027, month: 1 },
      { year: 2027, month: 2 },
    ]);

    const shipmentCalls = pool.matching(/SELECT create_shipment_partition\(\$1, \$2\)/);
    expect(shipmentCalls.map((c) => c.params)).toEqual([
      [2026, 11],
      [2026, 12],
      [2027, 1],
      [2027, 2],
    ]);

    const trackingCalls = pool.matching(/SELECT create_tracking_partition\(\$1, \$2, \$3\)/);
    // 4 months × 2 tracking tables
    expect(trackingCalls).toHaveLength(8);
    expect(trackingCalls.map((c) => c.params)).toEqual([
      ['tracking_event_raw', 2026, 11],
      ['tracking_event', 2026, 11],
      ['tracking_event_raw', 2026, 12],
      ['tracking_event', 2026, 12],
      ['tracking_event_raw', 2027, 1],
      ['tracking_event', 2027, 1],
      ['tracking_event_raw', 2027, 2],
      ['tracking_event', 2027, 2],
    ]);
  });
});

describe('MaintenanceScheduler (§5.4 daily sweep, §5.1 monthly + startup)', () => {
  it('registers both repeatable jobs and runs the startup partition check', async () => {
    vi.resetModules();
    const upsertJobScheduler = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    vi.doMock('bullmq', () => ({
      Queue: class {
        upsertJobScheduler = upsertJobScheduler;
        close = close;
      },
      Worker: class {},
      Job: class {},
    }));
    const { MaintenanceScheduler } = await import(
      '../../src/modules/maintenance/maintenance.scheduler'
    );
    const partitions = { ensurePartitions: vi.fn(async () => []) };
    const scheduler = new MaintenanceScheduler({} as never, partitions as never);

    await scheduler.onModuleInit();

    expect(upsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      'retention-sweep',
      { pattern: '30 3 * * *' },
      { name: 'retention-sweep', data: {} },
    );
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      'partition-maintenance',
      { pattern: '15 2 1 * *' },
      { name: 'partition-maintenance', data: {} },
    );
    // §5.1 on-startup check
    expect(partitions.ensurePartitions).toHaveBeenCalledTimes(1);

    await scheduler.onModuleDestroy();
    expect(close).toHaveBeenCalledTimes(1);
    vi.doUnmock('bullmq');
  });
});
