import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { DocumentUrlSigner } from '../booking-ops/document-urls';
import { OBJECT_STORE, ObjectStore } from '../booking-ops/object-store';
import { AdapterCallerService } from '../courier-framework/adapter-caller.service';
import type { BookingSnapshot } from '../booking/booking.types';
import { LabelTemplateService } from './label-template.service';
import { LabelQueueService } from './label-queue';
import { buildMergedLabelPdf, buildPdf, LabelRenderInput } from './label-pdf';
import {
  BULK_LABEL_MAX_SHIPMENTS,
  BulkLabelKind,
  JobState,
  LABEL_RETENTION_DAYS,
  LabelJobData,
  LabelJobProgress,
  LabelMode,
  LabelSkipped,
} from './labels.types';

/** §3.11: these states block NEW label generation, bulk jobs included. */
const BLOCKED_ACCOUNT_STATES = new Set(['RESTRICTED', 'READ_ONLY', 'UNINSTALLED']);

const TERMINAL_JOB_STATES = new Set<JobState>(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED']);

export interface CreateBulkJobInput {
  shopId: string;
  actorId: string;
  shipmentIds: string[];
  bulkKind: BulkLabelKind;
}

export interface CreateBulkJobResult {
  jobId: string;
  state: JobState;
  total: number;
}

export interface BulkJobView {
  jobId: string;
  kind: BulkLabelKind;
  state: JobState;
  progress: LabelJobProgress;
  skippedReport: LabelSkipped[] | null;
  result: { documentId: string; downloadUrl: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface BulkShipmentRow {
  shipment_id: string;
  order_id: string;
  booking_state: string;
  awb_normalized: string | null;
  courier_account_id: string | null;
  is_test: boolean;
  snapshot: BookingSnapshot | null;
  service_id: string | null;
  service_name: string | null;
  label_mode: LabelMode | null;
}

interface DocumentJobRow {
  job_id: string;
  state: JobState;
  progress: LabelJobProgress;
  filters: { shipmentIds?: string[]; reprint?: boolean } | null;
  result_document_id: string | null;
  skipped_report: LabelSkipped[] | null;
  created_at: string;
  updated_at: string;
}

/**
 * §9.9.1 bulk merged label PDF and ADD-36 bulk label reprint. Both are
 * document_job rows (kind BULK_LABEL) processed asynchronously on the §5.7
 * `label` queue; a reprint is identical in shape and regenerates from the
 * frozen snapshots (INV-8). Pages are sorted by Service only (A4-02). Skips
 * are never silent (INV-20): every skipped shipment lands in skipped_report
 * and any skip ends the job PARTIAL (§3.27) — the merged PDF is still
 * produced. The worker shell (label.processor.ts) is thin; this method is
 * the plain injectable, unit-testable core.
 */
@Injectable()
export class BulkLabelsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly templates: LabelTemplateService,
    private readonly adapters: AdapterCallerService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    private readonly signer: DocumentUrlSigner,
    private readonly audit: AuditService,
    private readonly queue: LabelQueueService,
  ) {}

  /** ≤1,000 shipments per job (§5.1); duplicate ids collapse to one page. */
  async createBulkJob(input: CreateBulkJobInput): Promise<CreateBulkJobResult> {
    const shipmentIds = [...new Set(input.shipmentIds)];
    if (shipmentIds.length === 0) {
      throw new UnprocessableEntityException('shipmentIds must be a non-empty array');
    }
    if (shipmentIds.length > BULK_LABEL_MAX_SHIPMENTS) {
      throw new UnprocessableEntityException(
        `bulk label jobs are limited to ${BULK_LABEL_MAX_SHIPMENTS} shipments (§5.1)`,
      );
    }

    // §3.11: RESTRICTED blocks new label generation.
    const { rows: shopRows } = await this.pool.query<{ account_state: string }>(
      `SELECT account_state FROM shop WHERE shop_id = $1`,
      [input.shopId],
    );
    if (shopRows[0] && BLOCKED_ACCOUNT_STATES.has(shopRows[0].account_state)) {
      throw new ForbiddenException('account state blocks new label generation (§3.11)');
    }

    const jobId = randomUUID();
    const progress: LabelJobProgress = {
      total: shipmentIds.length,
      processed: 0,
      rendered: 0,
      skipped: 0,
    };
    await this.pool.query(
      `INSERT INTO document_job (job_id, shop_id, kind, requested_by, filters, state, progress)
       VALUES ($1, $2, 'BULK_LABEL', $3, $4, 'QUEUED', $5)`,
      [
        jobId,
        input.shopId,
        input.actorId,
        JSON.stringify({ shipmentIds, reprint: input.bulkKind === 'REPRINT' }),
        JSON.stringify(progress),
      ],
    );

    // §12: document export is audited (ids only, §5.7 control 4).
    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'MEMBER',
      actorId: input.actorId,
      action:
        input.bulkKind === 'REPRINT' ? 'BULK_LABEL_REPRINT_CREATED' : 'BULK_LABEL_JOB_CREATED',
      objectType: 'document_job',
      objectId: jobId,
      after: { total: shipmentIds.length },
    });

    const data: LabelJobData = { shopId: input.shopId, jobId };
    await this.queue.enqueueLabelJob(data);
    return { jobId, state: 'QUEUED', total: shipmentIds.length };
  }

  /** Shop-scoped job view (INV-1): progress, result and the skipped report. */
  async getJob(shopId: string, jobId: string): Promise<BulkJobView> {
    const { rows } = await this.pool.query<DocumentJobRow>(
      `SELECT job_id, state, progress, filters, result_document_id, skipped_report,
              created_at, updated_at
         FROM document_job
        WHERE shop_id = $1 AND job_id = $2 AND kind = 'BULK_LABEL'`,
      [shopId, jobId],
    );
    const job = rows[0];
    if (!job) throw new NotFoundException('label job not found');
    return {
      jobId: job.job_id,
      kind: job.filters?.reprint ? 'REPRINT' : 'BULK',
      state: job.state,
      progress: job.progress,
      skippedReport: job.skipped_report,
      result: job.result_document_id
        ? {
            documentId: job.result_document_id,
            downloadUrl: this.signer.signDocumentUrl(job.result_document_id),
          }
        : null,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    };
  }

  /**
   * The plain injectable behind the BullMQ shell. Idempotent: a terminal job
   * is a no-op (BullMQ retries after a crash re-enter safely).
   */
  async processBulkJob(data: LabelJobData): Promise<void> {
    const { rows } = await this.pool.query<DocumentJobRow>(
      `SELECT job_id, state, progress, filters, result_document_id, skipped_report,
              created_at, updated_at
         FROM document_job
        WHERE shop_id = $1 AND job_id = $2 AND kind = 'BULK_LABEL'`,
      [data.shopId, data.jobId],
    );
    const job = rows[0];
    if (!job) throw new NotFoundException('label job not found');
    if (TERMINAL_JOB_STATES.has(job.state)) return; // exactly-once

    const shipmentIds = job.filters?.shipmentIds ?? [];
    const progress: LabelJobProgress = {
      total: shipmentIds.length,
      processed: 0,
      rendered: 0,
      skipped: 0,
    };
    await this.saveProgress(data, 'RUNNING', progress);

    try {
      const { renderables, skipped, allTest } = await this.collectPages(
        data.shopId,
        shipmentIds,
        progress,
        data,
      );

      // The job always produces a document (§3.27) — even when every shipment
      // was skipped, so the skipped report has an artifact attached. The
      // cover page carries no label content (no PII, §5.7 control 4).
      const bytes =
        renderables.length > 0
          ? buildMergedLabelPdf(renderables, (await this.templates.getOrCreate(data.shopId)).size)
          : buildPdf([
              {
                width: 595,
                height: 842,
                ops: [
                  {
                    type: 'text',
                    x: 50,
                    y: 780,
                    size: 12,
                    text: 'No labels could be generated - see the skipped report.',
                  },
                ],
              },
            ]);

      const documentId = randomUUID();
      const objectKey = `shops/${data.shopId}/labels/bulk/${data.jobId}.pdf`;
      await this.store.put(objectKey, bytes);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      // §5.4: 90-day retention. A merged document is marked test only when
      // every page is a test shipment (§2.6 inherits is_test per Shipment;
      // individual test pages still carry the §9.23 marker).
      await this.pool.query(
        `INSERT INTO document
           (document_id, shop_id, kind, shipment_id, object_key, sha256, bytes,
            expires_at, is_test)
         VALUES ($1, $2, 'BULK_LABEL', NULL, $3, $4, $5,
                 now() + ($6 || ' days')::interval, $7)`,
        [documentId, data.shopId, objectKey, sha256, bytes.length, LABEL_RETENTION_DAYS, allTest],
      );

      // §3.27: any skip → PARTIAL; the merged PDF + skipped report still exist.
      const state: JobState = skipped.length > 0 ? 'PARTIAL' : 'SUCCEEDED';
      await this.pool.query(
        `UPDATE document_job
            SET state = $3, progress = $4, result_document_id = $5, skipped_report = $6
          WHERE shop_id = $1 AND job_id = $2`,
        [
          data.shopId,
          data.jobId,
          state,
          JSON.stringify(progress),
          documentId,
          JSON.stringify(skipped),
        ],
      );

      await this.audit.record({
        shopId: data.shopId,
        actorKind: 'SYSTEM',
        action: 'BULK_LABEL_JOB_COMPLETED',
        objectType: 'document_job',
        objectId: data.jobId,
        after: { state, rendered: progress.rendered, skipped: progress.skipped, documentId },
      });
    } catch (err) {
      await this.pool.query(
        `UPDATE document_job SET state = 'FAILED', progress = $3
          WHERE shop_id = $1 AND job_id = $2`,
        [data.shopId, data.jobId, JSON.stringify(progress)],
      );
      throw err; // BullMQ retries; the terminal guard above keeps it idempotent
    }
  }

  /**
   * Load, classify and sort the requested shipments. Sorted by Service only
   * (A4-02) — service name, with the shipment id as a deterministic tiebreak
   * inside one service. Returns the render inputs in page order plus the
   * skipped report (INV-20).
   */
  private async collectPages(
    shopId: string,
    shipmentIds: string[],
    progress: LabelJobProgress,
    data: LabelJobData,
  ): Promise<{ renderables: LabelRenderInput[]; skipped: LabelSkipped[]; allTest: boolean }> {
    const { rows } = await this.pool.query<BulkShipmentRow>(
      `SELECT sh.shipment_id, sh.order_id, sh.booking_state, sh.awb_normalized,
              sh.courier_account_id, sh.is_test, sh.snapshot,
              sh.service_id, s.name AS service_name, s.label_mode
         FROM shipment sh
         LEFT JOIN service s ON s.service_id = sh.service_id
        WHERE sh.shop_id = $1 AND sh.shipment_id = ANY($2)`,
      [shopId, shipmentIds],
    );
    const byId = new Map(rows.map((r) => [r.shipment_id, r]));

    const skipped: LabelSkipped[] = [];
    const candidates: BulkShipmentRow[] = [];
    for (const id of shipmentIds) {
      const row = byId.get(id);
      if (!row) {
        skipped.push({ shipmentId: id, reason: 'SHIPMENT_NOT_FOUND' });
        continue;
      }
      candidates.push(row);
    }

    // A4-02: sorted by Service only.
    candidates.sort((a, b) => {
      const svc = (a.service_name ?? '').localeCompare(b.service_name ?? '');
      return svc !== 0 ? svc : a.shipment_id.localeCompare(b.shipment_id);
    });

    const template = await this.templates.getOrCreate(shopId);
    const orderNumbers = await this.loadOrderNumbers(shopId, [
      ...new Set(candidates.map((c) => c.order_id)),
    ]);

    const renderables: LabelRenderInput[] = [];
    let allTest = candidates.length > 0;
    for (const row of candidates) {
      progress.processed += 1;
      if (row.booking_state !== 'CONFIRMED') {
        skipped.push({ shipmentId: row.shipment_id, reason: 'NOT_CONFIRMED' });
      } else if (!row.snapshot) {
        // INV-8: no frozen snapshot → nothing to render from.
        skipped.push({ shipmentId: row.shipment_id, reason: 'MISSING_SNAPSHOT' });
      } else if (row.label_mode === 'COURIER_PDF_REQUIRED') {
        skipped.push(await this.tryCourierPdf(shopId, row));
      } else {
        renderables.push({
          snapshot: row.snapshot,
          awb: row.awb_normalized,
          orderNumber: orderNumbers.get(row.order_id) ?? null,
          template: {
            brandName: template.brand_name,
            supportPhone: template.support_phone,
            messageLine: template.message_line,
            toggles: template.toggles,
          },
          isTest: row.is_test,
        });
        progress.rendered += 1;
      }
      if (!row.is_test) allTest = false;
      if (progress.processed % 25 === 0) {
        progress.skipped = skipped.length;
        await this.saveProgress(data, 'RUNNING', progress);
      }
    }
    progress.skipped = skipped.length;
    return { renderables, skipped, allTest };
  }

  /**
   * §9.9.1: a COURIER_PDF_REQUIRED label is the courier's own PDF. The
   * hand-rolled writer cannot merge foreign PDF bytes into the bulk document
   * (no new dependencies), so even a successful fetch is reported as a skip —
   * the single-label endpoint serves these. Fetch failures skip the same way
   * (INV-20; error class only in detail, never payloads).
   */
  private async tryCourierPdf(shopId: string, row: BulkShipmentRow): Promise<LabelSkipped> {
    try {
      if (!row.awb_normalized || !row.courier_account_id) throw new Error('missing awb/account');
      await this.adapters.call(shopId, row.courier_account_id, 'getLabel', (a) =>
        a.getLabel(row.awb_normalized as string, 'PDF'),
      );
      return { shipmentId: row.shipment_id, reason: 'COURIER_PDF_NOT_MERGEABLE' };
    } catch (err) {
      return {
        shipmentId: row.shipment_id,
        reason: 'COURIER_PDF_FETCH_FAILED',
        detail: err instanceof Error ? err.name : 'Error',
      };
    }
  }

  private async loadOrderNumbers(
    shopId: string,
    orderIds: string[],
  ): Promise<Map<string, string>> {
    if (orderIds.length === 0) return new Map();
    const { rows } = await this.pool.query<{ order_id: string; shopify_order_number: string | null }>(
      `SELECT order_id, shopify_order_number FROM "order"
        WHERE shop_id = $1 AND order_id = ANY($2)`,
      [shopId, orderIds],
    );
    const map = new Map<string, string>();
    for (const r of rows) if (r.shopify_order_number) map.set(r.order_id, r.shopify_order_number);
    return map;
  }

  private async saveProgress(
    data: LabelJobData,
    state: JobState,
    progress: LabelJobProgress,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE document_job SET state = $3, progress = $4
        WHERE shop_id = $1 AND job_id = $2`,
      [data.shopId, data.jobId, state, JSON.stringify(progress)],
    );
  }
}
