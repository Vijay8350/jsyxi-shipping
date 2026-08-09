/**
 * Rate-card / zone CSV upload (§9.15) — parsing and validation preview.
 * Pure functions, no Nest deps.
 *
 * Template (§9.15 per-Service rate-card CSV). One optional header row, then
 * data rows whose FIRST column is the record kind:
 *
 *   SLAB,zone,base_weight_kg,base_rate,additional_step_kg,additional_rate
 *   COMPONENT,code,label,basis,value,is_taxable
 *
 * - zone: A–E · base_weight_kg / additional_step_kg: positive kg, ≤3dp ·
 *   base_rate / additional_rate: INR, ≥0, ≤2dp (paise-safe, §4.1)
 * - basis: FLAT | PERCENT_OF_BASE_FREIGHT | PERCENT_OF_PRE_TAX_SUBTOTAL |
 *   PER_KG_BILLABLE | PERCENT_OF_DECLARED_VALUE (ADD-41); value: money 2dp for
 *   FLAT / PER_KG_BILLABLE, rate 0–1 ≤6dp for the percent bases; is_taxable:
 *   true | false
 * - COMPONENT position is the row's order among COMPONENT rows.
 *
 * §5.1 / §8.7 limits: ≤25 MB, ≤100,000 rows. Formula content is rejected, not
 * executed: any cell whose first character is = + - @ fails validation
 * (§8.7 neutralization — previews never carry live formulas).
 *
 * node:util parseCSV is NOT available on the project's Node (v26 — verified),
 * so this is the minimal strict parser the spec fallback allows: RFC-4180
 * quoting ("" escapes "), comma separators, CRLF/LF, no leniency.
 */

import { COMPONENT_BASES, ZONE_CODES, type ComponentBasis, type ComponentRowInput, type SlabInput, type ZoneCode } from './pricing';

export const CSV_MAX_BYTES = 25 * 1024 * 1024; // §5.1
export const CSV_MAX_ROWS = 100_000; // §5.1

/** §8.7: formula-leading characters that are rejected in previews. */
const FORMULA_PREFIXES = ['=', '+', '-', '@'];

export class CsvParseError extends Error {}

/** Minimal strict CSV parser → rows of cells. Throws CsvParseError. */
export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let fieldStarted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    fieldStarted = true;
    i += 1;
  }
  if (inQuotes) throw new CsvParseError('unterminated quoted field');
  if (fieldStarted || row.length > 0) endRow();
  return rows;
}

export interface CsvPreviewRow {
  /** 1-based line number in the file. */
  rowNumber: number;
  kind: 'SLAB' | 'COMPONENT' | null;
  ok: boolean;
  errors: string[];
}

export interface CsvValidationPreview {
  ok: boolean;
  totalRows: number;
  okRows: number;
  errorRows: number;
  /** Validated rows in pricing-input shape, ready for version create. */
  slabs: SlabInput[];
  components: ComponentRowInput[];
  rows: CsvPreviewRow[];
  limits: { maxBytes: number; maxRows: number };
}

const EXPECTED_HEADER = [
  'kind',
  'zone_or_code',
  'base_weight_kg_or_label',
  'base_rate_or_basis',
  'additional_step_kg_or_value',
  'additional_rate_or_is_taxable',
];

export const CSV_TEMPLATE_HELP =
  'Expected columns (one optional header row, then one record per row): ' +
  'SLAB,zone,base_weight_kg,base_rate,additional_step_kg,additional_rate — ' +
  'zone A–E, weights positive kg ≤3dp, rates INR ≥0 ≤2dp; and/or ' +
  'COMPONENT,code,label,basis,value,is_taxable — basis one of ' +
  COMPONENT_BASES.join('|') +
  ', value money 2dp for FLAT/PER_KG_BILLABLE or rate 0–1 ≤6dp for percent ' +
  'bases, is_taxable true|false.';

