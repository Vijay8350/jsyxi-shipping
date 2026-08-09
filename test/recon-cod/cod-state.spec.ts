import { describe, expect, it } from 'vitest';
import {
  addDays,
  agingDays,
  computeDueDate,
  deriveCodState,
  localDateString,
} from '../../src/modules/recon-cod/cod-state';

/**
 * Pure F-13 / F-21 arithmetic (§3.15, §4.8): tally boundaries, due-date
 * computation in shop-local time, and aging.
 */

const base = {
  expectedPaise: 100000n, // ₹1,000.00
  tolerancePaise: 100n, // ₹1.00 (S-29 default)
  dueAt: '2026-08-08',
  todayLocal: '2026-08-05',
  current: 'AWAITING' as const,
};

describe('deriveCodState (F-13)', () => {
  it('R = 0 before due → AWAITING', () => {
    expect(deriveCodState({ ...base, allocatedPaise: 0n })).toBe('AWAITING');
  });

  it('R = 0 after due → PENDING_OVERDUE (F-21)', () => {
    expect(
      deriveCodState({ ...base, allocatedPaise: 0n, todayLocal: '2026-08-09' }),
    ).toBe('PENDING_OVERDUE');
  });

  it('|R − expected| = tolerance exactly → TALLIED (boundary, both sides)', () => {
    expect(deriveCodState({ ...base, allocatedPaise: 99900n })).toBe('TALLIED');
    expect(deriveCodState({ ...base, allocatedPaise: 100100n })).toBe('TALLIED');
  });

  it('R one paise below the lower boundary → SHORT', () => {
    expect(deriveCodState({ ...base, allocatedPaise: 99899n })).toBe('SHORT');
  });

  it('R one paise above the upper boundary → EXCESS', () => {
    expect(deriveCodState({ ...base, allocatedPaise: 100101n })).toBe('EXCESS');
  });

  it('SHORT past due → PENDING_OVERDUE ("no full allocation after its due date", §4.8)', () => {
    expect(
      deriveCodState({ ...base, allocatedPaise: 50000n, todayLocal: '2026-08-09' }),
    ).toBe('PENDING_OVERDUE');
  });

  it('EXCESS past due stays EXCESS (a full allocation)', () => {
    expect(
      deriveCodState({ ...base, allocatedPaise: 100101n, todayLocal: '2026-08-09' }),
    ).toBe('EXCESS');
  });

  it('TALLIED past due stays TALLIED', () => {
    expect(
      deriveCodState({ ...base, allocatedPaise: 100000n, todayLocal: '2026-08-20' }),
    ).toBe('TALLIED');
  });

  it('RTO_UNCOLLECTED is terminal (§3.15) — never recomputed away, never SHORT (§4.7)', () => {
    expect(
      deriveCodState({ ...base, allocatedPaise: 0n, current: 'RTO_UNCOLLECTED' }),
    ).toBe('RTO_UNCOLLECTED');
    expect(
      deriveCodState({ ...base, allocatedPaise: 100000n, current: 'RTO_UNCOLLECTED' }),
    ).toBe('RTO_UNCOLLECTED');
  });
});

describe('due dates and aging (F-21, §5.2 shop-local)', () => {
  it('localDateString evaluates in the shop timezone, not UTC', () => {
    // 2026-08-01T19:00Z is already 2026-08-02 00:30 in Asia/Kolkata.
    expect(localDateString(new Date('2026-08-01T19:00:00.000Z'), 'Asia/Kolkata')).toBe('2026-08-02');
    expect(localDateString(new Date('2026-08-01T10:00:00.000Z'), 'Asia/Kolkata')).toBe('2026-08-01');
  });

  it('computeDueDate = shop-local delivered date + due days', () => {
    expect(computeDueDate(new Date('2026-08-01T10:00:00.000Z'), 7, 'Asia/Kolkata')).toBe('2026-08-08');
    expect(computeDueDate(new Date('2026-08-01T19:00:00.000Z'), 7, 'Asia/Kolkata')).toBe('2026-08-09');
  });

  it('addDays crosses month boundaries', () => {
    expect(addDays('2026-08-30', 7)).toBe('2026-09-06');
  });

  it('agingDays = calendar days since due_at, floored at 0', () => {
    expect(agingDays('2026-08-08', '2026-08-05')).toBe(0);
    expect(agingDays('2026-08-08', '2026-08-08')).toBe(0);
    expect(agingDays('2026-08-08', '2026-08-11')).toBe(3);
  });
});
