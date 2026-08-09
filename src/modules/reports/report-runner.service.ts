import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { DocumentUrlSigner } from '../booking-ops/document-urls';
import { OBJECT_STORE, ObjectStore } from '../booking-ops/object-store';
import { CsvRenderer, ReportRenderer } from './csv-renderer';
import { REPORT_CATALOGUE } from './report-catalogue';
import { REPORT_GENERATORS } from './generators';
import { NOTIFICATION_SENDER, NotificationSender } from './notification-sender';
import {
  DEFAULT_TIMEZONE,
  REPORT_EMAIL_LINK_TTL_SECONDS,
  ReportCode,
  ReportFilters,
  ReportJobData,
  ReportSourceUnavailableError,
} from './reports.types';
import { reportObjectKey, signReportDownloadUrl } from './report-url-signing';

interface ClaimedJob {
  report_job_id: string;
  shop_id: string;
  report_code: string;
  filters: ReportFilters;
  requested_by: string | null;
  as_of_at: string;
}

/**
 * The §3.27 report_job lifecycle: QUEUED → RUNNING → SUCCEEDED/FAILED
 * (PARTIAL is the bulk-document case, §3.27 — reports don't use it). Plain
 * injectable, driven by the thin BullMQ shell; unit-testable without Redis.
 *
 * As-of immutability (§5.2): the job's as_of_at was fixed at enqueue; the
 * generator context carries it and every report query is bounded by it, so
 * the export is an immutable snapshot as of job start — later corrections
 * never rewrite the artifact.
 *
 * The CSV goes to the object store under shops/{shopId}/reports/{id}.csv
 * (INV-1); result_document_id stays NULL — see reports.types.ts for the
 * storage decision.
 */
@Injectable()
export class ReportRunnerService {
  private readonly logger = new Logger(ReportRunnerService.name);
  private readonly renderer: ReportRenderer = new CsvRenderer();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    private readonly signer: DocumentUrlSigner,
    private readonly audit: AuditService,
    @Inject(NOTIFICATION_SENDER) private readonly notifier: NotificationSender,
  ) {}

  /** The S-2 shop timezone with the §5.2 default as final fallback. */
  private async shopTimezone(shopId: string): Promise<string> {
    const { rows } = await this.pool.query<{ tz: string }>(
      `SELECT COALESCE(
                (SELECT ss.timezone FROM store_settings ss WHERE ss.shop_id = $1),
                (SELECT sh.iana_timezone FROM shop sh WHERE sh.shop_id = $1),
                $2) AS tz`,
      [shopId, DEFAULT_TIMEZONE],
    );
    return rows[0]?.tz ?? DEFAULT_TIMEZONE;
  }

  /**
   * Claim and run one report job. Claiming is an optimistic QUEUED|RUNNING →
   * RUNNING transition: RUNNING is claimable so a BullMQ retry after a
   * worker crash resumes the same job (jobId dedup means no concurrent
   * duplicate exists). Anything else (SUCCEEDED/FAILED/CANCELLED) is a no-op.
   */
  async runJob(data: ReportJobData): Promise<void> {
    const { rows } = await this.pool.query<ClaimedJob>(
      `UPDATE report_job SET state = 'RUNNING'
        WHERE report_job_id = $1 AND state IN ('QUEUED', 'RUNNING')
        RETURNING report_job_id, shop_id, report_code, filters, requested_by, as_of_at::text`,
      [data.reportJobId],
    );
    const job = rows[0];
    if (!job) return; // already terminal, or unknown id — nothing to do

    try {
      const timezone = await this.shopTimezone(job.shop_id);
      const asOf = new Date(job.as_of_at);
      const definition = REPORT_CATALOGUE[job.report_code as keyof typeof REPORT_CATALOGUE];
      if (!definition) {
        await this.markFailed(job.report_job_id, 'UnknownReportCode');
        return;
      }
      const generator = REPORT_GENERATORS[definition.code];
      const filters = { ...job.filters, includeTest: job.filters.includeTest ?? false };

      const result = await generator(this.pool, {
        shopId: job.shop_id,
        asOf,
        timezone,
        filters,
      });

      const bytes = this.renderer.render(
        { definition, asOf, filters, timezone },
        result.columns,
        result.rows,
      );
      await this.store.put(reportObjectKey(job.shop_id, job.report_job_id), bytes);

      await this.pool.query(
        `UPDATE report_job SET state = 'SUCCEEDED', row_count = $2
          WHERE report_job_id = $1`,
        [job.report_job_id, result.rows.length],
      );
      await this.audit.record({
        shopId: job.shop_id,
        actorKind: 'SYSTEM',
        action: 'report.export.completed', // §12: report exports are audited
        objectType: 'report_job',
        objectId: job.report_job_id,
        after: { reportCode: job.report_code, rowCount: result.rows.length, format: this.renderer.format },
      });

      await this.notifyReady(job, data, result.rows.length);
    } catch (err) {
      if (err instanceof ReportSourceUnavailableError) {
        // The recon tables land in weeks 14–15; until then this is the typed
        // 'report source not yet available' outcome — terminal, no retry.
        await this.markFailed(job.report_job_id, err.name);
        return;
      }
      // Unexpected: leave RUNNING for the BullMQ retry to re-claim; the
      // processor's 'failed' handler parks it FAILED after the last attempt.
      this.logger.error(`report job ${job.report_job_id} attempt failed: ${(err as Error).name}`);
      throw err;
    }
  }

  /** Terminal FAILED transition (§3.27), idempotent from RUNNING/QUEUED. */
  async markFailed(reportJobId: string, errorClass: string): Promise<void> {
    await this.pool.query(
      `UPDATE report_job SET state = 'FAILED'
        WHERE report_job_id = $1 AND state IN ('QUEUED', 'RUNNING')`,
      [reportJobId],
    );
    this.logger.warn(`report job ${reportJobId} marked FAILED: ${errorClass}`);
  }

  /**
   * §9.21: "Scheduled or ad-hoc report ready → the requester → email with an
   * expiring link", on completion. Never blocks the job (INV-21) — a
   * notification failure is logged, never thrown.
   */
  private async notifyReady(job: ClaimedJob, data: ReportJobData, rowCount: number): Promise<void> {
    try {
      const { url, expiresAt } = signReportDownloadUrl(
        this.signer,
        job.report_job_id,
        REPORT_EMAIL_LINK_TTL_SECONDS,
      );
      await this.notifier.sendReportReady({
        shopId: job.shop_id,
        reportCode: job.report_code as ReportCode,
        reportJobId: job.report_job_id,
        requestedBy: job.requested_by,
        recipients: data.recipients ?? [],
        downloadUrl: url,
        expiresAt,
        rowCount,
      });
    } catch (err) {
      this.logger.warn(`report-ready notification failed for ${job.report_job_id}: ${(err as Error).name}`);
    }
  }
}
