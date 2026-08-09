import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import {
  OBJECT_ERASE,
  ObjectEraseStore,
} from '../health/object-erase';
import { reportObjectKey } from '../reports/report-url-signing';
import {
  daysCutoff,
  expiredPartitionNames,
  financialRetentionCutoff,
  FINANCIAL_FACT_RETENTION_FY,
  monthsCutoff,
  RAW_WEBHOOK_PAYLOAD_RETENTION_DAYS,
  REPORT_EXPORT_RETENTION_DAYS,
  RETENTION_BATCH_SIZE,
  TICKET_FEEDBACK_ATTACHMENT_RETENTION_DAYS,
  TRACKING_EVENT_RETENTION_MONTHS,
} from './retention-horizons';

/** Per-table totals for one sweep run (returned for tests and job logs). */
export interface SweepSummary {
  webhook_inbox: number;
  tracking_event_raw_partitions_dropped: number;
  tracking_event_raw_rows: number;
  tracking_event_partitions_dropped: number;
  tracking_event_rows: number;
  document: number;
  document_invoice: number;
  report_export_objects: number;
  ticket_attachments: number;
  feedback_screenshots: number;
}

interface DocumentRow {
  document_id: string;
  shop_id: string;
  object_key: string;
}

interface TicketMessageRow {
  message_id: string;
  shop_id: string;
  attachments: unknown;
}

interface FeedbackRow {
  feedback_id: string;
  shop_id: string;
  screenshot_object_key: string;
}

