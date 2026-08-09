import { createHash } from 'node:crypto';

/**
 * S-48 (§7.2 → §8.6, §3.17): the single retry policy for idempotent work —
 * exponential backoff with jitter, up to 10 attempts over 24 hours, then a
 * Shop-scoped DLQ with an alert.
 *
 * The schedule is computed deterministically from the attempt number plus a
 * jitter seed (the outbox row's idempotency key), so the delay for a given
 * (attempt, seed) pair is a pure function — tests assert the exact schedule
 * attempt by attempt, and a re-claim after a crash computes the same delay.
 */

/** S-48: 10 attempts total, then DLQ (§8.6). */
export const SYNC_MAX_ATTEMPTS = 10;
/** Base delay for attempt 1; doubles per attempt. */
export const SYNC_RETRY_BASE_DELAY_MS = 30_000;
export const SYNC_RETRY_FACTOR = 2;
/**
 * Per-attempt cap. With the base above, the raw sum of attempts 1–10 is
 * 29,730s; the cap keeps the worst-case full schedule (~8.3h with maximal
 * jitter) comfortably inside the S-48 24-hour budget.
 */
export const SYNC_RETRY_MAX_DELAY_MS = 4 * 60 * 60 * 1_000; // 4 h

/** Un-jittered exponential delay for a 1-based attempt number. */
export function backoffMs(attempt: number): number {
  const raw = SYNC_RETRY_BASE_DELAY_MS * SYNC_RETRY_FACTOR ** (attempt - 1);
  return Math.min(raw, SYNC_RETRY_MAX_DELAY_MS);
}

/**
 * Deterministic jitter ratio in [0, 1] derived from (seed, attempt). Same
 * inputs → same ratio, so the schedule is reproducible and assertable.
 */
export function jitterRatio(seed: string, attempt: number): number {
  const digest = createHash('sha256').update(`${seed}:${attempt}`).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

/**
 * S-48 delay before the given (1-based) attempt is retried: the exponential
 * delay scaled into [50%, 100%] by the deterministic jitter (equal-jitter
 * style — never longer than the raw backoff, never below half of it).
 */
export function retryDelayMs(attempt: number, seed: string): number {
  const base = backoffMs(attempt);
  return Math.round(base * (0.5 + 0.5 * jitterRatio(seed, attempt)));
}

/** next_attempt_at for a retry after a failure of attempt `attempts`. */
export function nextAttemptAt(now: Date, attempts: number, seed: string): Date {
  return new Date(now.getTime() + retryDelayMs(attempts, seed));
}
