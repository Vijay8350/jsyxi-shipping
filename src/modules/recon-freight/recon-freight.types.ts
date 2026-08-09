import type { Paise } from '../../common/money';
import type { BookingSnapshot, ExpectedCostBasis } from '../booking/booking.types';

/**
 * Freight reconciliation types (§2.7, §3.13/§3.14/§3.18/§3.28, §4.8).
 * PG enum mirrors kept as string unions, matching the booking/ndr convention.
 */

/** §3.13 CHARGE_TYPE. */
export type ChargeType =
  | 'FORWARD'
  | 'RTO'
  | 'REATTEMPT'
  | 'COD_FEE'
  | 'ADJUSTMENT'
  | 'OTHER';

export const CHARGE_TYPES: readonly ChargeType[] = [
  'FORWARD',
  'RTO',
  'REATTEMPT',
  'COD_FEE',
  'ADJUSTMENT',
  'OTHER',
];

/** §3.14 RECON_WORKFLOW_STATE. */
export type ReconWorkflowState =
  | 'OPEN'
  | 'ACCEPTED'
  | 'DISPUTE_PREPARED'
  | 'SUBMITTED'
  | 'RESOLVED'
  | 'IGNORED';

/** §3.14: only these three count as open disputes (dashboard + reports). */
export const OPEN_DISPUTE_STATES: readonly ReconWorkflowState[] = [
  'OPEN',
  'DISPUTE_PREPARED',
  'SUBMITTED',
];

/** §3.14 terminal values — a batch resolves only when every row is terminal. */
export const TERMINAL_WORKFLOW_STATES: readonly ReconWorkflowState[] = [
  'ACCEPTED',
  'RESOLVED',
  'IGNORED',
];

/** §3.18 RECON_BATCH_STATE. */
export type ReconBatchState =
  | 'UPLOADED'
  | 'PARSED'
  | 'MATCHED'
  | 'RESOLVED'
  | 'FAILED';

/** §3.28 CONTROL_TOTAL_STATE. */
export type ControlTotalState =
  | 'WITHIN_THRESHOLD'
  | 'MISMATCH'
  | 'ACCEPTED_WITH_REMARK';

/** §8.7: every recon import declares the tax meaning of its amounts. */
export type TaxTreatment = 'TAX_INCLUSIVE' | 'TAX_EXCLUSIVE';

/* ---------------------------------------------------------------------------
 * §5.1 import limits and §7.3 control-total thresholds
 * ------------------------------------------------------------------------- */

/** §5.1: freight/COD import ≤ 50 MB and ≤ 250,000 rows. */
export const FREIGHT_IMPORT_MAX_BYTES = 50 * 1024 * 1024;
export const FREIGHT_IMPORT_MAX_ROWS = 250_000;

/**
 * S-19 / S-20 (§7.3): freight control-total absolute floor ₹100.00 and
 * percentage 0.5%. Both are admin settings; v1 ships no admin surface for
 * them, so the §7.3 defaults are the built values (F-14, §4.8).
 */
export const CONTROL_TOTAL_FLOOR_PAISE: Paise = 10_000n; // ₹100.00
/** 0.5% as a exact rational: residual threshold = declared × 5 / 1000. */
export const CONTROL_TOTAL_PCT_NUMERATOR = 5n;
export const CONTROL_TOTAL_PCT_DENOMINATOR = 1000n;

/** S-26 (§7.4): signed-URL lifetime for the dispute export download. */
export const EXPORT_SIGNED_URL_TTL_SECONDS = 600;

/** §5.7 queue list: the reconciliation processing queue. */
export const RECON_PROCESSING_QUEUE = 'recon-processing';
export const RECON_PROCESS_BATCH_JOB = 'recon.process_freight_batch';

/* ---------------------------------------------------------------------------
 * §9.17.1 column mapping (import_column_map, kind = FREIGHT; A2-05)
 * ------------------------------------------------------------------------- */

