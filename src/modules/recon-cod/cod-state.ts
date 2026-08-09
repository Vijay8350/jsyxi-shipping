/**
 * Pure COD expectation arithmetic: F-13 tally, F-21 due dates and aging.
 * No I/O — unit-tested directly.
 *
 * Dates are 'YYYY-MM-DD' shop-local calendar dates (§5.2): `due_at` is a
 * DATE column computed in shop-local time, so "past due" and aging compare
 * shop-local dates, never UTC instants.
 */

import { localParts } from '../reports/shop-time';
import type { CodExpectedState } from './recon-cod.types';

export const DEFAULT_TIMEZONE = 'Asia/Kolkata'; // S-2 default

/** The instant's shop-local calendar date, 'YYYY-MM-DD'. */
export function localDateString(at: Date, timeZone: string): string {
  const p = localParts(at, timeZone);
  const mm = String(p.month).padStart(2, '0');
  const dd = String(p.day).padStart(2, '0');
  return `${p.year}-${mm}-${dd}`;
}

/** Calendar day addition on a 'YYYY-MM-DD' date (DST-safe: pure day math). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const out = new Date(t);
  const mm = String(out.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(out.getUTCDate()).padStart(2, '0');
  return `${out.getUTCFullYear()}-${mm}-${dd}`;
}

/** b − a in whole calendar days; negative when b < a. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** F-21: due date = shop-local delivered date + effective cod_due_days. */
export function computeDueDate(deliveredAt: Date, dueDays: number, timeZone: string): string {
  return addDays(localDateString(deliveredAt, timeZone), dueDays);
}

/** F-21: aging days = calendar days since due_at, floored at 0. */
export function agingDays(dueAt: string, todayLocal: string): number {
  return Math.max(0, daysBetween(dueAt, todayLocal));
}

/**
 * F-13 + F-21 (§3.15): the state is DERIVED and recomputed on every
 * allocation; only RTO_UNCOLLECTED is terminal.
 *
 *   R = Σ allocations against the expectation, t = effective COD tolerance.
 *   - R = 0                          → AWAITING (before due) / PENDING_OVERDUE (after due)
 *   - |R − expected| ≤ t             → TALLIED
 *   - R > expected + t               → EXCESS (a full allocation — stays EXCESS past due)
 *   - R < expected − t, past due     → PENDING_OVERDUE ("no full allocation
 *                                      after its due date", §4.8/F-21)
 *   - otherwise                      → SHORT
 */
export function deriveCodState(input: {
  expectedPaise: bigint;
  allocatedPaise: bigint;
  tolerancePaise: bigint;
  /** 'YYYY-MM-DD'. */
  dueAt: string;
  /** 'YYYY-MM-DD' shop-local evaluation date. */
  todayLocal: string;
  current: CodExpectedState;
}): CodExpectedState {
  // §3.15: the only terminal state; a late remittance is still recorded
  // (append-only allocation) but never regresses it (§4.7, INV-17).
  if (input.current === 'RTO_UNCOLLECTED') return 'RTO_UNCOLLECTED';

  const { expectedPaise: expected, allocatedPaise: r, tolerancePaise: tol } = input;
  const pastDue = input.todayLocal > input.dueAt;

  if (r === 0n) return pastDue ? 'PENDING_OVERDUE' : 'AWAITING';
  const diff = r > expected ? r - expected : expected - r;
  if (diff <= tol) return 'TALLIED';
  if (r > expected + tol) return 'EXCESS';
  if (pastDue) return 'PENDING_OVERDUE';
  return 'SHORT';
}
