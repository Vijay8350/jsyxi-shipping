import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { DocumentUrlSigner } from '../booking-ops/document-urls';
import { LocalFilesystemObjectStore, OBJECT_STORE, ObjectStore } from '../booking-ops/object-store';
import { isReportCode } from './report-catalogue';
import { ReportsQueueService } from './reports-queue';
import {
  REPORT_LINK_TTL_SECONDS,
  ReportCode,
  ReportFilters,
  ReportJobData,
} from './reports.types';
import {
  reportObjectKey,
  signReportDownloadUrl,
  verifyReportSignature,
} from './report-url-signing';

export interface ReportJobRow {
  report_job_id: string;
  shop_id: string;
  report_code: string;
  filters: ReportFilters;
  requested_by: string | null;
  state: string;
  as_of_at: string;
  row_count: number | null;
  created_at: string;
  updated_at: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalize + validate the §11 shared filters. include-test defaults OFF
 * (§9.23) — the single place the default lives. The warehouse filter is
 * hidden at v1 (A4-02) and rejected if sent.
 */
export function normalizeFilters(input: unknown): ReportFilters & { includeTest: boolean } {
  if (input === undefined || input === null) return { includeTest: false };
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('filters must be an object');
  }
  const raw = input as Record<string, unknown>;
  const out: ReportFilters & { includeTest: boolean } = { includeTest: false };
  for (const key of Object.keys(raw)) {
    if (!['dateFrom', 'dateTo', 'serviceId', 'status', 'paymentMode', 'courierAccountId', 'includeTest'].includes(key)) {
      throw new BadRequestException(`unknown report filter '${key}'`);
    }
  }
  if (raw.dateFrom !== undefined) {
    if (typeof raw.dateFrom !== 'string' || !DATE_RE.test(raw.dateFrom)) {
      throw new BadRequestException('dateFrom must be YYYY-MM-DD');
    }
    out.dateFrom = raw.dateFrom;
  }
  if (raw.dateTo !== undefined) {
    if (typeof raw.dateTo !== 'string' || !DATE_RE.test(raw.dateTo)) {
      throw new BadRequestException('dateTo must be YYYY-MM-DD');
    }
    out.dateTo = raw.dateTo;
  }
  if (out.dateFrom && out.dateTo && out.dateFrom > out.dateTo) {
    throw new BadRequestException('dateFrom must not be after dateTo');
  }
  if (raw.serviceId !== undefined) {
    if (typeof raw.serviceId !== 'string' || !UUID_RE.test(raw.serviceId)) {
      throw new BadRequestException('serviceId must be a uuid');
    }
    out.serviceId = raw.serviceId;
  }
  if (raw.courierAccountId !== undefined) {
    if (typeof raw.courierAccountId !== 'string' || !UUID_RE.test(raw.courierAccountId)) {
      throw new BadRequestException('courierAccountId must be a uuid');
    }
    out.courierAccountId = raw.courierAccountId;
  }
  if (raw.status !== undefined) {
    if (typeof raw.status !== 'string' || raw.status.length === 0 || raw.status.length > 64) {
      throw new BadRequestException('status must be a short string');
    }
    out.status = raw.status;
  }
  if (raw.paymentMode !== undefined) {
    if (raw.paymentMode !== 'PREPAID' && raw.paymentMode !== 'COD' && raw.paymentMode !== 'UNRESOLVED') {
      throw new BadRequestException('paymentMode must be PREPAID | COD | UNRESOLVED (§3.5)');
    }
    out.paymentMode = raw.paymentMode;
  }
  if (raw.includeTest !== undefined) {
    if (typeof raw.includeTest !== 'boolean') {
      throw new BadRequestException('includeTest must be a boolean');
    }
    out.includeTest = raw.includeTest;
  }
  return out;
}

export type ReportDownload =
  | { kind: 'BYTES'; bytes: Buffer; filename: string }
  | { kind: 'REDIRECT'; url: string };

