import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { paiseToRupees, rupeesToPaise } from '../../common/money';
import { LocalFilesystemObjectStore, OBJECT_STORE } from '../booking-ops/object-store';
import {
  contentHash,
  looksLikeArchiveOrBinary,
  parseInvoiceDate,
} from './recon-csv';
import { ReconFreightQueue } from './recon-queue';
import {
  FREIGHT_IMPORT_MAX_BYTES,
  FREIGHT_IMPORT_MAX_ROWS,
  TaxTreatment,
  UploadBatchResult,
} from './recon-freight.types';

/**
 * §9.17.1 freight invoice import (upload-only — RV-09: no courier-API
 * retrieval in v1). Quarantine per §8.7 (size/row limits §5.1, archive and
 * binary rejection, formula neutralization at parse), INV-14 idempotency on
 * (shop_id, content_hash), then async matching on the `recon-processing`
 * queue (§5.7).
 *
 * The raw file is stored content-addressed in the object store
 * (`shops/{shop}/recon/imports/{sha256}` — INV-1 shop-scoped path); the
 * batch row carries only the hash and metadata.
 */

export interface UploadBatchInput {
  shopId: string;
  memberId: string;
  filename: string;
  csvBytes: Buffer;
  courierAccountId: string;
  columnMapId: string;
  declaredInvoiceTotal: string; // rupees text, ≥ 0
  taxTreatment: TaxTreatment;
  invoiceReference: string;
  invoiceDate: string; // YYYY-MM-DD, never future-dated (§5.2)
}

interface BatchRow {
  batch_id: string;
  state: string;
  batch_reference: string;
  version: number;
}

@Injectable()
export class ReconImportService {
  private readonly logger = new Logger(ReconImportService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(OBJECT_STORE) private readonly store: LocalFilesystemObjectStore,
    private readonly queue: ReconFreightQueue,
    private readonly audit: AuditService,
  ) {}

  /** Shop-local YYYY-MM-DD (§5.2 display/derivation in the Shop timezone). */
  private async shopLocalDate(shopId: string, now: Date): Promise<string> {
    const { rows } = await this.pool.query<{ iana_timezone: string }>(
      `SELECT iana_timezone FROM shop WHERE shop_id = $1`,
      [shopId],
    );
    const tz = rows[0]?.iana_timezone ?? 'Asia/Kolkata'; // §7.1 S-2 default
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  }

