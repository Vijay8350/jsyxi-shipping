/**
 * Money (§4.1, INV-15).
 *
 * - Currency is INR only (INV-2); there is no FX anywhere in v1.
 * - Internally every amount is an integer number of **paise** (`bigint`).
 *   Database columns are `NUMERIC(19,4)` per §4.1 and are converted at the
 *   boundary — never computed on.
 * - Rates/percentages are stored `0–1` at 6 decimal places (§4.1) and carried
 *   here as integer **millionths** (`1_000_000n` = 100%).
 * - Rounding is half-up to the paise, applied **per component at the moment the
 *   component is computed**; a total is always the sum of already-rounded
 *   components, never a re-round of an unrounded total (INV-15).
 *
 * No floats for money, ever. Inputs arrive as strings (from the DB or JSON).
 */

export type Paise = bigint;
export type Millionths = bigint;

export const PAISE_PER_RUPEE = 100n;
export const MILLION = 1_000_000n;

/** "1234.56" -> 123456n paise. Accepts up to 4 dp (DB storage scale). */
export function rupeesToPaise(value: string): Paise {
  const trimmed = value.trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(trimmed);
  if (!m) throw new Error(`invalid money value: ${value}`);
  const [, sign, whole, frac = ''] = m;
  const fracPadded = (frac + '0000').slice(0, 4);
  // Convert 4dp storage to paise (2dp); the DB only ever stores paise-rounded
  // values for money components, so the last two digits must be zero.
  if (fracPadded.slice(2) !== '00') {
    throw new Error(`money value has sub-paise precision: ${value}`);
  }
  const paise = BigInt(whole) * PAISE_PER_RUPEE + BigInt(fracPadded.slice(0, 2));
  return sign === '-' ? -paise : paise;
}

/** 123456n -> "1234.56" (2dp display/settlement form, §4.1). */
export function paiseToRupees(paise: Paise): string {
  const neg = paise < 0n;
  const abs = neg ? -paise : paise;
  const whole = abs / PAISE_PER_RUPEE;
  const frac = abs % PAISE_PER_RUPEE;
  return `${neg ? '-' : ''}${whole}.${frac.toString().padStart(2, '0')}`;
}

/** "0.180000" (0–1, 6dp storage) -> 180000n millionths. */
export function rateToMillionths(value: string): Millionths {
  const trimmed = value.trim();
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(trimmed);
  if (!m) throw new Error(`invalid rate value: ${value}`);
  const [, whole, frac = ''] = m;
  return BigInt(whole) * MILLION + BigInt((frac + '000000').slice(0, 6));
}

/** Half-up division of positive integers: round(0.5) = 1. */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('denominator must be positive');
  if (numerator < 0n) throw new Error('negative amounts are not money components');
  const q = numerator / denominator;
  const r = numerator % denominator;
  return r * 2n >= denominator ? q + 1n : q;
}

/**
 * Apply a stored rate to a paise amount, rounding half-up to the paise at the
 * moment the component is computed (INV-15). e.g. applyRate(8000n, 180000n) =
 * 18% of ₹80.00 = 1440n paise.
 */
export function applyRate(amount: Paise, rate: Millionths): Paise {
  return divRoundHalfUp(amount * rate, MILLION);
}

/** Totals are sums of already-rounded components (INV-15). */
export function sumComponents(...components: Paise[]): Paise {
  return components.reduce((acc, c) => acc + c, 0n);
}

/** ceil(a / b) for positive integers (F-3 billable-weight steps, F-5 slabs). */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('divisor must be positive');
  if (a <= 0n) return 0n;
  return (a + b - 1n) / b;
}
