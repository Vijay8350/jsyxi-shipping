import { describe, expect, it } from 'vitest';
import { ReportScheduleService } from '../../src/modules/reports/report-schedule.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import {
  FakeObjectStore,
  FnPool,
  MEMBER_ID,
  mockAudit,
  mockQueue,
  SCHEDULE_ID,
  SHOP_ID,
  testSigner,
} from './helpers';

/**
 * report_schedule CRUD + the due-run sweep (§11, §5.2): daily/weekly in
 * shop-local time, enqueuing a report_job per due schedule with recipients
 * for the §9.21 ready-mail.
 */

function makeSchedules(pool: FnPool) {
  const audit = mockAudit();
  const queue = mockQueue();
  const reports = new ReportsService(
    pool.asPool(),
    queue as never,
    testSigner(),
    audit as never,
    new FakeObjectStore(),
  );
  const schedules = new ReportScheduleService(pool.asPool(), reports, audit as never);
  return { schedules, queue, audit };
}

describe('report schedules (§11, §5.2)', () => {
  it('create validates, computes the shop-local next_run and audits', async () => {
    const pool = new FnPool();
    pool.on(/store_settings/, [{ tz: 'Asia/Kolkata' }]);
    pool.on(/INSERT INTO report_schedule/, [{
      schedule_id: SCHEDULE_ID,
      shop_id: SHOP_ID,
      report_code: 'SHIPMENTS',
      filters: { includeTest: false },
      cadence: 'daily',
      recipients: ['ops@merchant.in'],
      next_run_at: '2026-08-06T00:30:00.000Z',
      created_at: '2026-08-05T00:00:00.000Z',
      updated_at: '2026-08-05T00:00:00.000Z',
    }]);
    const { schedules, audit } = makeSchedules(pool);

    const row = await schedules.create(SHOP_ID, MEMBER_ID, {
      reportCode: 'SHIPMENTS',
      cadence: 'daily',
      recipients: ['ops@merchant.in'],
    });
    expect(row.schedule_id).toBe(SCHEDULE_ID);

    const insert = pool.matching(/INSERT INTO report_schedule/)[0]!;
    expect(insert.params[3]).toBe('daily');
    expect(JSON.parse(insert.params[4] as string)).toEqual(['ops@merchant.in']);
    // next_run_at is a valid instant (the shop-local computation, mocked clock-independent).
    expect(Number.isNaN(Date.parse(insert.params[5] as string))).toBe(false);
    expect(audit.entries.map((e) => e.action)).toContain('report.schedule.created');
  });

  it('create rejects bad cadence, unknown codes and empty recipients', async () => {
    const pool = new FnPool();
    pool.on(/store_settings/, [{ tz: 'Asia/Kolkata' }]);
    const { schedules } = makeSchedules(pool);
    await expect(
      schedules.create(SHOP_ID, MEMBER_ID, { reportCode: 'ORDERS', cadence: 'hourly', recipients: ['a@b.in'] }),
    ).rejects.toThrow(/daily \| weekly/);
    await expect(
      schedules.create(SHOP_ID, MEMBER_ID, { reportCode: 'NOPE', cadence: 'daily', recipients: ['a@b.in'] }),
    ).rejects.toThrow(/unknown report code/);
    await expect(
      schedules.create(SHOP_ID, MEMBER_ID, { reportCode: 'ORDERS', cadence: 'daily', recipients: [] }),
    ).rejects.toThrow(/non-empty/);
    await expect(
      schedules.create(SHOP_ID, MEMBER_ID, { reportCode: 'ORDERS', cadence: 'daily', recipients: ['not-an-email'] }),
    ).rejects.toThrow(/invalid recipient/);
  });

  it('the sweep claims due schedules, enqueues a job per schedule and advances next_run', async () => {
    const pool = new FnPool();
    const dueSchedule = {
      schedule_id: SCHEDULE_ID,
      shop_id: SHOP_ID,
      report_code: 'COD_UNASSIGNED',
      filters: { includeTest: false },
      cadence: 'daily',
      recipients: ['finance@merchant.in'],
      next_run_at: '2026-08-05T00:30:00.000+00:00', // 06:00 Kolkata, already past
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    };
    pool.on(/FROM report_schedule/, [dueSchedule]);
    pool.on(/store_settings/, [{ tz: 'Asia/Kolkata' }]);
    pool.on(/UPDATE report_schedule/, [], 1);
    pool.on(/INSERT INTO report_job/, [{
      report_job_id: 'job-1', shop_id: SHOP_ID, report_code: 'COD_UNASSIGNED',
      filters: { includeTest: false }, requested_by: null, state: 'QUEUED',
      as_of_at: '2026-08-05T19:57:58.855+00:00', row_count: null,
      created_at: '2026-08-05T19:57:58.855+00:00', updated_at: '2026-08-05T19:57:58.855+00:00',
    }]);
    const { schedules, queue } = makeSchedules(pool);

    const fired = await schedules.runDueSchedules(new Date('2026-08-05T19:57:58.855Z'));
    expect(fired).toBe(1);

    // next_run advanced one shop-local day: 06:00 Kolkata next day = 00:30Z.
    const advance = pool.matching(/UPDATE report_schedule/)[0]!;
    expect(advance.params[0]).toBe(SCHEDULE_ID);
    expect(advance.params[1]).toBe('2026-08-05T00:30:00.000+00:00'); // optimistic claim on the old value
    expect(advance.params[2]).toBe('2026-08-06T00:30:00.000Z');

    // The job carries schedule + recipients for the ready-mail (§9.21).
    expect(queue.enqueued).toEqual([{
      reportJobId: 'job-1',
      scheduleId: SCHEDULE_ID,
      recipients: ['finance@merchant.in'],
    }]);
    // System-run: no member as requester.
    const insert = pool.matching(/INSERT INTO report_job/)[0]!;
    expect(insert.params[3]).toBeNull();
  });

  it('a lost optimistic claim skips the schedule (no double-run across instances)', async () => {
    const pool = new FnPool();
    pool.on(/FROM report_schedule/, [{
      schedule_id: SCHEDULE_ID, shop_id: SHOP_ID, report_code: 'ORDERS',
      filters: { includeTest: false }, cadence: 'weekly', recipients: ['a@b.in'],
      next_run_at: '2026-08-03T00:30:00.000+00:00',
      created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
    }]);
    pool.on(/store_settings/, [{ tz: 'Asia/Kolkata' }]);
    pool.on(/UPDATE report_schedule/, [], 0); // rowCount 0 — claimed elsewhere
    const { schedules, queue } = makeSchedules(pool);

    const fired = await schedules.runDueSchedules(new Date('2026-08-05T19:57:58.855Z'));
    expect(fired).toBe(0);
    expect(queue.enqueued).toHaveLength(0);
  });
});
