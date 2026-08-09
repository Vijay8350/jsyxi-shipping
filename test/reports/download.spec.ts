import { describe, expect, it } from 'vitest';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { signReportDownloadUrl } from '../../src/modules/reports/report-url-signing';
import {
  FnPool,
  JOB_ID,
  MEMBER_ID,
  MemLocalObjectStore,
  mockAudit,
  mockQueue,
  OTHER_SHOP_ID,
  SHOP_ID,
  testSigner,
} from './helpers';

/**
 * Download authorization (S-26 semantics, INV-1): signature + expiry +
 * shop-scope. A cross-shop job id is indistinguishable from a missing one.
 */
function makeService(pool: FnPool) {
  const audit = mockAudit();
  const store = new MemLocalObjectStore();
  store.objects.set(`shops/${SHOP_ID}/reports/${JOB_ID}.csv`, Buffer.from('csv-bytes'));
  const svc = new ReportsService(
    pool.asPool(),
    mockQueue() as never,
    testSigner(),
    audit as never,
    store,
  );
  return { svc, audit };
}

const SUCCEEDED_JOB = {
  report_job_id: JOB_ID,
  shop_id: SHOP_ID,
  report_code: 'SHIPMENTS',
  filters: { includeTest: false },
  requested_by: MEMBER_ID,
  state: 'SUCCEEDED',
  as_of_at: '2026-08-05T19:57:58.855+00:00',
  row_count: 3,
  created_at: '2026-08-05T19:57:58.855+00:00',
  updated_at: '2026-08-05T19:58:10.000+00:00',
};

function signed(jobId: string, ttlSeconds = 600) {
  const { url } = signReportDownloadUrl(testSigner(), jobId, ttlSeconds);
  const u = new URL(url, 'http://test');
  return {
    expires: Number(u.searchParams.get('expires')),
    signature: u.searchParams.get('signature') ?? '',
  };
}

describe('report download authorization (S-26, INV-1)', () => {
  it('serves bytes for a valid signed URL on a SUCCEEDED job, and audits (§12)', async () => {
    const pool = new FnPool();
    pool.on(/FROM report_job/, [SUCCEEDED_JOB]);
    const { svc, audit } = makeService(pool);
    const { expires, signature } = signed(JOB_ID);

    const result = await svc.getDownload({ shopId: SHOP_ID, reportJobId: JOB_ID, expires, signature });
    expect(result.kind).toBe('BYTES');
    if (result.kind === 'BYTES') {
      expect(result.bytes.toString()).toBe('csv-bytes');
      expect(result.filename).toBe(`SHIPMENTS-${JOB_ID}.csv`);
    }
    // The job row load is shop-scoped.
    expect(pool.matching(/FROM report_job/)[0]!.sql).toContain('shop_id = $1');
    expect(audit.entries.map((e) => e.action)).toContain('report.export.downloaded');
  });

  it('rejects a bad signature with 403', async () => {
    const pool = new FnPool();
    pool.on(/FROM report_job/, [SUCCEEDED_JOB]);
    const { svc } = makeService(pool);
    const { expires } = signed(JOB_ID);
    await expect(
      svc.getDownload({ shopId: SHOP_ID, reportJobId: JOB_ID, expires, signature: 'deadbeef' }),
    ).rejects.toThrow(/invalid report URL signature/);
  });

  it('rejects an expired URL with 410', async () => {
    const pool = new FnPool();
    pool.on(/FROM report_job/, [SUCCEEDED_JOB]);
    const { svc } = makeService(pool);
    const { expires, signature } = signed(JOB_ID, -60); // already expired
    await expect(
      svc.getDownload({ shopId: SHOP_ID, reportJobId: JOB_ID, expires, signature }),
    ).rejects.toThrow(/expired/);
  });

  it('INV-1: another shop\'s job id reads as 404', async () => {
    const pool = new FnPool(); // shop-scoped select returns nothing
    const { svc } = makeService(pool);
    const { expires, signature } = signed(JOB_ID);
    await expect(
      svc.getDownload({ shopId: OTHER_SHOP_ID, reportJobId: JOB_ID, expires, signature }),
    ).rejects.toThrow(/not found/);
  });

  it('a non-SUCCEEDED job has no export to download', async () => {
    const pool = new FnPool();
    pool.on(/FROM report_job/, [{ ...SUCCEEDED_JOB, state: 'FAILED' }]);
    const { svc } = makeService(pool);
    const { expires, signature } = signed(JOB_ID);
    await expect(
      svc.getDownload({ shopId: SHOP_ID, reportJobId: JOB_ID, expires, signature }),
    ).rejects.toThrow(/not available/);
  });

  it('jobs list signs fresh short-lived URLs only for SUCCEEDED jobs', async () => {
    const pool = new FnPool();
    pool.on(/FROM report_job/, [SUCCEEDED_JOB, { ...SUCCEEDED_JOB, report_job_id: 'other', state: 'QUEUED' }]);
    const { svc } = makeService(pool);
    const jobs = await svc.listJobs(SHOP_ID);
    expect(jobs[0]!.downloadUrl).toMatch(new RegExp(`^/reports/jobs/${JOB_ID}/download`));
    expect(jobs[1]!.downloadUrl).toBeNull();
  });
});
