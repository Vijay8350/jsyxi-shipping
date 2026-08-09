/**
 * Saved-zone pincode CSV parsing (§9.4.2). Pure and unit-testable.
 * Bounded by §5.1 (zone imports ≤100,000 rows); every row is normalized to
 * the 6-digit Indian pincode form and invalid rows are reported, never
 * silently dropped (INV-20).
 */

/** §5.1 import bound for zone/pincode uploads. */
export const MAX_PINCODES_PER_ZONE = 100_000;

const PINCODE_RE = /^[0-9]{6}$/;

export interface PincodeCsvResult {
  /** Normalized, de-duplicated pincodes in first-seen order. */
  pincodes: string[];
  /** Per-row rejections (1-based row number), never silent (INV-20). */
  errors: { row: number; value: string; reason: string }[];
}

/**
 * Accepts one pincode per line, or comma/semicolon-separated rows. Trims
 * whitespace; rejects anything that is not exactly 6 digits.
 */
export function parsePincodeCsv(csv: string): PincodeCsvResult {
  const pincodes: string[] = [];
  const seen = new Set<string>();
  const errors: PincodeCsvResult['errors'] = [];
  const rows = csv.split(/\r?\n/);
  rows.forEach((line, lineIdx) => {
    const cells = line.split(/[;,]/);
    cells.forEach((cell) => {
      const value = cell.trim();
      if (value === '') return;
      const row = lineIdx + 1;
      if (!PINCODE_RE.test(value)) {
        errors.push({ row, value, reason: 'not a 6-digit pincode' });
        return;
      }
      if (seen.has(value)) return; // duplicates collapse silently by design
      if (seen.size >= MAX_PINCODES_PER_ZONE) {
        errors.push({ row, value, reason: `exceeds the ${MAX_PINCODES_PER_ZONE} pincode bound (§5.1)` });
        return;
      }
      seen.add(value);
      pincodes.push(value);
    });
  });
  return { pincodes, errors };
}