const MONEY_RE = /^\d+(?:\.\d{1,2})?$/; // paise-safe 2dp (§4.1)
const WEIGHT_RE = /^\d+(?:\.\d{1,3})?$/; // kg 3dp storage scale
const RATE_RE = /^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/; // 0–1, 6dp storage scale
const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

function isPositiveNumeric(value: string, re: RegExp): boolean {
  return re.test(value) && Number(value) > 0;
}

function checkFormula(cell: string): string | null {
  return FORMULA_PREFIXES.includes(cell.charAt(0))
    ? `cell "${cell}" looks like a formula — formula content is rejected in previews (§8.7)`
    : null;
}

function validateSlabRow(cells: string[], errors: string[]): SlabInput | null {
  if (cells.length !== 6) {
    errors.push(`SLAB rows need 6 columns, got ${cells.length}. ${CSV_TEMPLATE_HELP}`);
    return null;
  }
  const [, zone, baseWeight, baseRate, stepKg, stepRate] = cells;
  if (!(ZONE_CODES as readonly string[]).includes(zone)) {
    errors.push(`zone must be one of A–E, got "${zone}"`);
  }
  if (!isPositiveNumeric(baseWeight, WEIGHT_RE)) {
    errors.push(`base_weight_kg must be a positive kg value ≤3dp, got "${baseWeight}"`);
  }
  if (!MONEY_RE.test(baseRate)) {
    errors.push(`base_rate must be INR ≥0 ≤2dp, got "${baseRate}"`);
  }
  if (!isPositiveNumeric(stepKg, WEIGHT_RE)) {
    errors.push(`additional_step_kg must be a positive kg value ≤3dp, got "${stepKg}"`);
  }
  if (!MONEY_RE.test(stepRate)) {
    errors.push(`additional_rate must be INR ≥0 ≤2dp, got "${stepRate}"`);
  }
  if (errors.length > 0) return null;
  return {
    zone: zone as ZoneCode,
    baseWeightKg: baseWeight,
    baseRate,
    additionalStepKg: stepKg,
    additionalRate: stepRate,
  };
}

function validateComponentRow(
  cells: string[],
  position: number,
  errors: string[],
): ComponentRowInput | null {
  if (cells.length !== 6) {
    errors.push(`COMPONENT rows need 6 columns, got ${cells.length}. ${CSV_TEMPLATE_HELP}`);
    return null;
  }
  const [, code, label, basis, value, isTaxable] = cells;
  if (!CODE_RE.test(code)) {
    errors.push(`component code must be 1–32 chars [A-Za-z0-9_-], got "${code}"`);
  }
  if (label.trim() === '') {
    errors.push('component label must not be empty');
  }
  if (!(COMPONENT_BASES as readonly string[]).includes(basis)) {
    errors.push(`basis must be one of ${COMPONENT_BASES.join('|')}, got "${basis}"`);
  }
  const percentBasis =
    basis === 'PERCENT_OF_BASE_FREIGHT' ||
    basis === 'PERCENT_OF_PRE_TAX_SUBTOTAL' ||
    basis === 'PERCENT_OF_DECLARED_VALUE';
  if ((COMPONENT_BASES as readonly string[]).includes(basis)) {
    if (percentBasis && !RATE_RE.test(value)) {
      errors.push(`value for ${basis} must be a rate 0–1 ≤6dp, got "${value}"`);
    }
    if (!percentBasis && !MONEY_RE.test(value)) {
      errors.push(`value for ${basis} must be INR ≥0 ≤2dp, got "${value}"`);
    }
  }
  if (isTaxable !== 'true' && isTaxable !== 'false') {
    errors.push(`is_taxable must be true or false, got "${isTaxable}"`);
  }
  if (errors.length > 0) return null;
  return {
    code,
    label: label.trim(),
    basis: basis as ComponentBasis,
    value,
    isTaxable: isTaxable === 'true',
    position,
  };
}

function isHeaderRow(cells: string[]): boolean {
  if (cells.length !== EXPECTED_HEADER.length) return false;
  return cells.every((c, i) => c.trim().toLowerCase() === EXPECTED_HEADER[i]);
}

