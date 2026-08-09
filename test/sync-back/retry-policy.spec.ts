import { describe, expect, it } from 'vitest';
import {
  SYNC_MAX_ATTEMPTS,
  SYNC_RETRY_BASE_DELAY_MS,
  SYNC_RETRY_FACTOR,
  SYNC_RETRY_MAX_DELAY_MS,
  backoffMs,
  jitterRatio,
  nextAttemptAt,
  retryDelayMs,
} from '../../src/modules/sync-back/retry-policy';

/**
 * S-48 (§8.6): exponential backoff with jitter, 10 attempts over 24 hours.
 * The schedule is a pure function of (attempt, seed) — asserted value by
 * value here so the worker's RETRYING timestamps are reproducible.
 */

const SEED = 'shop:shipment:OP:digest';

describe('S-48 retry policy (§8.6)', () => {
  it('is 10 attempts, exponential from the base delay, capped', () => {
    expect(SYNC_MAX_ATTEMPTS).toBe(10);
    expect(backoffMs(1)).toBe(SYNC_RETRY_BASE_DELAY_MS);
    expect(backoffMs(2)).toBe(SYNC_RETRY_BASE_DELAY_MS * SYNC_RETRY_FACTOR);
    expect(backoffMs(3)).toBe(SYNC_RETRY_BASE_DELAY_MS * SYNC_RETRY_FACTOR ** 2);
    // Cap binds by attempt 10.
    expect(backoffMs(10)).toBe(SYNC_RETRY_MAX_DELAY_MS);
  });

  it('is deterministic for the same (attempt, seed)', () => {
    for (let attempt = 1; attempt <= SYNC_MAX_ATTEMPTS; attempt += 1) {
      expect(retryDelayMs(attempt, SEED)).toBe(retryDelayMs(attempt, SEED));
    }
    // Different seeds jitter differently (over the full schedule, at least
    // one attempt differs).
    const a = Array.from({ length: 10 }, (_, i) => retryDelayMs(i + 1, 'seed-a'));
    const b = Array.from({ length: 10 }, (_, i) => retryDelayMs(i + 1, 'seed-b'));
    expect(a).not.toEqual(b);
  });

  it('jitter stays within [50%, 100%] of the raw backoff', () => {
    for (let attempt = 1; attempt <= SYNC_MAX_ATTEMPTS; attempt += 1) {
      const delay = retryDelayMs(attempt, SEED);
      expect(delay).toBeGreaterThanOrEqual(Math.round(backoffMs(attempt) * 0.5));
      expect(delay).toBeLessThanOrEqual(backoffMs(attempt));
      const ratio = jitterRatio(SEED, attempt);
      expect(ratio).toBeGreaterThanOrEqual(0);
      expect(ratio).toBeLessThanOrEqual(1);
    }
  });

  it('the full 10-attempt schedule fits inside the 24-hour S-48 budget', () => {
    const total = Array.from({ length: SYNC_MAX_ATTEMPTS }, (_, i) =>
      retryDelayMs(i + 1, SEED),
    ).reduce((sum, d) => sum + d, 0);
    expect(total).toBeLessThanOrEqual(24 * 60 * 60 * 1_000);
    // Worst case (jitter ratio 1 everywhere) also fits.
    const worst = Array.from({ length: SYNC_MAX_ATTEMPTS }, (_, i) => backoffMs(i + 1)).reduce(
      (sum, d) => sum + d,
      0,
    );
    expect(worst).toBeLessThanOrEqual(24 * 60 * 60 * 1_000);
  });

  it('nextAttemptAt = now + retryDelayMs', () => {
    const now = new Date('2026-07-31T10:00:00.000Z');
    for (let attempt = 1; attempt <= SYNC_MAX_ATTEMPTS; attempt += 1) {
      expect(nextAttemptAt(now, attempt, SEED).getTime()).toBe(
        now.getTime() + retryDelayMs(attempt, SEED),
      );
    }
  });
});