/**
 * §5.4 retention sweep (A1-08, RV-12). A plain injectable — the BullMQ shell
 * (maintenance.scheduler/processor) only schedules and invokes sweep().
 *
 * What it deletes, per the §5.4 table (horizons: retention-horizons.ts):
 *  - webhook_inbox rows in terminal states older than 30 days (raw payload
 *    horizon; webhook_inbox_state per 0001: RECEIVED/PROCESSING/PROCESSED/
 *    FAILED/DEAD — only PROCESSED and DEAD are terminal).
 *  - tracking_event_raw partitions fully older than 30 days → DETACH + DROP;
 *    the default partition falls back to bounded row deletes.
 *  - tracking_event partitions fully older than 24 months → same.
 *  - document rows past expires_at (labels/manifests/bundles, 90 days, set
 *    at creation §9.9.1) → object bytes erased via the OBJECT_ERASE seam,
 *    then the row.
 *  - report export objects older than 30 days (shops/{shop}/reports/…,
 *    §11) → object erased; the report_job row is KEPT (the 30-day horizon
 *    applies to the artifact, §5.4).
 *  - ticket attachments 180 days after ticket.resolved_at and feedback
 *    screenshots 180 days after feedback.created_at → object erased, the
 *    reference nulled.
 *  - document rows of kind INVOICE older than 7 financial years
 *    (financialRetentionCutoff, §5.2 FY) → object + row. Shipment and audit
 *    facts share the 7-FY horizon but are NOT deleted at this codebase's
 *    age (nothing is 7 FY old); the cutoff function is tested and applied
 *    only here.
 *  - audit_log is append-only (0002 make_append_only) and is never touched.
 *
 * Batching: every DELETE touches at most RETENTION_BATCH_SIZE rows per
 * statement, looped; every deletion batch writes exactly ONE §12 audit row
 * (SYSTEM actor, counts per table) — never row-per-row.
 *
 * Object keys are validated against the row's own shop prefix before
 * erasure (INV-1): a key outside `shops/{shop_id}/` is never passed to the
 * object store.
 *
 * NOTE (privileges): DELETE on tracking_event / tracking_event_raw and DDL
 * for DETACH/DROP PARTITION are not granted to jsyxi_app by migrations
 * 0001–0017 — see the module header for the required follow-up migration.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(OBJECT_ERASE) private readonly erase: ObjectEraseStore,
    private readonly audit: AuditService,
  ) {}

  // Named `sweep` on purpose: test/booking-ops/auto-ship.spec.ts scans all
  // of src/ for the auto-ship sweep method's exact name and guards that its
  // only caller is the BullMQ queue (§9.5.3 — never on a webhook); reusing
  // that name here would trip the guard.
  async sweep(now: Date = new Date()): Promise<SweepSummary> {
    const summary: SweepSummary = {
      webhook_inbox: 0,
      tracking_event_raw_partitions_dropped: 0,
      tracking_event_raw_rows: 0,
      tracking_event_partitions_dropped: 0,
      tracking_event_rows: 0,
      document: 0,
      document_invoice: 0,
      report_export_objects: 0,
      ticket_attachments: 0,
      feedback_screenshots: 0,
    };

    // §5.4 raw webhook payloads: 30 days, terminal states only.
    summary.webhook_inbox = await this.deleteBatched(
      'webhook_inbox',
      `received_at < $1 AND state IN ('PROCESSED', 'DEAD')`,
      [daysCutoff(now, RAW_WEBHOOK_PAYLOAD_RETENTION_DAYS)],
      { horizon: `${RAW_WEBHOOK_PAYLOAD_RETENTION_DAYS}d` },
    );

    // §5.4 + §5.1: monthly partitions fully past the horizon are dropped
    // wholesale; only the default partition needs row deletes.
    const raw = await this.sweepTrackingPartitions(
      'tracking_event_raw',
      daysCutoff(now, RAW_WEBHOOK_PAYLOAD_RETENTION_DAYS),
    );
    summary.tracking_event_raw_partitions_dropped = raw.partitionsDropped;
    summary.tracking_event_raw_rows = raw.defaultRowsDeleted;

    const normalized = await this.sweepTrackingPartitions(
      'tracking_event',
      monthsCutoff(now, TRACKING_EVENT_RETENTION_MONTHS),
    );
    summary.tracking_event_partitions_dropped = normalized.partitionsDropped;
    summary.tracking_event_rows = normalized.defaultRowsDeleted;

    // §5.4 labels/manifests/temporary bundles: expires_at was set at
    // creation (90 days); the sweep honors the stored instant.
    summary.document = await this.sweepDocuments(
      `expires_at IS NOT NULL AND expires_at < $1 AND kind <> 'INVOICE'`,
      [now],
      { horizon: 'expires_at (90d at creation)' },
    );

    // §5.4 invoice PDFs: 7 financial years (§5.2 FY, 1 Apr–31 Mar).
    summary.document_invoice = await this.sweepDocuments(
      `kind = 'INVOICE' AND generated_at < $1`,
      [financialRetentionCutoff(now)],
      { horizon: `${FINANCIAL_FACT_RETENTION_FY} FY` },
    );

    // §5.4 report exports: 30 days on the artifact; the job row stays.
    summary.report_export_objects = await this.sweepReportExports(
      daysCutoff(now, REPORT_EXPORT_RETENTION_DAYS),
    );

    // §5.4 ticket/feedback attachments: 180 days after closure/submission.
    summary.ticket_attachments = await this.sweepTicketAttachments(
      daysCutoff(now, TICKET_FEEDBACK_ATTACHMENT_RETENTION_DAYS),
    );
    summary.feedback_screenshots = await this.sweepFeedbackScreenshots(
      daysCutoff(now, TICKET_FEEDBACK_ATTACHMENT_RETENTION_DAYS),
    );

    // §5.7 control 4: counts only — no IDs, no keys, no PII in logs.
    this.logger.log(`retention sweep complete ${JSON.stringify(summary)}`);
    return summary;
  }

  /**
   * Bounded batched DELETE on a plain (non-partitioned-parent) table: each
   * statement removes ≤ RETENTION_BATCH_SIZE rows via ctid, looped until
   * nothing matches. One §12 audit row per batch (SYSTEM actor).
   * `table` is only ever a fixed literal from this class — never user input.
   */
  private async deleteBatched(
    table: string,
    whereSql: string,
    params: unknown[],
    auditDetail: Record<string, unknown>,
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const limitParam = params.length + 1;
      const { rowCount } = await this.pool.query(
        `DELETE FROM ${table}
          WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${whereSql} LIMIT $${limitParam})`,
        [...params, RETENTION_BATCH_SIZE],
      );
      const deleted = rowCount ?? 0;
      if (deleted === 0) break;
      total += deleted;
      await this.auditSweepBatch(table, { ...auditDetail, deleted });
    }
    return total;
  }

  /**
   * §5.1/§5.4: drop monthly partitions whose entire range is older than the
   * cutoff (DETACH + DROP — instant, no row scanning), then bounded row
   * deletes on the default partition for anything that landed there.
   */
  private async sweepTrackingPartitions(
    table: 'tracking_event_raw' | 'tracking_event',
    cutoff: Date,
  ): Promise<{ partitionsDropped: number; defaultRowsDeleted: number }> {
    const { rows } = await this.pool.query<{ name: string }>(
      `SELECT c.relname AS name
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE p.relname = $1 AND n.nspname = 'public'`,
      [table],
    );
    // Names come from pg_class and are re-validated against the strict
    // `{table}_YYYY_MM` pattern before being interpolated as identifiers.
    const expired = expiredPartitionNames(
      rows.map((r) => r.name),
      table,
      cutoff,
    );
    for (const name of expired) {
      await this.pool.query(`ALTER TABLE ${table} DETACH PARTITION ${name}`);
      await this.pool.query(`DROP TABLE ${name}`);
      await this.auditSweepBatch(table, {
        partition: name,
        dropped: true,
        cutoff: cutoff.toISOString(),
      });
    }
    const defaultRowsDeleted = await this.deleteBatched(
      `${table}_default`,
      'received_at < $1',
      [cutoff],
      { partition: `${table}_default`, cutoff: cutoff.toISOString() },
    );
    return { partitionsDropped: expired.length, defaultRowsDeleted };
  }

  /**
   * document rows matching `whereSql`: erase the object bytes first (the
   * OBJECT_ERASE seam — booking-ops ObjectStore has no delete), detach job
   * references (§5.3: references block deletion — document_job and
   * report_job point at result documents), then delete the rows.
   */
  private async sweepDocuments(
    whereSql: string,
    params: unknown[],
    auditDetail: Record<string, unknown>,
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const limitParam = params.length + 1;
      const { rows } = await this.pool.query<DocumentRow>(
        `SELECT document_id, shop_id, object_key FROM document
          WHERE ${whereSql} LIMIT $${limitParam}`,
        [...params, RETENTION_BATCH_SIZE],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        this.assertShopKey(row.shop_id, row.object_key); // INV-1
        await this.erase.delete(row.object_key);
      }
      const ids = rows.map((r) => r.document_id);
      await this.pool.query(
        `UPDATE document_job SET result_document_id = NULL
          WHERE result_document_id = ANY($1::uuid[])`,
        [ids],
      );
      await this.pool.query(
        `UPDATE report_job SET result_document_id = NULL
          WHERE result_document_id = ANY($1::uuid[])`,
        [ids],
      );
      const { rowCount } = await this.pool.query(
        `DELETE FROM document WHERE document_id = ANY($1::uuid[])`,
        [ids],
      );
      const deleted = rowCount ?? 0;
      total += deleted;
      await this.auditSweepBatch('document', {
        ...auditDetail,
        deleted,
        objects_erased: rows.length,
      });
    }
    return total;
  }

  /**
   * §5.4 report exports: erase the artifact object at
   * shops/{shopId}/reports/{reportJobId}.csv (report-url-signing.ts is the
   * single authority on that key format). The report_job row is KEPT — the
   * 30-day horizon applies to the export, not the job record.
   */
  private async sweepReportExports(cutoff: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const { rows } = await this.pool.query<{
        report_job_id: string;
        shop_id: string;
      }>(
        `SELECT report_job_id, shop_id FROM report_job
          WHERE state = 'SUCCEEDED' AND created_at < $1
          LIMIT $2`,
        [cutoff, RETENTION_BATCH_SIZE],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        await this.erase.delete(reportObjectKey(row.shop_id, row.report_job_id));
      }
      total += rows.length;
      await this.auditSweepBatch('report_job', {
        horizon: `${REPORT_EXPORT_RETENTION_DAYS}d`,
        objects_erased: rows.length,
        rows_kept: rows.length, // §5.4: the artifact expires, the job stays
      });
      if (rows.length < RETENTION_BATCH_SIZE) break;
    }
    return total;
  }

  /**
   * §5.4 ticket attachments: 180 days after closure (ticket.resolved_at).
   * The attachment bytes are erased and the ticket_message reference
   * emptied; message text and the ticket itself stay.
   */
  private async sweepTicketAttachments(cutoff: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const { rows } = await this.pool.query<TicketMessageRow>(
        `SELECT m.message_id, t.shop_id, m.attachments
           FROM ticket_message m
           JOIN ticket t ON t.ticket_id = m.ticket_id
          WHERE t.resolved_at IS NOT NULL AND t.resolved_at < $1
            AND m.attachments <> '[]'::jsonb
          LIMIT $2`,
        [cutoff, RETENTION_BATCH_SIZE],
      );
      if (rows.length === 0) break;
      let erased = 0;
      for (const row of rows) {
        const attachments = Array.isArray(row.attachments)
          ? (row.attachments as Array<{ key?: unknown }>)
          : [];
        for (const attachment of attachments) {
          if (typeof attachment?.key !== 'string') continue;
          this.assertShopKey(row.shop_id, attachment.key); // INV-1
          await this.erase.delete(attachment.key);
          erased += 1;
        }
      }
      await this.pool.query(
        `UPDATE ticket_message SET attachments = '[]'::jsonb
          WHERE message_id = ANY($1::uuid[])`,
        [rows.map((r) => r.message_id)],
      );
      total += erased;
      await this.auditSweepBatch('ticket_message', {
        horizon: `${TICKET_FEEDBACK_ATTACHMENT_RETENTION_DAYS}d after closure`,
        messages_cleared: rows.length,
        objects_erased: erased,
      });
      if (rows.length < RETENTION_BATCH_SIZE) break;
    }
    return total;
  }

  /**
   * §5.4 feedback screenshots: 180 days after submission
   * (feedback.created_at). Object erased, reference nulled; the rating and
   * comment stay.
   */
  private async sweepFeedbackScreenshots(cutoff: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const { rows } = await this.pool.query<FeedbackRow>(
        `SELECT feedback_id, shop_id, screenshot_object_key FROM feedback
          WHERE screenshot_object_key IS NOT NULL AND created_at < $1
          LIMIT $2`,
        [cutoff, RETENTION_BATCH_SIZE],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        this.assertShopKey(row.shop_id, row.screenshot_object_key); // INV-1
        await this.erase.delete(row.screenshot_object_key);
      }
      await this.pool.query(
        `UPDATE feedback SET screenshot_object_key = NULL
          WHERE feedback_id = ANY($1::uuid[])`,
        [rows.map((r) => r.feedback_id)],
      );
      total += rows.length;
      await this.auditSweepBatch('feedback', {
        horizon: `${TICKET_FEEDBACK_ATTACHMENT_RETENTION_DAYS}d after submission`,
        objects_erased: rows.length,
      });
      if (rows.length < RETENTION_BATCH_SIZE) break;
    }
    return total;
  }

  /** INV-1: an object key is erasable only under its own shop's prefix. */
  private assertShopKey(shopId: string, key: string): void {
    if (!key.startsWith(`shops/${shopId}/`)) {
      throw new Error(`object key outside shop prefix refused`);
    }
  }

  /** §12: one audit row per deletion batch — SYSTEM actor, counts only. */
  private async auditSweepBatch(
    table: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      shopId: null,
      actorKind: 'SYSTEM',
      action: 'maintenance.retention_sweep',
      objectType: table,
      after: { table, ...detail },
      reason: '§5.4 retention sweep',
    });
  }
}
