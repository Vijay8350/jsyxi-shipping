import {
  ConflictException,
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
import { buildLabelPdf, LabelRenderInput } from './label-pdf';
import { LABEL_RETENTION_DAYS, LabelMode, LabelSize } from './labels.types';

/** §3.11: these states block NEW label generation (re-download continues). */
const BLOCKED_ACCOUNT_STATES = new Set(['RESTRICTED', 'READ_ONLY', 'UNINSTALLED']);

export interface GenerateLabelInput {
  shopId: string;
  shipmentId: string;
  actorId: string;
  /** S-23 print-time size choice (Operator+); defaults to the template size. */
  sizeOverride?: LabelSize;
}

export interface GenerateLabelResult {
  documentId: string;
  /** S-26 signed URL (10 minutes). */
  downloadUrl: string;
  labelMode: LabelMode;
  isTest: boolean;
  /** True when an existing, unexpired LABEL document was returned instead of
   *  generating a new one (§3.11 re-download — allowed in RESTRICTED). */
  reused: boolean;
}

interface ShipmentRow {
  shipment_id: string;
  order_id: string;
  booking_state: string;
  awb_normalized: string | null;
  service_id: string | null;
  courier_account_id: string | null;
  is_test: boolean;
  snapshot: BookingSnapshot | null;
}

/**
 * §9.9.1 single label. COURIER_PDF_REQUIRED services store the courier's own
 * PDF bytes untouched; CUSTOM_ALLOWED services render from the frozen
 * snapshot (INV-8) through the S-23/S-24 template. The document row carries
 * sha256, bytes, a 90-day expiry (§5.4) and is_test inherited from the
 * Shipment (INV-19). Generation is audited (§12 document export); logs and
 * audit carry ids only — label PII lives in the PDF, never in logs (§5.7
 * control 4).
 */
@Injectable()
export class LabelsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly templates: LabelTemplateService,
    private readonly adapters: AdapterCallerService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    private readonly signer: DocumentUrlSigner,
    private readonly audit: AuditService,
  ) {}

  async generateShipmentLabel(input: GenerateLabelInput): Promise<GenerateLabelResult> {
    // §3.11: re-download of an existing document is allowed even in
    // RESTRICTED — this check runs BEFORE the account-state gate on purpose.
    const { rows: existing } = await this.pool.query<{ document_id: string }>(
      `SELECT document_id FROM document
        WHERE shop_id = $1 AND shipment_id = $2 AND kind = 'LABEL'
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY generated_at DESC LIMIT 1`,
      [input.shopId, input.shipmentId],
    );
    if (existing[0]) {
      return this.toResult(existing[0].document_id, input.shopId, input.shipmentId, true);
    }

    // §3.11: NEW generation is blocked while the account is RESTRICTED (or worse).
    const { rows: shopRows } = await this.pool.query<{ account_state: string }>(
      `SELECT account_state FROM shop WHERE shop_id = $1`,
      [input.shopId],
    );
    if (shopRows[0] && BLOCKED_ACCOUNT_STATES.has(shopRows[0].account_state)) {
      throw new ForbiddenException('account state blocks new label generation (§3.11)');
    }

    // INV-1: shop-scoped load — another Shop's shipment id reads as 404.
    const { rows: shipmentRows } = await this.pool.query<ShipmentRow>(
      `SELECT shipment_id, order_id, booking_state, awb_normalized, service_id,
              courier_account_id, is_test, snapshot
         FROM shipment
        WHERE shop_id = $1 AND shipment_id = $2`,
      [input.shopId, input.shipmentId],
    );
    const shipment = shipmentRows[0];
    if (!shipment) throw new NotFoundException('shipment not found');
    if (shipment.booking_state !== 'CONFIRMED') {
      throw new ConflictException(
        `label requires a CONFIRMED shipment (current: ${shipment.booking_state})`,
      );
    }
    // INV-8: labels render from the frozen snapshot, never current master data.
    if (!shipment.snapshot) {
      throw new UnprocessableEntityException('shipment has no frozen booking snapshot (INV-8)');
    }

    // service is a [global] table (§2.2); label_mode decides the path (§3.31).
    const { rows: serviceRows } = await this.pool.query<{ label_mode: LabelMode }>(
      `SELECT label_mode FROM service WHERE service_id = $1`,
      [shipment.service_id],
    );
    const labelMode = serviceRows[0]?.label_mode;
    if (!labelMode) throw new UnprocessableEntityException('shipment has no resolvable service');

    let bytes: Buffer;
    if (labelMode === 'COURIER_PDF_REQUIRED') {
      bytes = await this.fetchCourierPdf(input.shopId, shipment);
    } else {
      bytes = await this.renderCustom(input.shopId, shipment, input.sizeOverride);
    }

    const documentId = randomUUID();
    // INV-1: the object path is shop-scoped.
    const objectKey = `shops/${input.shopId}/labels/${shipment.shipment_id}/${documentId}.pdf`;
    await this.store.put(objectKey, bytes);

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // §5.4: labels are retained 90 days; is_test inherited (INV-19, §2.6).
    await this.pool.query(
      `INSERT INTO document
         (document_id, shop_id, kind, shipment_id, object_key, sha256, bytes,
          expires_at, is_test)
       VALUES ($1, $2, 'LABEL', $3, $4, $5, $6,
               now() + ($7 || ' days')::interval, $8)`,
      [
        documentId,
        input.shopId,
        shipment.shipment_id,
        objectKey,
        sha256,
        bytes.length,
        LABEL_RETENTION_DAYS,
        shipment.is_test,
      ],
    );

    // §12: document export is audited. Ids only — never label content (§5.7.4).
    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'MEMBER',
      actorId: input.actorId,
      action: 'LABEL_GENERATED',
      objectType: 'document',
      objectId: documentId,
      after: { shipmentId: shipment.shipment_id, labelMode, bytes: bytes.length },
    });

    return this.toResult(documentId, input.shopId, input.shipmentId, false);
  }

  /** §9.9.1 COURIER_PDF_REQUIRED: the courier's own PDF, stored as-is. */
  private async fetchCourierPdf(shopId: string, shipment: ShipmentRow): Promise<Buffer> {
    if (!shipment.awb_normalized || !shipment.courier_account_id) {
      throw new UnprocessableEntityException('CONFIRMED shipment is missing its AWB or account');
    }
    const result = await this.adapters.call(shopId, shipment.courier_account_id, 'getLabel', (a) =>
      a.getLabel(shipment.awb_normalized as string, 'PDF'),
    );
    return result.bytes;
  }

  /** §9.9.1 CUSTOM_ALLOWED: render from the frozen snapshot + S-23/S-24. */
  private async renderCustom(
    shopId: string,
    shipment: ShipmentRow,
    sizeOverride?: LabelSize,
  ): Promise<Buffer> {
    const template = await this.templates.getOrCreate(shopId);
    // The order number is the display id for the S-24 order barcode; it is
    // immutable on the order row (the snapshot stores the Shopify GID).
    const { rows: orderRows } = await this.pool.query<{ shopify_order_number: string | null }>(
      `SELECT shopify_order_number FROM "order" WHERE shop_id = $1 AND order_id = $2`,
      [shopId, shipment.order_id],
    );
    const renderInput: LabelRenderInput = {
      snapshot: shipment.snapshot as BookingSnapshot,
      awb: shipment.awb_normalized,
      orderNumber: orderRows[0]?.shopify_order_number ?? null,
      template: {
        brandName: template.brand_name,
        supportPhone: template.support_phone,
        messageLine: template.message_line,
        toggles: template.toggles,
      },
      isTest: shipment.is_test,
    };
    return buildLabelPdf(renderInput, sizeOverride ?? template.size);
  }

  private async toResult(
    documentId: string,
    shopId: string,
    shipmentId: string,
    reused: boolean,
  ): Promise<GenerateLabelResult> {
    const { rows } = await this.pool.query<{ is_test: boolean }>(
      `SELECT is_test FROM document WHERE shop_id = $1 AND document_id = $2`,
      [shopId, documentId],
    );
    const { rows: svc } = await this.pool.query<{ label_mode: LabelMode }>(
      `SELECT s.label_mode FROM shipment sh JOIN service s ON s.service_id = sh.service_id
        WHERE sh.shop_id = $1 AND sh.shipment_id = $2`,
      [shopId, shipmentId],
    );
    return {
      documentId,
      downloadUrl: this.signer.signDocumentUrl(documentId),
      labelMode: svc[0]?.label_mode ?? 'CUSTOM_ALLOWED',
      isTest: rows[0]?.is_test ?? false,
      reused,
    };
  }
}