/**
 * Parse + validate an uploaded rate-card CSV into a preview (§9.15). Nothing
 * is persisted here; the confirm step re-runs this and saves only when
 * `preview.ok`.
 */
export function validateRateCardCsv(text: string): CsvValidationPreview {
  const limits = { maxBytes: CSV_MAX_BYTES, maxRows: CSV_MAX_ROWS };
  const preview: CsvValidationPreview = {
    ok: false,
    totalRows: 0,
    okRows: 0,
    errorRows: 0,
    slabs: [],
    components: [],
    rows: [],
    limits,
  };

  // §5.1 size limit — counted on the raw bytes before any parsing.
  if (Buffer.byteLength(text, 'utf8') > CSV_MAX_BYTES) {
    preview.rows.push({
      rowNumber: 0,
      kind: null,
      ok: false,
      errors: [`file exceeds the 25 MB upload limit (§5.1)`],
    });
    preview.errorRows = 1;
    return preview;
  }

  let parsed: string[][];
  try {
    parsed = parseCsvText(text);
  } catch (err) {
    preview.rows.push({
      rowNumber: 0,
      kind: null,
      ok: false,
      errors: [`unparseable CSV: ${(err as Error).message}. ${CSV_TEMPLATE_HELP}`],
    });
    preview.errorRows = 1;
    return preview;
  }

  const dataRows = parsed.length > 0 && isHeaderRow(parsed[0]) ? parsed.slice(1) : parsed;
  // Skip a trailing fully-empty line.
  const rows = dataRows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
  const headerOffset = parsed.length - dataRows.length;

  if (rows.length > CSV_MAX_ROWS) {
    preview.rows.push({
      rowNumber: 0,
      kind: null,
      ok: false,
      errors: [`file has ${rows.length} data rows, over the 100,000 row limit (§5.1)`],
    });
    preview.errorRows = 1;
    preview.totalRows = rows.length;
    return preview;
  }

  const seenZones = new Set<string>();
  let componentPosition = 0;

  rows.forEach((cells, index) => {
    const rowNumber = index + 1 + headerOffset;
    const errors: string[] = [];
    const trimmed = cells.map((c) => c.trim());

    for (const cell of trimmed) {
      const formulaError = checkFormula(cell);
      if (formulaError) errors.push(formulaError);
    }

    let kind: 'SLAB' | 'COMPONENT' | null = null;
    let slab: SlabInput | null = null;
    let component: ComponentRowInput | null = null;

    if (errors.length === 0) {
      const kindCell = trimmed[0] ?? '';
      if (kindCell === 'SLAB') {
        kind = 'SLAB';
        slab = validateSlabRow(trimmed, errors);
        if (slab && seenZones.has(slab.zone)) {
          errors.push(`duplicate SLAB row for zone ${slab.zone} — one slab per zone per version (§2.3)`);
          slab = null;
        }
        if (slab) seenZones.add(slab.zone);
      } else if (kindCell === 'COMPONENT') {
        kind = 'COMPONENT';
        componentPosition += 1;
        component = validateComponentRow(trimmed, componentPosition, errors);
      } else {
        errors.push(`row kind must be SLAB or COMPONENT, got "${kindCell}". ${CSV_TEMPLATE_HELP}`);
      }
    }

    const ok = errors.length === 0;
    if (ok && slab) preview.slabs.push(slab);
    if (ok && component) preview.components.push(component);
    preview.rows.push({ rowNumber, kind, ok, errors });
  });

  preview.totalRows = preview.rows.length;
  preview.okRows = preview.rows.filter((r) => r.ok).length;
  preview.errorRows = preview.totalRows - preview.okRows;
  if (preview.totalRows === 0) {
    preview.rows.push({
      rowNumber: 0,
      kind: null,
      ok: false,
      errors: [`no data rows found. ${CSV_TEMPLATE_HELP}`],
    });
    preview.errorRows = 1;
  }
  preview.ok = preview.totalRows > 0 && preview.errorRows === 0;
  return preview;
}