/**
 * §9.11 jobs: enqueue, list, download. Everything is shop-scoped (INV-1) —
 * a cross-shop job id is indistinguishable from a missing one. All four
 * merchant roles may run and download (§10.2 'reports.run'); the guard layer
 * enforces that, this service enforces tenancy.
 */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    // forwardRef: queue → schedule → service → queue is a file-level import
    // cycle (live boot proved it).
    @Inject(forwardRef(() => ReportsQueueService))
    private readonly queue: ReportsQueueService,
    private readonly signer: DocumentUrlSigner,
    private readonly audit: AuditService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  /**
   * Create a report_job and enqueue it. as_of_at is fixed HERE, at enqueue —
   * the export is an immutable snapshot as of job start (§5.2) and every
   * generator query is bounded by this instant.
   */
  async enqueueReport(args: {
    shopId: string;
    memberId: string | null;
    reportCode: string;
    filters: unknown;
    scheduleId?: string;
    recipients?: string[];
  }): Promise<ReportJobRow> {
    if (!isReportCode(args.reportCode)) {
      throw new BadRequestException(`unknown report code '${args.reportCode}' (§11)`);
    }
    const filters = normalizeFilters(args.filters);
    const asOf = new Date(); // fixed at enqueue (§5.2)

    const { rows } = await this.pool.query<ReportJobRow>(
      `INSERT INTO report_job
         (shop_id, report_code, filters, requested_by, state, as_of_at)
       VALUES ($1, $2, $3, $4, 'QUEUED', $5)
       RETURNING report_job_id, shop_id, report_code, filters, requested_by,
                 state, as_of_at::text, row_count, created_at::text, updated_at::text`,
      [args.shopId, args.reportCode, JSON.stringify(filters), args.memberId, asOf.toISOString()],
    );
    const job = rows[0] as ReportJobRow;

    const data: ReportJobData = { reportJobId: job.report_job_id };
    if (args.scheduleId) data.scheduleId = args.scheduleId;
    if (args.recipients) data.recipients = args.recipients;
    await this.queue.enqueueReportJob(data);

    await this.audit.record({
      shopId: args.shopId,
      actorKind: args.memberId ? 'MEMBER' : 'SYSTEM',
      actorId: args.memberId,
      action: 'report.export.requested', // §12: report exports are audited
      objectType: 'report_job',
      objectId: job.report_job_id,
      after: { reportCode: args.reportCode, filters },
    });
    return job;
  }

  /** §9.11 jobs list, shop-scoped, newest first. */
  async listJobs(shopId: string, limit = 100): Promise<Array<ReportJobRow & { downloadUrl: string | null }>> {
    const capped = Math.min(Math.max(Math.floor(limit) || 100, 1), 500);
    const { rows } = await this.pool.query<ReportJobRow>(
      `SELECT report_job_id, shop_id, report_code, filters, requested_by,
              state, as_of_at::text, row_count, created_at::text, updated_at::text
         FROM report_job
        WHERE shop_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [shopId, capped],
    );
    return rows.map((j) => ({
      ...j,
      // Succeeded jobs carry a fresh short-lived signed URL (S-26 lifetime).
      downloadUrl:
        j.state === 'SUCCEEDED'
          ? signReportDownloadUrl(this.signer, j.report_job_id, REPORT_LINK_TTL_SECONDS).url
          : null,
    }));
  }

  async getJob(shopId: string, reportJobId: string): Promise<ReportJobRow> {
    const { rows } = await this.pool.query<ReportJobRow>(
      `SELECT report_job_id, shop_id, report_code, filters, requested_by,
              state, as_of_at::text, row_count, created_at::text, updated_at::text
         FROM report_job
        WHERE shop_id = $1 AND report_job_id = $2`,
      [shopId, reportJobId],
    );
    const job = rows[0];
    if (!job) throw new NotFoundException('report job not found');
    return job;
  }

  /**
   * Signed download (S-26 semantics): expires + HMAC over
   * `report:{jobId}:{expires}`, then a shop-scoped load (INV-1). Expired
   * URLs get 410, bad signatures 403, cross-shop ids 404.
   */
  async getDownload(args: {
    shopId: string;
    reportJobId: string;
    expires: number;
    signature: string;
  }): Promise<ReportDownload> {
    if (!verifyReportSignature(this.signer, args.reportJobId, args.expires, args.signature)) {
      throw new ForbiddenException('invalid report URL signature (S-26)');
    }
    if (args.expires * 1000 <= Date.now()) {
      throw new GoneException('report URL expired');
    }
    const job = await this.getJob(args.shopId, args.reportJobId);
    if (job.state !== 'SUCCEEDED') {
      throw new NotFoundException('report export not available');
    }
    const key = reportObjectKey(args.shopId, args.reportJobId);

    await this.audit.record({
      shopId: args.shopId,
      actorKind: 'MEMBER',
      action: 'report.export.downloaded',
      objectType: 'report_job',
      objectId: args.reportJobId,
    });

    if (this.store instanceof LocalFilesystemObjectStore) {
      return { kind: 'BYTES', bytes: await this.store.get(key), filename: `${job.report_code}-${args.reportJobId}.csv` };
    }
    // The S3 driver slots in here: redirect to its signed URL.
    return { kind: 'REDIRECT', url: await this.store.getSignedUrl(key, 60) };
  }
}
