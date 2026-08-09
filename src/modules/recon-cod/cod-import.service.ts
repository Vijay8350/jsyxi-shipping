import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { localDateString, DEFAULT_TIMEZONE } from './cod-state';
import { CodExpectationService } from './cod-expectation.service';
import {
  DEFAULT_REMITTANCE_MAPPING,
  mappingFromColumnMap,
  parseRemittanceCsv,
  RemittanceStructureError,
  type RemittanceColumnMapping,
} from './cod-remittance-csv';
import {
  COD_IMPORT_MAX_BYTES,
  type CodBatchRow,
  type UnmatchedItem,
} from './recon-cod.types';
import { paiseToRupees, rupeesToPaise } from '../../common/money';

export interface UploadCodBatchInput {
  shopId: string;
  actorMemberId: string;
  filename: string;
  /** Raw file bytes, base64-encoded at the API boundary. */
  contentBase64: string;
  courierAccountId: string;
  columnMapId?: string | null;
  remittanceReference?: string | null;
  /** 'YYYY-MM-DD', never future-dated (§5.2). */
  remittanceDate?: string | null;
  /** 2dp rupee string. */
  declaredTotal?: string | null;
}

export interface UploadCodBatchResult {
  batch: CodBatchRow;
  /** INV-14: same content hash re-uploaded against a live batch → no-op. */
  idempotent: boolean;
  /** §3.18: the prior batch with this hash was FAILED, so it was reset. */
  reuploaded: boolean;
}

export interface ProcessBatchResult {
  batchId: string;
  state: 'MATCHED' | 'FAILED' | 'SKIPPED';
  matched: number;
  unmatched: number;
}

/**
 * §9.17.1/§9.17.3: COD remittance import (upload-only, RV-09) and the
 * idempotent partial-allocation path.
 *
 * Money boundary (INV-23): a remittance row records cash that moved between
 * the courier and the merchant. Allocating it changes Jsyxi records only —
 * nothing is paid out, held or settled here.
 */
