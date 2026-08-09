import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { LocalFilesystemObjectStore, OBJECT_STORE } from '../booking-ops/object-store';
import { neutralizeFormula } from './recon-csv';
import {
  EXPORT_SIGNED_URL_TTL_SECONDS,
  OPEN_DISPUTE_STATES,
} from './recon-freight.types';

/**
 * §9.17.2 dispute export: a CSV of the open disputes (the §3.14 counting
 * rule — OPEN / DISPUTE_PREPARED / SUBMITTED) with the §9.17.2 reference
 * fields, the four flags, expected/audited amounts and the ADD-42 evidence
 * reference, for the merchant to send to the courier.
 *
 * The file is stored via the ObjectStore seam under the Shop's prefix
 * (INV-1) and downloaded through a signed URL with the S-26 10-minute
 * lifetime; the signature is HMAC-SHA256 over `key:{key}:{expires}`, the
 * same payload the LocalFilesystemObjectStore signs, verified here at
 * download. The export is audited (§12) and formula-neutralized (§8.7).
 * Exports are immutable snapshots (§5.2 freshness rule) — later workflow
 * changes never rewrite a stored file.
 */

const EXPORT_COLUMNS = [
  'batch_reference',
  'awb',
  'charge_type',
  'invoiced_amount',
  'invoiced_weight_kg',
  'expected_amount',
  'audited_amount',
  'flag_awb_not_found',
  'flag_weight_mismatch',
  'flag_amount_mismatch',
  'flag_review',
  'workflow_state',
  'shipper_company',
  'invoice_reference',
  'invoice_date',
  'shipment_date',
  'origin_station',
  'destination_station',
  'filename',
  'uploaded_at',
  'remark',
  'dispute_evidence_object_key', // ADD-42
] as const;

interface ExportRow {
  batch_reference: string;
  awb_normalized: string;
  charge_type: string;
  invoiced_amount: string | null;
  invoiced_weight_kg: string | null;
  expected_amount: string | null;
  audited_amount: string | null;
  flag_awb_not_found: boolean;
  flag_weight_mismatch: boolean;
  flag_amount_mismatch: boolean;
  flag_review: boolean;
  workflow_state: string;
  shipper_company: string | null;
  invoice_reference: string | null;
  invoice_date: string | null;
  shipment_date: string | null;
  origin_station: string | null;
  destination_station: string | null;
  filename: string | null;
  uploaded_at: string;
  remark: string | null;
  dispute_evidence_object_key: string | null;
}

function csvCell(value: string | boolean | null): string {
  const text = value === null ? '' : String(value);
  const neutral = neutralizeFormula(text); // §8.7
  return /[",\n\r]/.test(neutral) ? `"${neutral.replace(/"/g, '""')}"` : neutral;
}

/** S-26 HMAC signer shared by the OBJECT_STORE factory and download verification. */
@Injectable()
export class ReconExportSigner {
  private readonly secret: string;

  constructor(config: ConfigService) {
    // Same secret as the booking-ops document signer (S-26 pattern).
    this.secret =
      config.get<string>('DOCUMENT_SIGNING_SECRET') ?? 'dev-only-document-signing-secret';
  }

  hmac(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('hex');
  }
}

@Injectable()
export class ReconExportService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(OBJECT_STORE) private readonly store: LocalFilesystemObjectStore,
    private readonly audit: AuditService,
    private readonly signer: ReconExportSigner,
  ) {}

  hmac(payload: string): string {
    return this.signer.hmac(payload);
  }

  /** Finance+ (controller: 'recon.edit'). Returns the S-26 signed URL. */
  async exportDisputes(input: {
    shopId: string;
    batchId?: string;
    actorMemberId: string;
  }): Promise<{ objectKey: string; downloadUrl: string; rowCount: number }> {
    const params: unknown[] = [input.shopId, OPEN_DISPUTE_STATES];
    let batchFilter = '';
    if (input.batchId) {
      params.push(input.batchId);
      batchFilter = 'AND b.batch_id = $3';
    }
    const { rows } = await this.pool.query<ExportRow>(
      `SELECT b.batch_reference, r.awb_normalized, r.charge_type::text,
              r.invoiced_amount, r.invoiced_weight_kg, r.expected_amount,
              r.audited_amount, r.flag_awb_not_found, r.flag_weight_mismatch,
              r.flag_amount_mismatch, r.flag_review, r.workflow_state::text,
              r.shipper_company, r.invoice_reference, r.invoice_date::text,
              r.shipment_date::text, r.origin_station, r.destination_station,
              r.filename, r.uploaded_at, r.remark, r.dispute_evidence_object_key
         FROM recon_freight_row r
         JOIN recon_freight_batch b ON b.batch_id = r.batch_id
        WHERE b.shop_id = $1
          AND r.workflow_state = ANY ($2::recon_workflow_state[])  -- §3.14
          ${batchFilter}
        ORDER BY b.batch_reference, r.awb_normalized, r.charge_type`,
      params,
    );

    const lines = [EXPORT_COLUMNS.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.batch_reference,
          r.awb_normalized,
          r.charge_type,
          r.invoiced_amount,
          r.invoiced_weight_kg,
          r.expected_amount,
          r.audited_amount,
          r.flag_awb_not_found,
          r.flag_weight_mismatch,
          r.flag_amount_mismatch,
          r.flag_review,
          r.workflow_state,
          r.shipper_company,
          r.invoice_reference,
          r.invoice_date,
          r.shipment_date,
          r.origin_station,
          r.destination_station,
          r.filename,
          r.uploaded_at,
          r.remark,
          r.dispute_evidence_object_key,
        ]
          .map(csvCell)
          .join(','),
      );
    }

    const objectKey = `shops/${input.shopId}/recon/disputes/${randomUUID()}.csv`;
    await this.store.put(objectKey, Buffer.from(lines.join('\n') + '\n', 'utf8'));
    const downloadUrl = await this.store.getSignedUrl(
      objectKey,
      EXPORT_SIGNED_URL_TTL_SECONDS, // S-26
    );

    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'MEMBER',
      actorId: input.actorMemberId,
      action: 'recon.dispute_exported', // §12
      objectType: 'recon_freight_batch',
      objectId: input.batchId ?? null,
      after: { objectKey, rowCount: rows.length },
    });
    return { objectKey, downloadUrl, rowCount: rows.length };
  }

  /**
   * Signed-download verification (S-26): signature over `key:{key}:{expires}`,
   * unexpired, and the key confined to the caller's Shop prefix (INV-1).
   */
  async readExport(input: {
    shopId: string;
    key: string;
    expires: number;
    signature: string;
  }): Promise<Buffer | null> {
    if (!input.key.startsWith(`shops/${input.shopId}/recon/disputes/`)) return null;
    if (input.expires * 1000 <= Date.now()) return null;
    const expected = Buffer.from(
      this.hmac(`key:${input.key}:${input.expires}`),
      'utf8',
    );
    const given = Buffer.from(input.signature, 'utf8');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return null;
    }
    return this.store.get(input.key);
  }
}
