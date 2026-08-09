import { createHash } from 'crypto';
import { Paise, divRoundHalfUp, paiseToRupees } from '../../common/money';
import { normalizeAwb } from '../booking/snapshot';
import {
  ChargeType,
  FreightColumnMap,
  ParsedInvoiceRow,
} from './recon-freight.types';

/**
 * §8.7 file-import helpers for the freight recon pipeline — pure functions.
 *
 * - RFC 4180-lite CSV parsing (quoted cells, escaped quotes, CRLF).
 * - Formula neutralization for text cells (§8.7: "CSV/XLSX formula content
 *   is neutralized in previews and exports") — a leading = + - @ is disarmed
 *   with a quote prefix. Amount cells are NOT neutralized: a leading minus is
 *   a signed adjustment amount (§4.1), not a formula.
 * - Money/weight/date parsing to the §4.1 storage forms (2dp / 3dp text).
 */

/** §8.7: disarm spreadsheet-formula cells. */
export function neutralizeFormula(cell: string): string {
  return /^[=+\-@]/.test(cell) ? `'${cell}` : cell;
}

/** sha256 content hash — the INV-14 idempotency key. */
export function contentHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** §8.7: archives and active/binary content are rejected. */
export function looksLikeArchiveOrBinary(bytes: Buffer): boolean {
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return true; // PK zip
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x7f454c46) return true; // ELF
  const probe = bytes.subarray(0, Math.min(bytes.length, 8192));
  return probe.includes(0x00); // NUL byte ⇒ not a text CSV
}

/** Parse CSV text into rows of raw cells (quotes and CRLF handled). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') {
      inQuotes = true; // a quote opens a quoted field only at field start
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  if (inQuotes) throw new Error('unterminated quoted cell');
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // Drop trailing fully-blank lines.
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === '')) {
    rows.pop();
  }
  return rows;
}

/**
 * Parse an invoice amount cell → paise. Accepts "1,234.56", "₹1234.50",
 * "-50.00" (signed only meaningful for ADJUSTMENT rows, §4.1); up to 4dp is
 * rounded half-up to paise (INV-15). Blank/garbage → null (§4.8 flag_review,
 * INV-20 — never dropped).
 */
export function parseInvoiceAmount(raw: string | undefined): Paise | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/[₹,\s]/g, '');
  const m = /^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(cleaned);
  if (!m) return null;
  const [, sign, whole, frac = ''] = m;
  const tenThousandths =
    BigInt(whole) * 10_000n + BigInt((frac + '0000').slice(0, 4));
  const paise = divRoundHalfUp(tenThousandths, 100n);
  return sign === '-' ? -paise : paise;
}

/** Parse a weight cell → 3dp kg text (§4.1); blank/garbage → null. */
export function parseWeightKg(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/[,\s]/g, '').replace(/kg$/i, '');
  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(cleaned);
  if (!m) return null;
  const [, whole, frac = ''] = m;
  const tenThousandths =
    BigInt(whole) * 10_000n + BigInt((frac + '0000').slice(0, 4));
  const grams = divRoundHalfUp(tenThousandths * 1000n, 10_000n);
  return `${grams / 1000n}.${(grams % 1000n).toString().padStart(3, '0')}`;
}

/**
 * Parse a date cell → ISO YYYY-MM-DD. Accepts ISO plus the Indian
 * DD-MM-YYYY / DD/MM/YYYY forms (§5.2: these are dates, not datetimes).
 */
