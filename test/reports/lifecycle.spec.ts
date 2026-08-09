import { describe, expect, it } from 'vitest';
import { ReportRunnerService } from '../../src/modules/reports/report-runner.service';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { NOTIFICATION_SENDER } from '../../src/modules/reports/notification-sender';
import { OBJECT_STORE } from '../../src/modules/booking-ops/object-store';
import {
  FakeObjectStore,
  FnPool,
  JOB_ID,
  MEMBER_ID,
  mockAudit,
  mockNotifier,
  mockQueue,
  SHOP_ID,
  testSigner,
} from './helpers';

/**
 * §3.27 report_job lifecycle over the BullMQ-thin runner, and §5.2 as-of
 * immutability: as_of_at is fixed at enqueue and the runner hands exactly
 * that instant to the generator.
 */

const AS_OF = '2026-08-05T19:57:58.855+00:00';

function claimedJob(overrides: Record<string, unknown> = {}) {
  return {
    report_job_id: JOB_ID,
    shop_id: SHOP_ID,
    report_code: 'SHIPMENTS',
    filters: { includeTest: false },
    requested_by: MEMBER_ID,
    as_of_at: AS_OF,
    ...overrides,
  };
}

function makeRunner(pool: FnPool) {
  const store = new FakeObjectStore();
  const audit = mockAudit();
  const notifier = mockNotifier();
  const runner = new ReportRunnerService(
    pool.asPool(),
    store,
    testSigner(),
    audit as never,
    notifier as never,
  );
  return { runner, store, audit, notifier };
}

describe('report job lifecycle (§3.27)', () => {
  it('QUEUED → RUNNING → SUCCEEDED: renders, stores shop-scoped, records row_count', async () => {
    const pool = new FnPool();
    pool.on(/UPDATE report_job SET state = 'RUNNING'/, [claimedJob()]);
    pool.on(/store_settings/, [{ tz: 'Asia/Kolkata' }]);
    pool.on(/FROM shipment s/, []); // zero-row export
    pool.on(/SET state = 'SUCCEEDED'/, [], 1);
    const { runner, store, audit, notifier } = makeRunner(pool);

    await runner.runJob({ reportJobId: JOB_ID });

    // Claim is optimistic and non-destructive on repeat delivery.
    const claim = pool.matching(/SET state = 'RUNNING'/)[0]!;
    expect(claim.sql).toContain(`state IN ('QUEUED', 'RUNNING')`);
    // CSV stored at the INV-1 shop-scoped key convention.
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0]!.key).toBe(`shops/${SHOP_ID}/reports/${JOB_ID}.csv`);
    const csv = store.puts[0]!.bytes.toString('utf8');
    expect(csv).toContain('# as-of (UTC): 2026-08-05T19:57:58.855Z');
    expect(csv).toContain('# test-shipments-included: no (default, §9.23)');
    // SUCCEEDED with row_count; result_document_id untouched (stays NULL).
    const succeed = pool.matching(/SET state = 'SUCCEEDED'/)[0]!;
    expect(succeed.params[1]).toBe(0);
    expect(succeed.sql).not.toContain('result_document_id');
    // §12 audit + §9.21 ready-notification with an expiring link.
    expect(audit.entries.map((e) => e.action)).toContain('report.export.completed');
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.downloadUrl).toMatch(
      new RegExp(`^/reports/jobs/${JOB_ID}/download\\?expires=\\d+&signature=[0-9a-f]{64}$`),
    );
    expect(notifier.sent[0]!.requestedBy).toBe(MEMBER_ID);
  });

  it('as-of immutability: the generator receives exactly report_job.as_of_at', async () => {
    const pool = new FnPool();
    pool.on(/UPDATE report_job SET state = 'RUNNING'/, [claimedJob()]);
    pool.on(/store_settings/, [{ tz: 'Asia/Kolkata' }]);
    const { runner } = makeRunner(pool);

    await runner.runJob({ reportJobId: JOB_ID });

    // The SHIPMENTS query must carry the stored as_of_at, not a fresh now().
    const gen = pool.matching(/FROM shipment s/)[0]!;
    expect(gen.params.map(String)).toContain(new Date(AS_OF).toISOString());
  });

  it('a terminal or unknown job is a no-op (idempotent re-delivery)', async () => {
    const pool = new FnPool(); // claim returns nothing
    const { runner, store } = makeRunner(pool);
    await runner.runJob({ reportJobId: JOB_ID });
    expect(store.puts).toHaveLength(0);
    expect(pool.matching(/SUCCEEDED|FAILED/)).toHaveLength(0);
  });

  it('ReportSourceUnavailableError → FAILED, swallowed (terminal, no retry)', async () => {
    const pool = new FnPool();
    pool.on(/UPDATE report_job SET state = 'RUNNING'/, [claimedJob({ report_code: 'RECON_DISPUTES' })]);
    pool.on(/store_settings/, [{ tz: 'Asia/Kolkata' }]);
    pool.onFn(/FROM recon_freight_row/, () => {
      const err = new Error('relation "recon_freight_row" does not exist') as Error & { code: string };
      err.code = '42P01';
      throw err;
    });
    pool.on(/SET state = 'FAILED'/, [], 1);
    const { runner } = makeRunner(pool);

    await expect(runner.runJob({ reportJobId: JOB_ID })).resolves.toBeUndefined();
    expect(pool.matching(/SET state = 'FAILED'/)).toHaveLength(1);
  });

  it('unexpected errors leave the job RUNNING and rethrow for the BullMQ retry', async () => {
    const pool = new FnPool();
    pool.on(/UPDATE report_job SET state = 'RUNNING'/, [claimedJob()]);
    pool.onFn(/store_settings/, () => {
      throw new Error('connection reset');
    });
    const { runner } = makeRunner(pool);

    await expect(runner.runJob({ reportJobId: JOB_ID })).rejects.toThrow('connection reset');
    expect(pool.matching(/SET state = 'FAILED'/)).toHaveLength(0);
  });

  it('markFailed parks QUEUED/RUNNING as FAILED (§3.27)', async () => {
    const pool = new FnPool();
    pool.on(/SET state = 'FAILED'/, [], 1);
    const { runner } = makeRunner(pool);
    await runner.markFailed(JOB_ID, 'UnknownReportCode');
    const call = pool.matching(/SET state = 'FAILED'/)[0]!;
    expect(call.sql).toContain(`state IN ('QUEUED', 'RUNNING')`);
    expect(call.params[0]).toBe(JOB_ID);
  });

  it('INV-21: a notification failure never fails the job', async () => {
    const pool = new FnPool();
    pool.on(/UPDATE report_job SET state = 'RUNNING'/, [claimedJob()]);
    pool.on(/store_settings/, [{ tz: 'Asia/Kolkata' }]);
    pool.on(/SET state = 'SUCCEEDED'/, [], 1);
    const { runner, notifier } = makeRunner(pool);
    notifier.sendReportReady = () => Promise.reject(new Error('smtp down'));

    await expect(runner.runJob({ reportJobId: JOB_ID })).resolves.toBeUndefined();
    expect(pool.matching(/SET state = 'SUCCEEDED'/)).toHaveLength(1);
  });

  it('scheduled jobs pass recipients to the ready-notification (§9.21)', async () => {
    const pool = new FnPool();
    pool.on(/UPDATE report_job SET state = 'RUNNING'/, [claimedJob({ requested_by: null })]);
    pool.on(/store_settings/, [{ tz: 'Asia/Kolkata' }]);
    const { runner, notifier } = makeRunner(pool);

    await runner.runJob({
      reportJobId: JOB_ID,
      scheduleId: 'sched-1',
      recipients: ['finance@merchant.in'],
    });
    expect(notifier.sent[0]!.recipients).toEqual(['finance@merchant.in']);
  });
});

