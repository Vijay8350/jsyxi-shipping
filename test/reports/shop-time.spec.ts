import { describe, expect, it } from 'vitest';
import {
  advanceNextRun,
  computeInitialNextRun,
  localParts,
  zonedLocalToUtc,
} from '../../src/modules/reports/shop-time';

/**
 * §5.2: scheduled reports run daily/weekly in SHOP-LOCAL time. Asia/Kolkata
 * is UTC+5:30 with no DST, so 06:00 local = 00:30 UTC, always.
 */
const KOLKATA = 'Asia/Kolkata';

describe('shop-time — shop-local schedule computation (§5.2)', () => {
  it('localParts renders the instant in the shop timezone', () => {
    // 2026-08-05T00:30:00Z is 06:00 in Kolkata.
    const p = localParts(new Date('2026-08-05T00:30:00Z'), KOLKATA);
    expect([p.year, p.month, p.day, p.hour, p.minute]).toEqual([2026, 8, 5, 6, 0]);
    expect(p.isoWeekday).toBe(3); // Wednesday
  });

  it('zonedLocalToUtc converts Kolkata wall time to UTC', () => {
    expect(zonedLocalToUtc(KOLKATA, 2026, 8, 5, 6, 0).toISOString()).toBe('2026-08-05T00:30:00.000Z');
  });

  it('daily: before 06:00 local → today 06:00; after → tomorrow 06:00', () => {
    // 2026-08-05 05:00 local = 2026-08-04T23:30Z
    expect(computeInitialNextRun('daily', new Date('2026-08-04T23:30:00Z'), KOLKATA).toISOString())
      .toBe('2026-08-05T00:30:00.000Z');
    // 2026-08-05 07:00 local = 2026-08-05T01:30Z → tomorrow
    expect(computeInitialNextRun('daily', new Date('2026-08-05T01:30:00Z'), KOLKATA).toISOString())
      .toBe('2026-08-06T00:30:00.000Z');
  });

  it('weekly: week starts Monday (§5.2) — Wednesday run schedules next Monday 06:00 local', () => {
    // 2026-08-05 is a Wednesday; next Monday is 2026-08-10.
    expect(computeInitialNextRun('weekly', new Date('2026-08-05T01:30:00Z'), KOLKATA).toISOString())
      .toBe('2026-08-10T00:30:00.000Z');
    // Monday 05:00 local (before 06:00) → same Monday.
    expect(computeInitialNextRun('weekly', new Date('2026-08-09T23:30:00Z'), KOLKATA).toISOString())
      .toBe('2026-08-10T00:30:00.000Z');
  });

  it('advanceNextRun steps from the scheduled wall time and rolls past now', () => {
    // Scheduled daily at 06:00 Kolkata = 00:30Z; now is three days later.
    const scheduled = new Date('2026-08-05T00:30:00Z');
    const next = advanceNextRun(scheduled, 'daily', KOLKATA, new Date('2026-08-08T10:00:00Z'));
    expect(next.toISOString()).toBe('2026-08-09T00:30:00.000Z');
    // Weekly steps +7 days from the scheduled slot (Wednesday 06:00 local).
    const weekly = advanceNextRun(scheduled, 'weekly', KOLKATA, new Date('2026-08-05T01:00:00Z'));
    expect(weekly.toISOString()).toBe('2026-08-12T00:30:00.000Z');
  });

  it('weekly advance preserves the weekday of the scheduled slot', () => {
    // A Monday 06:00 Kolkata schedule advances to the next Monday.
    const monday = new Date('2026-08-10T00:30:00Z');
    const next = advanceNextRun(monday, 'weekly', KOLKATA, new Date('2026-08-10T01:00:00Z'));
    expect(next.toISOString()).toBe('2026-08-17T00:30:00.000Z');
  });

  it('wall-clock is preserved across a DST transition (America/New_York)', () => {
    // 2026-03-08 02:00 EST → EDT. A daily 06:30 local schedule keeps 06:30.
    const before = zonedLocalToUtc('America/New_York', 2026, 3, 7, 6, 30);
    const after = advanceNextRun(before, 'daily', 'America/New_York', before);
    const p = localParts(after, 'America/New_York');
    expect([p.month, p.day, p.hour, p.minute]).toEqual([3, 8, 6, 30]);
  });
});
