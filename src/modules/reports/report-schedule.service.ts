import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { isReportCode } from './report-catalogue';
import { normalizeFilters, ReportsService } from './reports.service';
import { advanceNextRun, computeInitialNextRun } from './shop-time';
import { DEFAULT_TIMEZONE, ReportCadence, ReportFilters } from './reports.types';

export interface ReportScheduleRow {
  schedule_id: string;
  shop_id: string;
  report_code: string;
  filters: ReportFilters;
  cadence: ReportCadence;
  recipients: string[];
  next_run_at: string;
  created_at: string;
  updated_at: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SELECT_COLS = `schedule_id, shop_id, report_code, filters, cadence, recipients,
       next_run_at::text, created_at::text, updated_at::text`;

/**
 * §11 / §5.2 report schedules: daily or weekly, in shop-local time, emailing
 * an expiring link to the configured recipients. CRUD plus the due-schedule
 * sweep; the ticker shell is ReportsSchedulerShell.
 */
@Injectable()
export class ReportScheduleService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly reports: ReportsService,
    private readonly audit: AuditService,
  ) {}

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

  private validate(input: {
    reportCode?: unknown;
    cadence?: unknown;
    recipients?: unknown;
  }): { reportCode: string; cadence: ReportCadence; recipients: string[] } {
    if (typeof input.reportCode !== 'string' || !isReportCode(input.reportCode)) {
      throw new BadRequestException(`unknown report code '${String(input.reportCode)}' (§11)`);
    }
    if (input.cadence !== 'daily' && input.cadence !== 'weekly') {
      throw new BadRequestException('cadence must be daily | weekly (§11)');
    }
    if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
      throw new BadRequestException('recipients must be a non-empty email list (§11)');
    }
    const recipients = input.recipients.map((r) => {
      if (typeof r !== 'string' || !EMAIL_RE.test(r)) {
        throw new BadRequestException(`invalid recipient email '${String(r)}'`);
      }
      return r;
    });
    return { reportCode: input.reportCode, cadence: input.cadence, recipients };
  }

  async create(
    shopId: string,
    memberId: string,
    input: { reportCode?: unknown; cadence?: unknown; recipients?: unknown; filters?: unknown },
  ): Promise<ReportScheduleRow> {
    const { reportCode, cadence, recipients } = this.validate(input);
    const filters = normalizeFilters(input.filters);
    const nextRun = computeInitialNextRun(cadence, new Date(), await this.shopTimezone(shopId));

    const { rows } = await this.pool.query<ReportScheduleRow>(
      `INSERT INTO report_schedule
         (shop_id, report_code, filters, cadence, recipients, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${SELECT_COLS}`,
      [shopId, reportCode, JSON.stringify(filters), cadence, JSON.stringify(recipients), nextRun.toISOString()],
    );
    const row = rows[0] as ReportScheduleRow;
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: memberId,
      action: 'report.schedule.created',
      objectType: 'report_schedule',
      objectId: row.schedule_id,
      after: { reportCode, cadence, recipients, filters, nextRunAt: row.next_run_at },
    });
    return row;
  }

  async update(
    shopId: string,
    memberId: string,
    scheduleId: string,
    input: { reportCode?: unknown; cadence?: unknown; recipients?: unknown; filters?: unknown },
  ): Promise<ReportScheduleRow> {
    const existing = await this.get(shopId, scheduleId);
    const reportCode = input.reportCode === undefined ? existing.report_code : this.validate({ reportCode: input.reportCode, cadence: existing.cadence, recipients: existing.recipients }).reportCode;
    const cadence = input.cadence === undefined ? existing.cadence : this.validate({ reportCode: existing.report_code, cadence: input.cadence, recipients: existing.recipients }).cadence;
    const recipients = input.recipients === undefined ? existing.recipients : this.validate({ reportCode: existing.report_code, cadence: existing.cadence, recipients: input.recipients }).recipients;
    const filters = input.filters === undefined ? existing.filters : normalizeFilters(input.filters);

    // A cadence change re-bases the schedule from now (shop-local, §5.2);
    // otherwise the stored occurrence stands.
    const nextRun =
      cadence !== existing.cadence
        ? computeInitialNextRun(cadence, new Date(), await this.shopTimezone(shopId))
        : new Date(existing.next_run_at);

    const { rows } = await this.pool.query<ReportScheduleRow>(
      `UPDATE report_schedule
          SET report_code = $3, filters = $4, cadence = $5, recipients = $6,
              next_run_at = $7, version = version + 1
        WHERE shop_id = $1 AND schedule_id = $2
        RETURNING ${SELECT_COLS}`,
      [shopId, scheduleId, reportCode, JSON.stringify(filters), cadence, JSON.stringify(recipients), nextRun.toISOString()],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('report schedule not found');
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: memberId,
      action: 'report.schedule.updated',
      objectType: 'report_schedule',
      objectId: scheduleId,
      before: { reportCode: existing.report_code, cadence: existing.cadence, recipients: existing.recipients, filters: existing.filters },
      after: { reportCode, cadence, recipients, filters },
    });
    return row;
  }

  async remove(shopId: string, memberId: string, scheduleId: string): Promise<void> {
    const existing = await this.get(shopId, scheduleId);
    await this.pool.query(
      `DELETE FROM report_schedule WHERE shop_id = $1 AND schedule_id = $2`,
      [shopId, scheduleId],
    );
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: memberId,
      action: 'report.schedule.deleted',
      objectType: 'report_schedule',
      objectId: scheduleId,
      before: { reportCode: existing.report_code, cadence: existing.cadence },
    });
  }

  async get(shopId: string, scheduleId: string): Promise<ReportScheduleRow> {
    const { rows } = await this.pool.query<ReportScheduleRow>(
      `SELECT ${SELECT_COLS} FROM report_schedule
        WHERE shop_id = $1 AND schedule_id = $2`,
      [shopId, scheduleId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('report schedule not found');
    return row;
  }

  async list(shopId: string): Promise<ReportScheduleRow[]> {
    const { rows } = await this.pool.query<ReportScheduleRow>(
      `SELECT ${SELECT_COLS} FROM report_schedule
        WHERE shop_id = $1 ORDER BY created_at ASC`,
      [shopId],
    );
    return rows;
  }

  /**
   * The sweep: run every schedule whose next_run_at has passed. Each due
   * schedule is claimed by advancing next_run_at optimistically (a second
   * instance's UPDATE matches nothing and skips), then a report_job is
   * created with as_of_at fixed NOW (§5.2: snapshot as of job start) and
   * enqueued with the recipient list for the ready-email (§9.21).
   * The next occurrence is computed FROM the scheduled local wall time so
   * the cadence never drifts, rolled past `now` so a backlog fires once.
   */
  async runDueSchedules(now: Date = new Date()): Promise<number> {
    const { rows: due } = await this.pool.query<ReportScheduleRow>(
      `SELECT ${SELECT_COLS} FROM report_schedule
        WHERE next_run_at <= $1
        ORDER BY next_run_at ASC
        LIMIT 50`,
      [now.toISOString()],
    );

    let fired = 0;
    for (const schedule of due) {
      const timezone = await this.shopTimezone(schedule.shop_id);
      const nextRun = advanceNextRun(new Date(schedule.next_run_at), schedule.cadence, timezone, now);
      const claim = await this.pool.query(
        `UPDATE report_schedule
            SET next_run_at = $3, version = version + 1
          WHERE schedule_id = $1 AND next_run_at = $2`,
        [schedule.schedule_id, schedule.next_run_at, nextRun.toISOString()],
      );
      if (claim.rowCount === 0) continue; // another instance claimed it

      await this.reports.enqueueReport({
        shopId: schedule.shop_id,
        memberId: null, // system-run: the ready-mail goes to the recipients
        reportCode: schedule.report_code,
        filters: schedule.filters,
        scheduleId: schedule.schedule_id,
        recipients: schedule.recipients,
      });
      fired += 1;
    }
    return fired;
  }
}
