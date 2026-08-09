/**
 * Shop-local time helpers (§5.2). Storage is always UTC; schedules run in the
 * Shop's IANA timezone. Implemented on Intl (the pattern rules/evaluate.ts
 * already uses) — no new dependency.
 */

export interface LocalParts {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
  hour: number;
  minute: number;
  /** ISO weekday, Monday = 1 (§5.2: week starts Monday). */
  isoWeekday: number;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

const ISO_WEEKDAY: Record<string, number> = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
};

/** The instant's wall-clock parts in the Shop's timezone. */
export function localParts(at: Date, timeZone: string): LocalParts {
  let year = 0, month = 0, day = 0, hour = 0, minute = 0, isoWeekday = 1;
  for (const p of dtf(timeZone).formatToParts(at)) {
    switch (p.type) {
      case 'year': year = Number(p.value); break;
      case 'month': month = Number(p.value); break;
      case 'day': day = Number(p.value); break;
      case 'hour': hour = Number(p.value) % 24; break;
      case 'minute': minute = Number(p.value); break;
      case 'weekday': isoWeekday = ISO_WEEKDAY[p.value.toLowerCase()] ?? 1; break;
      default: break;
    }
  }
  return { year, month, day, hour, minute, isoWeekday };
}

/**
 * Wall-clock local time → UTC instant. Two-pass offset refinement covers the
 * DST transition edge; Asia/Kolkata (the §5.2 default) has no DST.
 */
export function zonedLocalToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const offsetOf = (utcMs: number): number => {
    const p = localParts(new Date(utcMs), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - utcMs;
  };
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let utc = guess - offsetOf(guess);
  const refined = guess - offsetOf(utc);
  if (refined !== utc) utc = refined;
  return new Date(utc);
}

/** Calendar day addition on local date parts (DST-safe). */
function addLocalDays(
  p: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day) + days * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** The run hour for scheduled reports: 06:00 shop-local. */
export const SCHEDULE_RUN_HOUR = 6;
export const SCHEDULE_RUN_MINUTE = 0;

/**
 * The first next_run_at for a new schedule (§5.2 scheduled work runs in
 * shop-local time):
 *  - daily: today at 06:00 local, or tomorrow 06:00 if that has passed;
 *  - weekly: this week's Monday 06:00 local (week starts Monday, §5.2), or
 *    next Monday if that has passed.
 */
export function computeInitialNextRun(
  cadence: 'daily' | 'weekly',
  now: Date,
  timeZone: string,
): Date {
  const p = localParts(now, timeZone);
  if (cadence === 'daily') {
    let candidate = zonedLocalToUtc(timeZone, p.year, p.month, p.day, SCHEDULE_RUN_HOUR, SCHEDULE_RUN_MINUTE);
    if (candidate.getTime() <= now.getTime()) {
      const n = addLocalDays(p, 1);
      candidate = zonedLocalToUtc(timeZone, n.year, n.month, n.day, SCHEDULE_RUN_HOUR, SCHEDULE_RUN_MINUTE);
    }
    return candidate;
  }
  const monday = addLocalDays(p, -(p.isoWeekday - 1));
  let candidate = zonedLocalToUtc(timeZone, monday.year, monday.month, monday.day, SCHEDULE_RUN_HOUR, SCHEDULE_RUN_MINUTE);
  if (candidate.getTime() <= now.getTime()) {
    const next = addLocalDays(monday, 7);
    candidate = zonedLocalToUtc(timeZone, next.year, next.month, next.day, SCHEDULE_RUN_HOUR, SCHEDULE_RUN_MINUTE);
  }
  return candidate;
}

/**
 * Advance a fired schedule to its next occurrence, computed FROM the
 * scheduled local wall time (not from now) so the cadence never drifts, and
 * rolled forward past `now` so a backlog sweep fires once, not N times.
 */
export function advanceNextRun(
  scheduledAt: Date,
  cadence: 'daily' | 'weekly',
  timeZone: string,
  now: Date,
): Date {
  const step = cadence === 'daily' ? 1 : 7;
  let p = localParts(scheduledAt, timeZone);
  let candidate = scheduledAt;
  do {
    const n = addLocalDays(p, step);
    p = { ...p, ...n };
    candidate = zonedLocalToUtc(timeZone, n.year, n.month, n.day, p.hour, p.minute);
  } while (candidate.getTime() <= now.getTime());
  return candidate;
}
