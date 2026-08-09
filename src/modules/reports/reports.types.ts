/**
 * Reports pack (§11, §9.11) — shared types, constants and seams.
 *
 * Storage decision (recorded here because §2.8 fixes report_job's columns):
 * the `document_kind` enum (§3.31: LABEL · MANIFEST · INVOICE · PACKING_SLIP ·
 * BULK_LABEL) has no REPORT value and migrations may not be edited from this
 * module, so a report export gets NO `document` row and
 * `report_job.result_document_id` stays NULL. The CSV is written to the
 * booking-ops ObjectStore under the shop-scoped key convention
 *   shops/{shopId}/reports/{reportJobId}.csv        (INV-1)
 * and downloads are served by GET /reports/jobs/:id/download, which verifies
 * an HMAC signature over (reportJobId, expires) — S-26 semantics — using the
 * existing DocumentUrlSigner as the single HMAC authority.
 */

/** §11 catalogue codes — the closed set, named exactly as in §11. */
export const REPORT_CODES = [
  'ORDERS',
  'SHIPMENTS',
  'COURIER_PERF',
  'PINCODE_PERF',
  'PAYMENT_MODE',
  'NDR',
  'RTO',
  'SLA_DELAY',
  'RECON_DISPUTES',
  'COD_PENDING',
  'MANUAL_ASSIGNMENT',
  'PROFITABILITY',
  'INVOICE_PENDING',
  'COD_UNASSIGNED',
] as const;
export type ReportCode = (typeof REPORT_CODES)[number];

/** §3.27 JOB_STATE (report_job uses QUEUED → RUNNING → SUCCEEDED/FAILED). */
export type JobState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';

/** §11 / §5.2: scheduled reports run daily or weekly in shop-local time. */
export type ReportCadence = 'daily' | 'weekly';

/**
 * §11 shared filters. The date range is a pair of shop-local calendar dates,
 * inclusive at both ends; the SQL layer renders them as the half-open
 * local range [dateFrom 00:00, dateTo+1 00:00) per §5.2. The warehouse filter
 * is hidden at v1 (A4-02) and deliberately absent here.
 */
export interface ReportFilters {
  /** 'YYYY-MM-DD', shop-local (§5.2). */
  dateFrom?: string;
  /** 'YYYY-MM-DD', shop-local, inclusive. */
  dateTo?: string;
  serviceId?: string;
  /** Per-report status value (movement state, NDR case state, …). */
  status?: string;
  paymentMode?: 'PREPAID' | 'COD' | 'UNRESOLVED';
  courierAccountId?: string;
  /** §9.23 / §11: default OFF; when on the export header says so. */
  includeTest?: boolean;
}

/** The BullMQ `reports` queue (§9.11 — jobs run asynchronously). */
export const REPORTS_QUEUE = 'reports';

export interface ReportJobData {
  reportJobId: string;
  /** Set when the job came from a report_schedule run. */
  scheduleId?: string;
  /** Schedule recipients (email addresses) for the ready-notification. */
  recipients?: string[];
}

/**
 * Signed-link lifetimes. Interactive downloads from the jobs list use the
 * S-26 lifetime (10 minutes, same as documents); links emailed by the
 * scheduler live longer so a daily/weekly digest is still openable — bounded
 * by the §5.4 report-export retention of 30 days.
 */
export const REPORT_LINK_TTL_SECONDS = 600;
export const REPORT_EMAIL_LINK_TTL_SECONDS = 7 * 24 * 3600;

/** §5.2 default Shop timezone (S-2 fallback). */
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/**
 * RECON_DISPUTES and COD_PENDING read the §2.7 recon tables, which land with
 * the weeks 14–15 reconciliation block. Their generators carry the real SQL
 * against the §2.7 column names; at runtime a missing source table surfaces
 * as this typed error (PostgreSQL 42P01), which the runner records as a
 * FAILED job with this class name — never a stack in the log (§5.7 control 4).
 */
export class ReportSourceUnavailableError extends Error {
  constructor(
    public readonly reportCode: ReportCode,
    public readonly source: string,
  ) {
    super(`report source not yet available: ${source} (needed by ${reportCode})`);
    this.name = 'ReportSourceUnavailableError';
  }
}

/** Minimal query surface so generators unit-test against a fake pool. */
export interface ReportQuery {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/** Everything a generator needs; asOf is report_job.as_of_at (§5.2). */
export interface ReportContext {
  shopId: string;
  /** Fixed at enqueue; every query is bounded by it (§5.2 freshness). */
  asOf: Date;
  /** S-2 shop timezone for local date rendering/period attribution. */
  timezone: string;
  filters: Required<Pick<ReportFilters, 'includeTest'>> & ReportFilters;
}

export type ReportCell = string | null;
export interface ReportData {
  columns: string[];
  rows: ReportCell[][];
}

export type ReportGenerator = (q: ReportQuery, ctx: ReportContext) => Promise<ReportData>;
