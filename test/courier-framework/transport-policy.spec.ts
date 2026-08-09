import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountBudgetExhaustedError,
  AdapterRateLimitError,
  AdapterTimeoutError,
  CircuitOpenError,
  CourierAuthError,
  CourierProviderError,
} from '../../src/modules/courier-framework/adapter-errors';
import { UnsupportedCapabilityError } from '../../src/modules/courier-framework/adapter.types';
import {
  classifyAdapterError,
  TransportPolicy,
} from '../../src/modules/courier-framework/transport-policy';
import { ACCOUNT_ID, mockRedis, SHOP_ID } from './helpers';

/** Transport policy (§8.2, S-17, §3.21): token-bucket limiter with booking
 *  priority, circuit breaker with health transitions. */
describe('TransportPolicy (§8.2, S-17, §3.21)', () => {
  let redis: ReturnType<typeof mockRedis>;
  let health: { transition: ReturnType<typeof vi.fn> };
  let policy: TransportPolicy;

  beforeEach(() => {
    redis = mockRedis();
    health = { transition: vi.fn().mockResolvedValue(true) };
    // Small numbers so tests exercise the algorithm quickly.
    policy = new TransportPolicy(redis as never, health as never, {
      quotesPerMinute: 10,
      bookingReserveFraction: 0.2, // reserve 2 tokens for booking
      failureThreshold: 3,
      cooldownMs: 30_000,
    });
  });

  describe('rate limiter (S-17)', () => {
    it('admits calls while the bucket has tokens, then refuses with a structured reason', async () => {
      const now = 1_000_000;
      for (let i = 0; i < 10; i++) {
        await expect(policy.consumeBudget(ACCOUNT_ID, 'BOOKING', now)).resolves.toBeUndefined();
      }
      await expect(policy.consumeBudget(ACCOUNT_ID, 'BOOKING', now)).rejects.toBeInstanceOf(
        AccountBudgetExhaustedError,
      );
    });

    it('runs quotes at LOWER priority: the booking reserve survives quote exhaustion', async () => {
      const now = 1_000_000;
      // 8 quotes drain the bucket down to the reserve (floor = 2).
      for (let i = 0; i < 8; i++) {
        await expect(policy.consumeBudget(ACCOUNT_ID, 'QUOTE', now)).resolves.toBeUndefined();
      }
      // The 9th quote is refused — but bookings still get through.
      const err = await policy.consumeBudget(ACCOUNT_ID, 'QUOTE', now).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AccountBudgetExhaustedError);
      expect((err as AccountBudgetExhaustedError).priority).toBe('QUOTE');
      expect((err as AccountBudgetExhaustedError).retryAfterMs).toBeGreaterThan(0);
      await expect(policy.consumeBudget(ACCOUNT_ID, 'BOOKING', now)).resolves.toBeUndefined();
      await expect(policy.consumeBudget(ACCOUNT_ID, 'BOOKING', now)).resolves.toBeUndefined();
      // …and then the shared budget is genuinely empty for everyone.
      await expect(policy.consumeBudget(ACCOUNT_ID, 'BOOKING', now)).rejects.toBeInstanceOf(
        AccountBudgetExhaustedError,
      );
    });

    it('refills over time', async () => {
      const t0 = 1_000_000;
      for (let i = 0; i < 10; i++) {
        await policy.consumeBudget(ACCOUNT_ID, 'BOOKING', t0);
      }
      await expect(policy.consumeBudget(ACCOUNT_ID, 'BOOKING', t0)).rejects.toBeInstanceOf(
        AccountBudgetExhaustedError,
      );
      // 10 tokens/min ⇒ one token every 6s; 12s later two calls fit.
      const t1 = t0 + 12_000;
      await expect(policy.consumeBudget(ACCOUNT_ID, 'BOOKING', t1)).resolves.toBeUndefined();
      await expect(policy.consumeBudget(ACCOUNT_ID, 'BOOKING', t1)).resolves.toBeUndefined();
      await expect(policy.consumeBudget(ACCOUNT_ID, 'BOOKING', t1)).rejects.toBeInstanceOf(
        AccountBudgetExhaustedError,
      );
    });
  });

  describe('circuit breaker (§8.2, §3.21)', () => {
    const providerError = () => new CourierProviderError('FAKE', 'HTTP_500');

    it('opens after N consecutive failures, fails fast while open, and moves health to DEGRADED', async () => {
      const now = 2_000_000;
      await policy.afterFailure(ACCOUNT_ID, SHOP_ID, providerError(), now);
      await policy.afterFailure(ACCOUNT_ID, SHOP_ID, providerError(), now);
      await expect(policy.beforeCall(ACCOUNT_ID, now)).resolves.toBeUndefined();
      expect(health.transition).not.toHaveBeenCalled();

      await policy.afterFailure(ACCOUNT_ID, SHOP_ID, providerError(), now);
      // Breaker open: fail fast with a structured reason.
      const err = await policy.beforeCall(ACCOUNT_ID, now).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect((err as CircuitOpenError).retryAfterMs).toBeGreaterThan(0);
      // §3.21: open breaker ⇒ DEGRADED.
      expect(health.transition).toHaveBeenCalledWith(
        ACCOUNT_ID,
        SHOP_ID,
        'DEGRADED',
        expect.stringContaining('circuit breaker'),
      );
      // Still open mid-cooldown; closed again after it elapses.
      await expect(policy.beforeCall(ACCOUNT_ID, now + 29_999)).rejects.toBeInstanceOf(
        CircuitOpenError,
      );
      await expect(policy.beforeCall(ACCOUNT_ID, now + 30_001)).resolves.toBeUndefined();
    });

    it('an auth failure moves the account straight to DISCONNECTED (§3.21)', async () => {
      const disposition = await policy.afterFailure(
        ACCOUNT_ID,
        SHOP_ID,
        new CourierAuthError('FAKE'),
      );
      expect(disposition.kind).toBe('AUTH');
      expect(health.transition).toHaveBeenCalledWith(
        ACCOUNT_ID,
        SHOP_ID,
        'DISCONNECTED',
        expect.stringContaining('authentication'),
      );
      // …and does not count toward the breaker.
      const state = await policy.breakerState(ACCOUNT_ID);
      expect(state.failures).toBe(0);
    });

    it('a success resets the counter and recovers DEGRADED → HEALTHY', async () => {
      await policy.afterFailure(ACCOUNT_ID, SHOP_ID, providerError());
      await policy.afterFailure(ACCOUNT_ID, SHOP_ID, providerError());
      health.transition.mockClear();
      await policy.afterSuccess(ACCOUNT_ID, SHOP_ID);
      const state = await policy.breakerState(ACCOUNT_ID);
      expect(state.failures).toBe(0);
      expect(health.transition).toHaveBeenCalledWith(
        ACCOUNT_ID,
        SHOP_ID,
        'HEALTHY',
        expect.stringContaining('recovered'),
      );
    });
  });

  describe('failure classification (§8.2)', () => {
    it('classifies adapter errors', () => {
      expect(classifyAdapterError(new CourierAuthError('X')).kind).toBe('AUTH');
      expect(classifyAdapterError(new AdapterTimeoutError('X', 'track')).kind).toBe('COUNTED');
      expect(classifyAdapterError(new CourierProviderError('X', 'E')).kind).toBe('COUNTED');
      expect(classifyAdapterError(new Error('boom')).kind).toBe('COUNTED');
      // A1-03: a declared-unsupported capability is not a failure.
      expect(
        classifyAdapterError(new UnsupportedCapabilityError('X', 'track', null)).kind,
      ).toBe('NOT_A_FAILURE');
      // Provider back-pressure is not a failure either.
      expect(classifyAdapterError(new AdapterRateLimitError('X', 1000)).kind).toBe(
        'NOT_A_FAILURE',
      );
      expect(
        classifyAdapterError(new AccountBudgetExhaustedError('a', 'QUOTE', 1000)).kind,
      ).toBe('NOT_A_FAILURE');
    });
  });
});
