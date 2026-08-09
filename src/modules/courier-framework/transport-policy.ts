import { Inject, Injectable, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../../redis/redis.module';
import {
  AccountBudgetExhaustedError,
  AdapterRateLimitError,
  CallPriority,
  CircuitOpenError,
  CourierAuthError,
} from './adapter-errors';
import { UnsupportedCapabilityError } from './adapter.types';
import { CourierHealthService } from './courier-health.service';

/**
 * Transport policy (§8.2, A3-04, S-17, §3.21). Every adapter call passes
 * through here:
 *
 * 1. Per-courier-account rate limiter — a Redis token bucket. Booking calls
 *    and quote calls share the account's budget (S-17 default 600 quote
 *    calls/min), but quotes run at LOWER priority: a slice of the bucket is
 *    reserved so quote traffic can never starve bookings.
 * 2. Circuit breaker — N consecutive failures opens the breaker for a
 *    cooldown; while open, calls fail fast with a structured reason and the
 *    account's health moves to DEGRADED (§3.21). An auth failure moves it
 *    straight to DISCONNECTED (the §9.21 alert is a notifications concern —
 *    here we set the state and audit).
 * 3. One courier's outage never blocks another (§5.7 queues note): all state
 *    is keyed per courier_account.
 *
 * Failure classification (what counts toward the breaker):
 * - CourierAuthError        → DISCONNECTED, does not open the breaker
 * - AdapterRateLimitError   → back-pressure, never counted
 * - AdapterTimeoutError / CourierProviderError / unknown → counted
 * - UnsupportedCapabilityError → never a failure (A1-03: declared, not broken)
 */

export interface RateLimiterOptions {
  /** S-17 default: 600 quote calls per minute per courier account. */
  quotesPerMinute: number;
  /** Fraction of the bucket reserved for booking when quote traffic is
   *  heavy (S-17 "lower priority than booking", A3-04). Default 0.1. */
  bookingReserveFraction: number;
}

export interface CircuitBreakerOptions {
  /** Consecutive counted failures that open the breaker. Default 5. */
  failureThreshold: number;
  /** How long the breaker stays open. Default 60_000 ms. */
  cooldownMs: number;
}

export const DEFAULT_RATE_LIMITER_OPTIONS: RateLimiterOptions = {
  quotesPerMinute: 600, // S-17
  bookingReserveFraction: 0.1,
};

export const DEFAULT_CIRCUIT_BREAKER_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  cooldownMs: 60_000,
};

/**
 * Atomic token bucket. ARGV: capacity, refill_per_ms, cost, floor, now_ms.
 * A call may spend only if tokens - cost >= floor. Booking passes floor 0
 * (spends down to empty); quotes pass floor = reserve, leaving the reserve
 * slice for bookings (S-17 priority).
 * Returns [allowed (1/0), retry_after_ms].
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local floor = tonumber(ARGV[4])
local now = tonumber(ARGV[5])
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1]) or capacity
local ts = tonumber(data[2]) or now
tokens = math.min(capacity, tokens + (now - ts) * refill_per_ms)
if tokens - cost >= floor then
  redis.call('HMSET', key, 'tokens', tokens - cost, 'ts', now)
  redis.call('PEXPIRE', key, 300000)
  return {1, 0}
else
  redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
  redis.call('PEXPIRE', key, 300000)
  local deficit = (floor + cost) - tokens
  return {0, math.ceil(deficit / refill_per_ms)}
end
`;

/** What the breaker does with a thrown error (§8.2 classification). */
export type FailureDisposition =
  | { kind: 'NOT_A_FAILURE' } // UnsupportedCapabilityError, rate limiting
  | { kind: 'AUTH' } // → DISCONNECTED (§3.21)
  | { kind: 'COUNTED' }; // → consecutive-failure counter / breaker

export function classifyAdapterError(err: unknown): FailureDisposition {
  if (err instanceof UnsupportedCapabilityError) return { kind: 'NOT_A_FAILURE' };
  if (err instanceof AdapterRateLimitError) return { kind: 'NOT_A_FAILURE' };
  if (err instanceof AccountBudgetExhaustedError) return { kind: 'NOT_A_FAILURE' };
  if (err instanceof CourierAuthError) return { kind: 'AUTH' };
  // AdapterTimeoutError, CourierProviderError and unknown errors all count.
  return { kind: 'COUNTED' };
}