@Injectable()
export class CodImportService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly expectations: CodExpectationService,
    private readonly audit: AuditService,
  ) {}

  /** INV-14 content identity of the uploaded bytes. */
  static contentHash(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
  }

  private async shopTimezone(shopId: string): Promise<string> {
    const res = await this.pool.query<{ timezone: string }>(
      `SELECT timezone FROM store_settings WHERE shop_id = $1`,
      [shopId],
    );
    return res.rows[0]?.timezone ?? DEFAULT_TIMEZONE;
  }

  private async loadMapping(
    shopId: string,
    columnMapId: string | null | undefined,
  ): Promise<{ mapping: RemittanceColumnMapping; columnMapId: string | null }> {
    if (!columnMapId) return { mapping: DEFAULT_REMITTANCE_MAPPING, columnMapId: null };
    const res = await this.pool.query<{ mappings_json: unknown }>(
      // import_column_map is a [global] admin template (§2.7); kind must be COD.
      `SELECT mappings_json FROM import_column_map
        WHERE column_map_id = $1 AND kind = 'COD'`,
      [columnMapId],
    );
    if (!res.rows[0]) {
      throw new UnprocessableEntityException(`unknown COD column map ${columnMapId} (§9.17.1)`);
    }
    try {
      return { mapping: mappingFromColumnMap(res.rows[0].mappings_json), columnMapId };
    } catch (err) {
      throw new UnprocessableEntityException((err as Error).message);
    }
  }

  /**
   * POST /recon/cod/batches (Finance+). §8.7 size ceiling; INV-14 makes a
   * same-hash re-upload a no-op — except when the earlier batch FAILED,
   * which §3.18 explicitly allows to be re-uploaded under the same hash.
   */
  async uploadBatch(input: UploadCodBatchInput): Promise<UploadCodBatchResult> {
    const buf = Buffer.from(input.contentBase64, 'base64');
    if (buf.length === 0) throw new UnprocessableEntityException('empty upload');
    if (buf.length > COD_IMPORT_MAX_BYTES) {
      throw new UnprocessableEntityException(
        `file exceeds the 50 MB import limit (§5.1/§8.7): ${buf.length} bytes`,
      );
    }
    if (input.declaredTotal != null) {
      try {
        if (rupeesToPaise(input.declaredTotal) < 0n) throw new Error('negative');
      } catch {
        throw new UnprocessableEntityException(
          `declared_total must be a non-negative INR amount, got "${input.declaredTotal}"`,
        );
      }
    }
    const timeZone = await this.shopTimezone(input.shopId);
    if (input.remittanceDate != null) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.remittanceDate)) {
        throw new UnprocessableEntityException('remittance_date must be YYYY-MM-DD');
      }
      // §5.2: never future-dated, evaluated shop-local.
      if (input.remittanceDate > localDateString(new Date(), timeZone)) {
        throw new UnprocessableEntityException('remittance_date cannot be future-dated (§5.2)');
      }
    }
    const { mapping, columnMapId } = await this.loadMapping(input.shopId, input.columnMapId);
    const contentHash = CodImportService.contentHash(buf);

    // INV-14: content-hash identity per shop.
    const existing = await this.pool.query<CodBatchRow>(
      `SELECT cod_batch_id, shop_id, courier_account_id, batch_reference, filename,
              content_hash, column_map_id, remittance_reference, remittance_date::text,
              declared_total::text, state,
              COALESCE(matched_count, 0)::int AS matched_count,
              COALESCE(unmatched_count, 0)::int AS unmatched_count,
              COALESCE(unmatched_json, '[]'::jsonb) AS unmatched_json,
              version
         FROM recon_cod_batch WHERE shop_id = $1 AND content_hash = $2`,
      [input.shopId, contentHash],
    );
    const prior = existing.rows[0];
    if (prior && prior.state !== 'FAILED') {
      return { batch: prior, idempotent: true, reuploaded: false };
    }
    if (prior) {
      // §3.18: FAILED holds no rows and is not idempotency-blocking — reset
      // the same row for a fresh processing run.
      const reset = await this.pool.query<CodBatchRow>(
        `UPDATE recon_cod_batch
            SET state = 'UPLOADED', filename = $3, courier_account_id = $4,
                column_map_id = $5, remittance_reference = $6,
                remittance_date = $7::date, declared_total = $8::numeric,
                matched_count = 0, unmatched_count = 0, unmatched_json = '[]'::jsonb,
                version = version + 1
          WHERE cod_batch_id = $1 AND shop_id = $2 AND state = 'FAILED'
          RETURNING cod_batch_id, shop_id, courier_account_id, batch_reference, filename,
                    content_hash, column_map_id, remittance_reference, remittance_date::text,
                    declared_total::text, state, matched_count, unmatched_count,
                    unmatched_json, version`,
        [
          prior.cod_batch_id,
          input.shopId,
          input.filename,
          input.courierAccountId,
          columnMapId,
          input.remittanceReference ?? null,
          input.remittanceDate ?? null,
          input.declaredTotal ?? null,
        ],
      );
      const batch = reset.rows[0];
      if (!batch) {
        // Lost a race with another reset; treat as the idempotent no-op.
        return { batch: prior, idempotent: true, reuploaded: false };
      }
      await this.audit.record({
        shopId: input.shopId,
        actorKind: 'MEMBER',
        actorId: input.actorMemberId,
        action: 'recon_cod.batch.reupload',
        objectType: 'recon_cod_batch',
        objectId: batch.cod_batch_id,
        before: { state: 'FAILED' },
        after: { state: 'UPLOADED', filename: input.filename },
      });
      return { batch, idempotent: false, reuploaded: true };
    }

    // §13.5: COD-{yyyymmdd}-{seq}, per shop per day.
    const yyyymmdd = localDateString(new Date(), timeZone).replace(/-/g, '');
    let batch: CodBatchRow | undefined;
    try {
      const inserted = await this.pool.query<CodBatchRow>(
        `INSERT INTO recon_cod_batch
           (shop_id, courier_account_id, batch_reference, filename, content_hash,
            column_map_id, remittance_reference, remittance_date, declared_total)
         SELECT $1, $2,
                'COD-' || $3 || '-' || lpad((count(*) + 1)::text, 4, '0'),
                $4, $5, $6, $7, $8::date, $9::numeric
           FROM recon_cod_batch
          WHERE shop_id = $1 AND batch_reference LIKE 'COD-' || $3 || '-%'
         RETURNING cod_batch_id, shop_id, courier_account_id, batch_reference, filename,
                   content_hash, column_map_id, remittance_reference, remittance_date::text,
                   declared_total::text, state,
                   COALESCE(matched_count, 0)::int AS matched_count,
                   COALESCE(unmatched_count, 0)::int AS unmatched_count,
                   COALESCE(unmatched_json, '[]'::jsonb) AS unmatched_json,
                   version`,
        [
          input.shopId,
          input.courierAccountId,
          yyyymmdd,
          input.filename,
          contentHash,
          columnMapId,
          input.remittanceReference ?? null,
          input.remittanceDate ?? null,
          input.declaredTotal ?? null,
        ],
      );
      batch = inserted.rows[0];
    } catch (err) {
      // Concurrent same-file upload lost the INV-14 race — return the winner.
      if ((err as { code?: string }).code === '23505') {
        const winner = await this.pool.query<CodBatchRow>(
          `SELECT cod_batch_id, shop_id, courier_account_id, batch_reference, filename,
                  content_hash, column_map_id, remittance_reference, remittance_date::text,
                  declared_total::text, state,
                  COALESCE(matched_count, 0)::int AS matched_count,
                  COALESCE(unmatched_count, 0)::int AS unmatched_count,
                  COALESCE(unmatched_json, '[]'::jsonb) AS unmatched_json, version
             FROM recon_cod_batch WHERE shop_id = $1 AND content_hash = $2`,
          [input.shopId, contentHash],
        );
        if (winner.rows[0]) return { batch: winner.rows[0], idempotent: true, reuploaded: false };
      }
      throw err;
    }
    if (!batch) throw new Error('recon_cod_batch insert returned no row');

    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'MEMBER',
      actorId: input.actorMemberId,
      action: 'recon_cod.batch.upload',
      objectType: 'recon_cod_batch',
      objectId: batch.cod_batch_id,
      after: {
        batch_reference: batch.batch_reference,
        filename: input.filename,
        courier_account_id: input.courierAccountId,
        remittance_reference: input.remittanceReference ?? null,
        remittance_date: input.remittanceDate ?? null,
        declared_total: input.declaredTotal ?? null,
      },
    });
    return { batch, idempotent: false, reuploaded: false };
  }

  /**
   * Allocate every row of an uploaded batch against its Shipment's
   * expectation (§9.17.3). Plain method — the BullMQ worker is a thin shell
   * over this, so tests drive it directly.
   *
   * Idempotency: the batch state gate (UPLOADED only) plus the per-row
   * idempotency_key `cod:{batch}:{rowIndex}:{awb}` mean a replayed job never
   * double-allocates (append-only recon_cod_allocation, A1-06).
   */
  async processBatch(input: {
    shopId: string;
    batchId: string;
    contentText: string;
  }): Promise<ProcessBatchResult> {
    const batchRes = await this.pool.query<CodBatchRow>(
      `SELECT cod_batch_id, shop_id, courier_account_id, batch_reference, filename,
              content_hash, column_map_id, remittance_reference, remittance_date::text,
              declared_total::text, state,
              COALESCE(matched_count, 0)::int AS matched_count,
              COALESCE(unmatched_count, 0)::int AS unmatched_count,
              COALESCE(unmatched_json, '[]'::jsonb) AS unmatched_json, version
         FROM recon_cod_batch WHERE shop_id = $1 AND cod_batch_id = $2`,
      [input.shopId, input.batchId],
    );
    const batch = batchRes.rows[0];
    if (!batch) throw new NotFoundException('batch not found');
    if (batch.state !== 'UPLOADED') {
      return { batchId: batch.cod_batch_id, state: 'SKIPPED', matched: 0, unmatched: 0 };
    }

    let mapping = DEFAULT_REMITTANCE_MAPPING;
    if (batch.column_map_id) {
      mapping = (await this.loadMapping(input.shopId, batch.column_map_id)).mapping;
    }

    let parsed;
    try {
      parsed = parseRemittanceCsv(input.contentText, mapping);
    } catch (err) {
      if (err instanceof RemittanceStructureError) {
        // §3.18: could not be parsed or mapped → FAILED, holds no rows, and
        // is not idempotency-blocking (a re-upload under the same hash is
        // allowed by uploadBatch).
        await this.pool.query(
          `UPDATE recon_cod_batch
              SET state = 'FAILED', version = version + 1
            WHERE cod_batch_id = $1 AND shop_id = $2`,
          [batch.cod_batch_id, input.shopId],
        );
        await this.audit.record({
          shopId: input.shopId,
          actorKind: 'SYSTEM',
          action: 'recon_cod.batch.failed',
          objectType: 'recon_cod_batch',
          objectId: batch.cod_batch_id,
          before: { state: 'UPLOADED' },
          after: { state: 'FAILED' },
          reason: err.message,
        });
        return { batchId: batch.cod_batch_id, state: 'FAILED', matched: 0, unmatched: 0 };
      }
      throw err;
    }

    await this.pool.query(
      `UPDATE recon_cod_batch SET state = 'PARSED', version = version + 1
        WHERE cod_batch_id = $1 AND shop_id = $2`,
      [batch.cod_batch_id, input.shopId],
    );

    const unmatched: UnmatchedItem[] = [...parsed.invalid];
    let matched = 0;

    for (const row of parsed.rows) {
      const exp = await this.pool.query<{ expected_id: string; state: string }>(
        // INV-6 scopes the AWB to (shop, courier account); the expectation
        // join keeps everything inside the shop (INV-1).
        `SELECT e.expected_id, e.state
           FROM shipment s
           JOIN recon_cod_expected e
             ON e.shipment_id = s.shipment_id AND e.shop_id = s.shop_id
          WHERE s.shop_id = $1 AND s.courier_account_id = $2
            AND s.awb_normalized = $3
          ORDER BY s.created_at DESC
          LIMIT 1`,
        [input.shopId, batch.courier_account_id, row.awbNormalized],
      );
      const expectation = exp.rows[0];
      if (!expectation) {
        // INV-20: surfaced on the batch, never silently dropped.
        unmatched.push({
          rowIndex: row.rowIndex,
          awb: row.awbNormalized,
          amount: paiseToRupees(row.amountPaise),
          reason: 'NO_EXPECTATION',
        });
        continue;
      }

      const inserted = await this.pool.query<{ allocation_id: string }>(
        `INSERT INTO recon_cod_allocation
           (cod_batch_id, expected_id, amount, idempotency_key)
         VALUES ($1, $2, $3::numeric, $4)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING allocation_id`,
        [
          batch.cod_batch_id,
          expectation.expected_id,
          paiseToRupees(row.amountPaise),
          `cod:${batch.cod_batch_id}:${row.rowIndex}:${row.awbNormalized}`,
        ],
      );
      if (!inserted.rows[0]) continue; // replay — already allocated

      matched += 1;
      // F-13/F-21 recompute; RTO_UNCOLLECTED stays terminal (§3.15) while the
      // allocation itself is still recorded (INV-17: stored, never regressed).
      if (expectation.state !== 'RTO_UNCOLLECTED') {
        await this.expectations.recomputeState(input.shopId, expectation.expected_id);
      }
    }

    await this.pool.query(
      `UPDATE recon_cod_batch
          SET state = 'MATCHED', matched_count = $3, unmatched_count = $4,
              unmatched_json = $5::jsonb, version = version + 1
        WHERE cod_batch_id = $1 AND shop_id = $2`,
      [
        batch.cod_batch_id,
        input.shopId,
        matched,
        unmatched.length,
        JSON.stringify(unmatched),
      ],
    );
    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'SYSTEM',
      action: 'recon_cod.batch.matched',
      objectType: 'recon_cod_batch',
      objectId: batch.cod_batch_id,
      before: { state: 'UPLOADED' },
      after: { state: 'MATCHED', matched, unmatched: unmatched.length },
    });
    return { batchId: batch.cod_batch_id, state: 'MATCHED', matched, unmatched: unmatched.length };
  }
}