/** Canonical fields a FREIGHT import_column_map can map (§9.17.2 row fields). */
export type FreightField =
  | 'awb'
  | 'amount'
  | 'weight'
  | 'shipper_company'
  | 'invoice_reference'
  | 'invoice_date'
  | 'shipment_date'
  | 'origin_station'
  | 'destination_station'
  | 'remark';

export const FREIGHT_FIELDS: readonly FreightField[] = [
  'awb',
  'amount',
  'weight',
  'shipper_company',
  'invoice_reference',
  'invoice_date',
  'shipment_date',
  'origin_station',
  'destination_station',
  'remark',
];

/**
 * Shape of import_column_map for kind FREIGHT: `mappings_json` maps canonical
 * field → CSV header; `charge_type_column` names the courier's charge-type
 * column (absent ⇒ every row defaults to FORWARD, §3.13) and
 * `charge_type_value_map` maps the courier's own values onto CHARGE_TYPE
 * (case-insensitive; an unmapped value is never dropped — INV-20, §4.8).
 */
export interface FreightColumnMap {
  columnMapId: string;
  courierId: string;
  name: string;
  mappings: Partial<Record<FreightField, string>>;
  chargeTypeColumn: string | null;
  chargeTypeValueMap: Record<string, ChargeType> | null;
}

/* ---------------------------------------------------------------------------
 * Parse output (pre-match)
 * ------------------------------------------------------------------------- */

/** One parsed CSV line, before §4.8 matching. Amounts 2dp text, weights 3dp. */
export interface ParsedInvoiceRow {
  /** 1-based data-line number (header is line 0) — for failure surfacing. */
  lineNumber: number;
  awbRaw: string;
  /** F-19 normalized; '' when the courier row carried no AWB at all. */
  awbNormalized: string;
  chargeType: ChargeType;
  /** True when the courier's charge-type value had no map entry (INV-20). */
  chargeTypeUnmapped: boolean;
  /** 2dp text; null when the cell was blank or unparseable (flag_review). */
  invoicedAmount: string | null;
  /** 3dp text; null when absent/unparseable. */
  invoicedWeightKg: string | null;
  shipperCompany: string | null;
  invoiceReference: string | null;
  /** ISO dates (§5.2 date fields); null when absent/unparseable. */
  invoiceDate: string | null;
  shipmentDate: string | null;
  originStation: string | null;
  destinationStation: string | null;
  remark: string | null;
}

/* ---------------------------------------------------------------------------
 * §4.8 matching — inputs and outputs
 * ------------------------------------------------------------------------- */

/**
 * The shipment a row's AWB resolved to, plus everything §4.8 needs from it.
 * `providerConfirmedCharge` is the §3.25 PROVIDER_CONFIRMED_CHARGE
 * expectation. NOTE (foundation gap): the booking worker decides the basis
 * from the provider's confirmed charge but does not persist the amount; the
 * loader therefore selects a constant NULL until a
 * `shipment.provider_confirmed_charge` column lands (shared change — see the
 * module summary). A null charge with that basis falls into flag_review
 * (INV-20), never a silent skip.
 */
export interface ShipmentReconView {
  shipmentId: string;
  awbNormalized: string;
  expectedCostBasis: ExpectedCostBasis | null;
  providerConfirmedCharge: string | null;
  snapshot: BookingSnapshot | null;
}

/** One (AWB, charge_type) comparison group — §4.8 flags are per GROUP. */
export interface MatchGroupInput {
  awbNormalized: string;
  chargeType: ChargeType;
  chargeTypeUnmapped: boolean;
  /** Σ invoiced_amount over the group's rows (§4.8 same-type summing). */
  invoicedAmountTotal: Paise | null;
  /** Σ ADJUSTMENT amounts linked to this group inside the same batch (RW-24). */
  adjustmentTotal: Paise;
  shipment: ShipmentReconView | null;
  /** Effective tolerances (§4.8: courier account override, else Shop). */
  freightTolerance: Paise;
  weightToleranceGrams: bigint;
}