@Injectable()
export class TransportPolicy {
  private readonly limiter: RateLimiterOptions;
  private readonly breaker: CircuitBreakerOptions;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly health: CourierHealthService,
    // Not a DI-injectable value — @Optional so Nest passes undefined and the
    // DEFAULT_* spreads below apply (tests construct with explicit options).
    @Optional()
    options?: Partial<RateLimiterOptions & CircuitBreakerOptions>,
  ) {
    this.limiter = { ...DEFAULT_RATE_LIMITER_OPTIONS, ...options };
    this.breaker = { ...DEFAULT_CIRCUIT_BREAKER_OPTIONS, ...options };
  }

  private bucketKey(accountId: string): string {
    return `cf:rl:${accountId}`;
  }

  private breakerKey(accountId: string): string {
    return `cf:cb:${accountId}`;
  }

  /**
   * S-17: consume one unit of the account's budget. Booking and quote share
   * the bucket; quotes must leave the booking reserve untouched.
   * Throws AccountBudgetExhaustedError with a retry hint when refused.
   */
  async consumeBudget(
    courierAccountId: string,
    priority: CallPriority,
    nowMs = Date.now(),
  ): Promise<void> {
    const capacity = this.limiter.quotesPerMinute;
    const refillPerMs = capacity / 60_000;
    const reserve = Math.floor(capacity * this.limiter.bookingReserveFraction);
    const floor = priority === 'QUOTE' ? reserve : 0;
    const [allowed, retryAfterMs] = (await this.redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      this.bucketKey(courierAccountId),
      String(capacity),
      String(refillPerMs),
      '1',
      String(floor),
      String(nowMs),
    )) as [number, number];
    if (!allowed) {
      throw new AccountBudgetExhaustedError(courierAccountId, priority, retryAfterMs);
    }
  }

  /** Fail fast while the breaker is open (§8.2). */
  async beforeCall(courierAccountId: string, nowMs = Date.now()): Promise<void> {
    const openUntil = await this.redis.hget(this.breakerKey(courierAccountId), 'open_until');
    const until = Number(openUntil ?? 0);
    if (until > nowMs) {
      throw new CircuitOpenError(courierAccountId, until - nowMs);
    }
  }

  /** A successful call resets the consecutive-failure counter and, if the
   *  account was DEGRADED by the breaker, moves it back to HEALTHY (§3.21). */
  async afterSuccess(
    courierAccountId: string,
    shopId: string,
  ): Promise<void> {
    const key = this.breakerKey(courierAccountId);
    const failures = Number((await this.redis.hget(key, 'failures')) ?? 0);
    if (failures > 0) {
      await this.redis.del(key);
      await this.health.transition(
        courierAccountId,
        shopId,
        'HEALTHY',
        'transport recovered: consecutive-failure counter reset after a successful call',
      );
    }
  }

  /**
   * Route a thrown adapter error to its §3.21 consequence. Returns the
   * disposition so the caller can log structurally; always rethrow the
   * original error to the caller afterwards.
   */
  async afterFailure(
    courierAccountId: string,
    shopId: string,
    err: unknown,
    nowMs = Date.now(),
  ): Promise<FailureDisposition> {
    const disposition = classifyAdapterError(err);
    if (disposition.kind === 'NOT_A_FAILURE') return disposition;

    if (disposition.kind === 'AUTH') {
      // §3.21: an authentication or token-refresh failure → DISCONNECTED.
      // The courier-disconnected alert (§9.21) is a notifications concern.
      await this.health.transition(
        courierAccountId,
        shopId,
        'DISCONNECTED',
        'adapter authentication failure',
      );
      return disposition;
    }

    // COUNTED: bump the consecutive-failure counter; at the threshold open
    // the breaker for the cooldown and move the account to DEGRADED (§3.21).
    const key = this.breakerKey(courierAccountId);
    const failures = await this.redis.hincrby(key, 'failures', 1);
    await this.redis.pexpire(key, this.breaker.cooldownMs * 10);
    if (failures >= this.breaker.failureThreshold) {
      await this.redis.hset(key, 'open_until', String(nowMs + this.breaker.cooldownMs));
      await this.health.transition(
        courierAccountId,
        shopId,
        'DEGRADED',
        `circuit breaker opened after ${failures} consecutive failures`,
      );
    }
    return disposition;
  }

  /** Test/diagnostics hook: current breaker state, never secrets. */
  async breakerState(
    courierAccountId: string,
  ): Promise<{ failures: number; openUntilMs: number }> {
    const data = await this.redis.hgetall(this.breakerKey(courierAccountId));
    return {
      failures: Number(data?.failures ?? 0),
      openUntilMs: Number(data?.open_until ?? 0),
    };
  }
}