describe('enqueue (§5.2: as-of fixed at enqueue)', () => {
  it('inserts QUEUED with an explicit as_of_at and normalized filters, enqueues by job id, audits', async () => {
    const pool = new FnPool();
    pool.on(/INSERT INTO report_job/, [claimedJob({ state: 'QUEUED' })]);
    const queue = mockQueue();
    const audit = mockAudit();
    const svc = new ReportsService(
      pool.asPool(),
      queue as never,
      testSigner(),
      audit as never,
      new FakeObjectStore(),
    );

    await svc.enqueueReport({ shopId: SHOP_ID, memberId: MEMBER_ID, reportCode: 'ORDERS', filters: undefined });

    const insert = pool.matching(/INSERT INTO report_job/)[0]!;
    // $5 is as_of_at — an explicit instant, not a DB default, so the test can
    // prove the snapshot instant is fixed at enqueue.
    expect(insert.sql).toContain('as_of_at');
    expect(insert.params[1]).toBe('ORDERS');
    expect(JSON.parse(insert.params[2] as string)).toEqual({ includeTest: false });
    expect(insert.params[3]).toBe(MEMBER_ID);
    expect(Number.isNaN(Date.parse(insert.params[4] as string))).toBe(false);
    expect(queue.enqueued).toEqual([{ reportJobId: JOB_ID }]);
    expect(audit.entries.map((e) => e.action)).toContain('report.export.requested');
  });

  it('rejects a report code outside the §11 catalogue', async () => {
    const pool = new FnPool();
    const svc = new ReportsService(
      pool.asPool(), mockQueue() as never, testSigner(), mockAudit() as never, new FakeObjectStore(),
    );
    await expect(
      svc.enqueueReport({ shopId: SHOP_ID, memberId: MEMBER_ID, reportCode: 'MARGIN_LEAK', filters: undefined }),
    ).rejects.toThrow(/unknown report code/);
  });
});
