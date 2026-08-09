import type { JobState } from '../booking-ops/booking-ops.types';

/**
 * Labels module types (§9.9.1, §2.6). PG enum mirrors kept as string unions,
 * matching the booking / booking-ops convention.
 */

/** §3.31 service.label_mode — per-Service label source (§9.9.1). */
export type LabelMode = 'COURIER_PDF_REQUIRED' | 'CUSTOM_ALLOWED';

/** S-23 (§7.4) label sizes — mirrors the label_template.size CHECK (migration 0012). */
export type LabelSize = 'THERMAL_4X6' | 'A4_1UP' | 'A4_2UP' | 'A4_4UP';

export const LABEL_SIZES: readonly LabelSize[] = ['THERMAL_4X6', 'A4_1UP', 'A4_2UP', 'A4_4UP'];

/**
 * S-24 (§7.4) content toggles with their spec defaults (migration 0012 carries
 * the same defaults at the database level). The COD collectible is ALWAYS
 * emphasized and is deliberately NOT a toggle here.
 */
export interface LabelToggles {
  productList: boolean;
  sku: boolean;
  orderBarcode: boolean;
  gstNumber: boolean;
  weightDims: boolean;
  routingCode: boolean;
  prices: boolean;
  hideAmountsOnPrepaid: boolean;
}

/** S-24 defaults: product list on, SKU on, order barcode on, GST number on,
 *  weight/dims on, routing code on, prices off, hide amounts on prepaid on. */
export const DEFAULT_LABEL_TOGGLES: LabelToggles = {
  productList: true,
  sku: true,
  orderBarcode: true,
  gstNumber: true,
  weightDims: true,
  routingCode: true,
  prices: false,
  hideAmountsOnPrepaid: true,
};

/** §2.6 label_template row (one per Shop at v1, §9.12). */
export interface LabelTemplateRow {
  template_id: string;
  shop_id: string;
  logo_object_key: string | null;
  brand_name: string | null;
  support_phone: string | null;
  message_line: string | null;
  toggles: LabelToggles;
  size: LabelSize;
  version: number;
  created_at: string;
  updated_at: string;
}

/** §5.1: bulk label PDF ≤1,000 Shipments per job. */
export const BULK_LABEL_MAX_SHIPMENTS = 1000;

/** §5.4 retention: labels live 90 days. */
export const LABEL_RETENTION_DAYS = 90;

/** §5.7 queue list: the `label` queue. */
export const LABEL_QUEUE = 'label';

/** §5.7 `label` queue job payload. jobId = document_job.job_id (exactly-once). */
export interface LabelJobData {
  shopId: string;
  jobId: string;
}

export type { JobState };

/**
 * §9.9.1 skipped-report reasons. Nothing is dropped quietly (INV-20): every
 * requested shipment that does not make it into the merged PDF is listed here
 * and the job ends PARTIAL (§3.27).
 */
export type LabelSkipReason =
  | 'SHIPMENT_NOT_FOUND' // requested id is not a shipment of this Shop (INV-1)
  | 'NOT_CONFIRMED' // no active AWB yet — nothing to label
  | 'MISSING_SNAPSHOT' // INV-8: labels render from the frozen snapshot only
  | 'COURIER_PDF_FETCH_FAILED' // getLabel(awb, 'PDF') raised
  | 'COURIER_PDF_NOT_MERGEABLE'; // fetched, but a foreign PDF cannot be merged
                                 // into the hand-rolled writer — use the
                                 // single-label download for these (§9.9.1)

export interface LabelSkipped {
  shipmentId: string;
  reason: LabelSkipReason;
  detail?: string;
}

/** document_job.progress shape for bulk label jobs. */
export interface LabelJobProgress {
  total: number;
  processed: number;
  rendered: number;
  skipped: number;
}

/** §9.9.1 bulk job kinds: a fresh bulk run or an ADD-36 reprint (same shape). */
export type BulkLabelKind = 'BULK' | 'REPRINT';
