/**
 * COD reconciliation types (§2.7, §3.15, §3.18).
 *
 * Money boundary (INV-23, §9.17.3): this module records money that moved
 * between the courier and the merchant. Jsyxi is not a party — there is no
 * payout, no balance held, no settlement action anywhere in this module.
 */

export type CodExpectedState =
  | 'AWAITING'
  | 'TALLIED'
  | 'SHORT'
  | 'EXCESS'
  | 'PENDING_OVERDUE'
  | 'RTO_UNCOLLECTED';

export type CodBatchState = 'UPLOADED' | 'PARSED' | 'MATCHED' | 'RESOLVED' | 'FAILED';

export interface CodExpectedRow {
  expected_id: string;
  shop_id: string;
  shipment_id: string;
  /** numeric(19,4) arrives from pg as a string. */
  expected_amount: string;
  delivered_at: string;
  /** date — 'YYYY-MM-DD'. */
  due_at: string;
  state: CodExpectedState;
  version: number;
}

export interface CodBatchRow {
  cod_batch_id: string;
  shop_id: string;
  courier_account_id: string;
  batch_reference: string;
  filename: string;
  content_hash: string;
  column_map_id: string | null;
  remittance_reference: string | null;
  remittance_date: string | null;
  declared_total: string | null;
  state: CodBatchState;
  matched_count: number;
  unmatched_count: number;
  unmatched_json: UnmatchedItem[];
  version: number;
}

/** INV-20: an import item with no expectation is surfaced, never dropped. */
export interface UnmatchedItem {
  /** 1-based data-row index in the file (header excluded). */
  rowIndex: number;
  awb: string | null;
  /** 2dp rupee string, null when the row's amount did not parse. */
  amount: string | null;
  reason: 'NO_EXPECTATION' | 'INVALID_AMOUNT' | 'FORMULA_CONTENT' | 'MISSING_AWB';
}

/** §5.1 / §8.7 import envelope for COD remittance files. */
export const COD_IMPORT_MAX_BYTES = 50 * 1024 * 1024;
export const COD_IMPORT_MAX_ROWS = 250_000;

/** §7.5 S-29 / S-30 Shop defaults (used when recon_settings has no row). */
export const COD_SETTINGS_DEFAULTS = {
  cod_enabled: true,
  cod_tolerance: '1.00',
  cod_due_days: 7,
} as const;