  /** §13.5: FREIGHT-{yyyymmdd}-{seq}, unique per Shop per day. */
  private async nextBatchReference(shopId: string, localDate: string): Promise<string> {
    const prefix = `FREIGHT-${localDate.replace(/-/g, '')}-`;
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM recon_freight_batch
        WHERE shop_id = $1 AND batch_reference LIKE $2`,
      [shopId, `${prefix}%`],
    );
    return `${prefix}${Number(rows[0]?.n ?? '0') + 1}`;
  }

  async upload(input: UploadBatchInput): Promise<UploadBatchResult> {
    /* ---------------- §8.7 / §5.1 quarantine ---------------- */
    if (input.csvBytes.length === 0) return { ok: false, code: 'EMPTY_FILE' };
    if (input.csvBytes.length > FREIGHT_IMPORT_MAX_BYTES) {
      return { ok: false, code: 'FILE_TOO_LARGE' };
    }
    if (looksLikeArchiveOrBinary(input.csvBytes)) {
      return { ok: false, code: 'ARCHIVE_OR_BINARY' };
    }
    // Cheap pre-parse row bound (the exact parsed count is re-checked by the
    // processor, which fails the batch per §3.18 when exceeded).
    let newlines = 0;
    for (const b of input.csvBytes) if (b === 0x0a) newlines++;
    if (newlines > FREIGHT_IMPORT_MAX_ROWS) {
      return { ok: false, code: 'TOO_MANY_ROWS' };
    }

    /* ---------------- §8.7 declared metadata ---------------- */
    let declaredPaise;
    try {
      declaredPaise = rupeesToPaise(input.declaredInvoiceTotal);
      if (declaredPaise < 0n) throw new Error('negative'); // §4.1
    } catch {
      return { ok: false, code: 'INVALID_METADATA', detail: 'declared_invoice_total' };
    }
    // The column is rupee-denominated NUMERIC(19,4) (§4.1); paise are the
    // internal compute unit only.
    const declaredRupees = paiseToRupees(declaredPaise);
    if (input.taxTreatment !== 'TAX_INCLUSIVE' && input.taxTreatment !== 'TAX_EXCLUSIVE') {
      return { ok: false, code: 'INVALID_METADATA', detail: 'tax_treatment' };
    }
    if (input.invoiceReference.trim() === '') {
      return { ok: false, code: 'INVALID_METADATA', detail: 'invoice_reference' };
    }
    const invoiceDate = parseInvoiceDate(input.invoiceDate);
    if (invoiceDate === null) {
      return { ok: false, code: 'INVALID_METADATA', detail: 'invoice_date' };
    }
    const localToday = await this.shopLocalDate(input.shopId, new Date());
    if (invoiceDate > localToday) {
      // §5.2: invoice dates may be historical but never future-dated.
      return { ok: false, code: 'FUTURE_INVOICE_DATE' };
    }

    const { rows: accounts } = await this.pool.query<{ courier_id: string }>(
      `SELECT courier_id FROM courier_account
        WHERE courier_account_id = $1 AND shop_id = $2`,
      [input.courierAccountId, input.shopId],
    );
    if (!accounts[0]) return { ok: false, code: 'UNKNOWN_COURIER_ACCOUNT' };

    const { rows: maps } = await this.pool.query<{ courier_id: string; kind: string }>(
      `SELECT courier_id, kind::text FROM import_column_map WHERE column_map_id = $1`,
      [input.columnMapId],
    );
    if (!maps[0]) return { ok: false, code: 'UNKNOWN_COLUMN_MAP' };
    if (maps[0].kind !== 'FREIGHT' || maps[0].courier_id !== accounts[0].courier_id) {
      return { ok: false, code: 'COLUMN_MAP_KIND' };
    }

    /* ---------------- INV-14 idempotency ---------------- */
    const hash = contentHash(input.csvBytes);
    const { rows: existing } = await this.pool.query<BatchRow>(
      `SELECT batch_id, state::text, batch_reference, version
         FROM recon_freight_batch
        WHERE shop_id = $1 AND content_hash = $2`,
      [input.shopId, hash],
    );
    const found = existing[0];
    if (found && found.state !== 'FAILED') {
      // INV-14: same file for the same Shop is a no-op, not a duplicate.
      return {
        ok: true,
        batchId: found.batch_id,
        batchReference: found.batch_reference,
        reused: true,
        reprocessing: false,
      };
    }

    // Content-addressed raw storage (INV-1 shop-scoped object path).
    const objectKey = `shops/${input.shopId}/recon/imports/${hash}`;
    await this.store.put(objectKey, input.csvBytes);

    if (found) {
      // §3.18: FAILED is not idempotency-blocking — the same batch row is
      // revived and reprocessed (its reference is kept).
      const { rows: revived } = await this.pool.query<BatchRow>(
        `UPDATE recon_freight_batch
            SET state = 'UPLOADED',
                courier_account_id = $3,
                column_map_id = $4,
                filename = $5,
                tax_treatment = $6,
                invoice_reference = $7,
                invoice_date = $8::date,
                declared_invoice_total = $9,
                uploaded_by = $10,
                uploaded_at = now(),
                residual = NULL,
                control_total_state = 'WITHIN_THRESHOLD',
                residual_remark = NULL,
                version = version + 1
          WHERE batch_id = $1 AND shop_id = $2 AND state = 'FAILED'
          RETURNING batch_id, state::text, batch_reference, version`,
        [
          found.batch_id,
          input.shopId,
          input.courierAccountId,
          input.columnMapId,
          input.filename,
          input.taxTreatment,
          input.invoiceReference,
          invoiceDate,
          declaredRupees,
          input.memberId,
        ],
      );
      const batch = revived[0] ?? found; // lost a race ⇒ treat as the no-op
      await this.queue.enqueueProcessBatch(batch.batch_id);
      await this.audit.record({
        shopId: input.shopId,
        actorKind: 'MEMBER',
        actorId: input.memberId,
        action: 'recon.freight_batch_reuploaded', // §12; §3.18 FAILED retry
        objectType: 'recon_freight_batch',
        objectId: batch.batch_id,
        before: { state: 'FAILED', version: found.version },
        after: { state: 'UPLOADED', batchReference: batch.batch_reference },
      });
      return {
        ok: true,
        batchId: batch.batch_id,
        batchReference: batch.batch_reference,
        reused: false,
        reprocessing: true,
      };
    }

    const batchReference = await this.nextBatchReference(input.shopId, localToday);
    const { rows: inserted } = await this.pool.query<BatchRow>(
      `INSERT INTO recon_freight_batch
         (shop_id, courier_account_id, batch_reference, filename, content_hash,
          column_map_id, tax_treatment, invoice_reference, invoice_date,
          declared_invoice_total, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11)
       ON CONFLICT (shop_id, content_hash) DO NOTHING
       RETURNING batch_id, state::text, batch_reference, version`,
      [
        input.shopId,
        input.courierAccountId,
        batchReference,
        input.filename,
        hash,
        input.columnMapId,
        input.taxTreatment,
        input.invoiceReference,
        invoiceDate,
        declaredRupees,
        input.memberId,
      ],
    );
    let batch = inserted[0];
    if (!batch) {
      // Lost the concurrent-upload race: the other request's batch IS the
      // INV-14 no-op target.
      const { rows: raced } = await this.pool.query<BatchRow>(
        `SELECT batch_id, state::text, batch_reference, version
           FROM recon_freight_batch WHERE shop_id = $1 AND content_hash = $2`,
        [input.shopId, hash],
      );
      batch = raced[0];
      if (!batch) {
        // The conflicting row vanished between insert and re-read — the DB is
        // in a state this flow cannot explain; fail loudly, never silently.
        throw new Error(`recon batch lost after insert conflict (shop ${input.shopId})`);
      }
      return {
        ok: true,
        batchId: batch.batch_id,
        batchReference: batch.batch_reference,
        reused: true,
        reprocessing: false,
      };
    }

    await this.queue.enqueueProcessBatch(batch.batch_id);
    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'MEMBER',
      actorId: input.memberId,
      action: 'recon.freight_batch_uploaded', // §12
      objectType: 'recon_freight_batch',
      objectId: batch.batch_id,
      after: {
        batchReference: batch.batch_reference,
        filename: input.filename,
        courierAccountId: input.courierAccountId,
      },
    });
    this.logger.log(`freight batch ${batch.batch_id} uploaded (${batch.batch_reference})`);
    return {
      ok: true,
      batchId: batch.batch_id,
      batchReference: batch.batch_reference,
      reused: false,
      reprocessing: false,
    };
  }
}