/** Per-group §4.8 result; expected/audited are 2dp text or null. */
export interface MatchGroupResult {
  flagAwbNotFound: boolean;
  flagAmountMismatch: boolean;
  flagReview: boolean;
  /** Null exactly when there is no expectation (§4.8 table). */
  expectedAmount: string | null;
  /** F-23 when computed for a FORWARD group (else null). */
  auditedAmount: string | null;
}

/** §4.8 flag_weight_mismatch is evaluated per ROW (weights never sum). */
export function weightMismatch(
  invoicedWeightKg: string | null,
  snapshotBillableKg: string | null | undefined,
  toleranceGrams: bigint,
): boolean {
  if (invoicedWeightKg === null || snapshotBillableKg == null) return false;
  const invoiced = kgGrams(invoicedWeightKg);
  const booked = kgGrams(snapshotBillableKg);
  const diff = invoiced > booked ? invoiced - booked : booked - invoiced;
  return diff > toleranceGrams;
}

/** Local 3dp-kg → grams (mirrors order-derivation/weight kgToGrams). */
function kgGrams(value: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!m) throw new Error(`invalid weight value: ${value}`);
  return BigInt(m[1]) * 1000n + BigInt(((m[2] ?? '') + '000').slice(0, 3));
}

/* ---------------------------------------------------------------------------
 * §9.17.2 workflow actions
 * ------------------------------------------------------------------------- */

export type ReconRowAction =
  | 'accept'
  | 'dispute'
  | 'submit'
  | 'resolve'
  | 'ignore';

/** §3.14 transition table as data — a transition not listed does not exist. */
export const ROW_TRANSITIONS: Record<
  ReconRowAction,
  { from: readonly ReconWorkflowState[]; to: ReconWorkflowState; remarkRequired: boolean }
> = {
  accept: { from: ['OPEN'], to: 'ACCEPTED', remarkRequired: false },
  dispute: {
    from: ['OPEN', 'DISPUTE_PREPARED'],
    to: 'DISPUTE_PREPARED',
    remarkRequired: true, // "add a dispute remark" (§9.17.2)
  },
  submit: { from: ['DISPUTE_PREPARED'], to: 'SUBMITTED', remarkRequired: false },
  resolve: {
    from: ['DISPUTE_PREPARED', 'SUBMITTED'],
    to: 'RESOLVED',
    remarkRequired: false,
  },
  ignore: { from: ['OPEN'], to: 'IGNORED', remarkRequired: false },
};

export type RowActionResult =
  | { ok: true; rowId: string; workflowState: ReconWorkflowState; batchResolved: boolean }
  | {
      ok: false;
      code: 'ROW_NOT_FOUND' | 'INVALID_TRANSITION' | 'VERSION_CONFLICT' | 'REMARK_REQUIRED';
      currentState?: ReconWorkflowState;
      currentVersion?: number;
    };

export type ResidualAcceptanceResult =
  | { ok: true; batchId: string; controlTotalState: ControlTotalState; batchResolved: boolean }
  | {
      ok: false;
      code:
        | 'BATCH_NOT_FOUND'
        | 'INVALID_STATE'
        | 'VERSION_CONFLICT'
        | 'REMARK_REQUIRED';
      currentControlTotalState?: ControlTotalState;
      currentVersion?: number;
    };

export type UploadBatchResult =
  | { ok: true; batchId: string; batchReference: string; reused: boolean; reprocessing: boolean }
  | {
      ok: false;
      code:
        | 'FILE_TOO_LARGE'
        | 'TOO_MANY_ROWS'
        | 'ARCHIVE_OR_BINARY'
        | 'INVALID_METADATA'
        | 'FUTURE_INVOICE_DATE'
        | 'UNKNOWN_COURIER_ACCOUNT'
        | 'UNKNOWN_COLUMN_MAP'
        | 'COLUMN_MAP_KIND'
        | 'EMPTY_FILE';
      detail?: string;
    };
