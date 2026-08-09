/**
 * COD remittance CSV parsing (§9.17.1, §8.7). Pure functions, no Nest deps.
 *
 * The file must carry a header row; columns are resolved through the COD
 * import_column_map template (§2.7, A2-05) — mappings_json of the shape
 * `{ "awb": "<header>", "amount": "<header>" }` — with 'awb' / 'amount' as
 * the defaults when no map is supplied.
 *
 * §8.7: formula-leading cells (= + - @) are never executed and never stored;
 * the row is surfaced with reason FORMULA_CONTENT (INV-20), matching the
 * rate-engine's rejection posture. Amounts are INR, ≥ 0, ≤ 2dp (§4.1).
 * AWBs are compared F-19-normalized.
 */

import { parseCsvText, CsvParseError } from '../rate-engine/rate-card-csv';
import { paiseToRupees, rupeesToPaise } from '../../common/money';
import { COD_IMPORT_MAX_ROWS, type UnmatchedItem } from './recon-cod.types';

export interface RemittanceColumnMapping {
  awb: string;
  amount: string;
}

export const DEFAULT_REMITTANCE_MAPPING: RemittanceColumnMapping = {
  awb: 'awb',
  amount: 'amount',
};

/** The file could not be parsed or mapped → batch FAILED (§3.18). */
export class RemittanceStructureError extends Error {}

export interface ParsedRemittanceRow {
  /** 1-based data-row index, header excluded — stable across replays. */
  rowIndex: number;
  awbRaw: string;
  /** F-19: trim → strip whitespace and hyphens → upper-case. */
  awbNormalized: string;
  amountPaise: bigint;
}

export interface RemittanceParseResult {
  rows: ParsedRemittanceRow[];
  /** Row-level problems, surfaced on the batch (INV-20) — never dropped. */
  invalid: UnmatchedItem[];
  totalDataRows: number;
}

/** F-19 AWB normalization (A1-10). */
export function normalizeAwb(raw: string): string {
  return raw.trim().replace(/[\s-]+/g, '').toUpperCase();
}

/** §8.7: formula-leading characters are neutralized, never executed. */
export function isFormulaContent(cell: string): boolean {
  return ['=', '+', '-', '@'].includes(cell.charAt(0));
}

const normalizeHeader = (h: string): string => h.trim().toLowerCase();

/** Extract the COD mapping from import_column_map.mappings_json. */
export function mappingFromColumnMap(mappingsJson: unknown): RemittanceColumnMapping {
  if (mappingsJson && typeof mappingsJson === 'object') {
    const m = mappingsJson as Record<string, unknown>;
    if (typeof m.awb === 'string' && typeof m.amount === 'string' && m.awb && m.amount) {
      return { awb: m.awb, amount: m.amount };
    }
  }
  throw new RemittanceStructureError(
    'column map must name the "awb" and "amount" columns (§9.17.1)',
  );
}

/** "1,234.56" / "₹1234.5" → paise; null when not a valid INR amount. */
function parseAmountPaise(cell: string): bigint | null {
  const cleaned = cell.replace(/[₹,\s]/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
  try {
    return rupeesToPaise(cleaned);
  } catch {
    return null;
  }
}

export function parseRemittanceCsv(
  text: string,
  mapping: RemittanceColumnMapping = DEFAULT_REMITTANCE_MAPPING,
): RemittanceParseResult {
  let grid: string[][];
  try {
    grid = parseCsvText(text);
  } catch (err) {
    if (err instanceof CsvParseError) {
      throw new RemittanceStructureError(`CSV parse failed: ${err.message}`);
    }
    throw err;
  }
  // Drop fully-empty rows (trailing newline artifacts).
  const nonEmpty = grid.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) {
    throw new RemittanceStructureError('empty file');
  }

  const header = nonEmpty[0].map(normalizeHeader);
  const awbCol = header.indexOf(normalizeHeader(mapping.awb));
  const amountCol = header.indexOf(normalizeHeader(mapping.amount));
  if (awbCol === -1 || amountCol === -1) {
    throw new RemittanceStructureError(
      `missing mapped column(s) — expected "${mapping.awb}" and "${mapping.amount}" headers (§9.17.1)`,
    );
  }

  const dataRows = nonEmpty.slice(1);
  if (dataRows.length > COD_IMPORT_MAX_ROWS) {
    throw new RemittanceStructureError(
      `row limit exceeded: ${dataRows.length} > ${COD_IMPORT_MAX_ROWS} (§5.1)`,
    );
  }

  const rows: ParsedRemittanceRow[] = [];
  const invalid: UnmatchedItem[] = [];
  dataRows.forEach((cells, i) => {
    const rowIndex = i + 1;
    const awbCell = (cells[awbCol] ?? '').trim();
    const amountCell = (cells[amountCol] ?? '').trim();

    if (isFormulaContent(awbCell) || isFormulaContent(amountCell)) {
      invalid.push({ rowIndex, awb: null, amount: null, reason: 'FORMULA_CONTENT' });
      return;
    }
    if (!awbCell) {
      invalid.push({ rowIndex, awb: null, amount: null, reason: 'MISSING_AWB' });
      return;
    }
    const amountPaise = parseAmountPaise(amountCell);
    if (amountPaise === null) {
      invalid.push({ rowIndex, awb: awbCell, amount: null, reason: 'INVALID_AMOUNT' });
      return;
    }
    rows.push({
      rowIndex,
      awbRaw: awbCell,
      awbNormalized: normalizeAwb(awbCell),
      amountPaise,
    });
  });

  return { rows, invalid, totalDataRows: dataRows.length };
}

/** 2dp rupee string for API surfaces and audit entries. */
export function formatPaise(paise: bigint): string {
  return paiseToRupees(paise);
}