export function parseInvoiceDate(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t === '') return null;
  let y: number;
  let mo: number;
  let d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) {
    y = Number(iso[1]);
    mo = Number(iso[2]);
    d = Number(iso[3]);
  } else {
    const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(t);
    if (!dmy) return null;
    d = Number(dmy[1]);
    mo = Number(dmy[2]);
    y = Number(dmy[3]);
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${y.toString().padStart(4, '0')}-${mo.toString().padStart(2, '0')}-${d
    .toString()
    .padStart(2, '0')}`;
}

function textCell(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  return t === '' ? null : neutralizeFormula(t); // §8.7
}

export class RowParseFailure extends Error {
  constructor(
    message: string,
    readonly lineNumber: number,
  ) {
    super(message);
  }
}

/**
 * Map parsed CSV rows to canonical invoice rows using the column map
 * (§9.17.1, A2-05). The header row must contain the mapped `awb` and
 * `amount` columns — a file they cannot be read from "could not be parsed
 * or mapped" (§3.18 FAILED) and throws RowParseFailure with line 0.
 *
 * §3.13: no charge-type column ⇒ every row is FORWARD. A value with no entry
 * in charge_type_value_map is stored as OTHER with chargeTypeUnmapped (the
 * §4.8 OTHER row gives it flag_review — surfaced, never dropped, INV-20).
 */
export function mapInvoiceRows(
  grid: string[][],
  map: FreightColumnMap,
): ParsedInvoiceRow[] {
  if (grid.length === 0) throw new RowParseFailure('empty file', 0);
  const header = grid[0].map((h) => h.trim());
  const col = (headerName: string | undefined): number =>
    headerName === undefined ? -1 : header.findIndex((h) => h === headerName);

  const awbCol = col(map.mappings.awb);
  const amountCol = col(map.mappings.amount);
  if (awbCol === -1 || amountCol === -1) {
    throw new RowParseFailure('required awb/amount columns not found in header', 0);
  }
  const weightCol = col(map.mappings.weight);
  const cols: Record<string, number> = {
    shipper_company: col(map.mappings.shipper_company),
    invoice_reference: col(map.mappings.invoice_reference),
    invoice_date: col(map.mappings.invoice_date),
    shipment_date: col(map.mappings.shipment_date),
    origin_station: col(map.mappings.origin_station),
    destination_station: col(map.mappings.destination_station),
    remark: col(map.mappings.remark),
  };
  const chargeCol = map.chargeTypeColumn ? col(map.chargeTypeColumn) : -1;
  const valueMap = new Map<string, ChargeType>();
  for (const [k, v] of Object.entries(map.chargeTypeValueMap ?? {})) {
    valueMap.set(k.trim().toLowerCase(), v);
  }

  const cell = (row: string[], idx: number): string | undefined =>
    idx === -1 ? undefined : row[idx];

  const out: ParsedInvoiceRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (row.every((c) => c.trim() === '')) continue; // blank spacer line
    const awbRaw = (cell(row, awbCol) ?? '').trim();
    const chargeRaw = (cell(row, chargeCol) ?? '').trim();
    let chargeType: ChargeType = 'FORWARD'; // §3.13 default
    let chargeTypeUnmapped = false;
    if (chargeRaw !== '') {
      const mapped = valueMap.get(chargeRaw.toLowerCase());
      if (mapped) {
        chargeType = mapped;
      } else {
        chargeType = 'OTHER'; // INV-20: surfaced via flag_review, never dropped
        chargeTypeUnmapped = true;
      }
    }
    const amountPaise = parseInvoiceAmount(cell(row, amountCol));
    out.push({
      lineNumber: r,
      awbRaw,
      awbNormalized: awbRaw === '' ? '' : normalizeAwb(awbRaw), // F-19
      chargeType,
      chargeTypeUnmapped,
      invoicedAmount: amountPaise === null ? null : paiseToRupees(amountPaise),
      invoicedWeightKg: parseWeightKg(cell(row, weightCol)),
      shipperCompany: textCell(cell(row, cols.shipper_company)),
      invoiceReference: textCell(cell(row, cols.invoice_reference)),
      invoiceDate: parseInvoiceDate(cell(row, cols.invoice_date)),
      shipmentDate: parseInvoiceDate(cell(row, cols.shipment_date)),
      originStation: textCell(cell(row, cols.origin_station)),
      destinationStation: textCell(cell(row, cols.destination_station)),
      remark: textCell(cell(row, cols.remark)),
    });
  }
  return out;
}
