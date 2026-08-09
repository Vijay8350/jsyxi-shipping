import type { AdapterMethod } from './adapter.types';

/**
 * Structured adapter-call failures (§8.2 transport policy). These types are
 * the contract between adapters and the transport policy: the circuit breaker
 * and the §3.21 health transitions key off them, so an adapter MUST throw
 * these (or subclasses) rather than ad-hoc Errors.
 *
 * None of them may carry plaintext credentials or raw request/response bodies
 * containing PII (INV-18, §5.7 control 4) — messages carry codes and IDs only.
 */

/** The provider rejected authentication (bad key, expired OAuth token).
 *  Moves the account to DISCONNECTED (§3.21) and triggers the
 *  courier-disconnected alert (§9.21 — a later notifications concern). */
export class CourierAuthError extends Error {
  constructor(
    public readonly courierCode: string,
    message = `${courierCode}: authentication failed`,
  ) {
    super(message);
    this.name = 'CourierAuthError';
  }
}

/** The provider (or the account's own budget) rate-limited the call.
 *  Not counted toward the circuit breaker — it is back-pressure, not
 *  provider failure. */
export class AdapterRateLimitError extends Error {
  constructor(
    public readonly courierCode: string,
    public readonly retryAfterMs: number | null,
    message = `${courierCode}: rate limited`,
  ) {
    super(message);
    this.name = 'AdapterRateLimitError';
  }
}

/** A transport-level timeout. On createShipment the adapter converts this to
 *  kind = OUTCOME_UNKNOWN itself (INV-5); anywhere else it propagates as this
 *  error and counts toward the circuit breaker. */
export class AdapterTimeoutError extends Error {
  constructor(
    public readonly courierCode: string,
    public readonly method: AdapterMethod,
    message = `${courierCode}: ${method} timed out`,
  ) {
    super(message);
    this.name = 'AdapterTimeoutError';
  }
}

/** Any other provider-side failure; counts toward the circuit breaker. */
export class CourierProviderError extends Error {
  constructor(
    public readonly courierCode: string,
    public readonly code: string,
    message = `${courierCode}: provider error ${code}`,
  ) {
    super(message);
    this.name = 'CourierProviderError';
  }
}

/** Our own per-account budget refused the call before it left the process
 *  (S-17). Structured so the caller can surface a reason, never a stack. */
export class AccountBudgetExhaustedError extends Error {
  constructor(
    public readonly courierAccountId: string,
    public readonly priority: CallPriority,
    public readonly retryAfterMs: number,
  ) {
    super(
      priority === 'QUOTE'
        ? 'quote budget exhausted: the per-account quote allowance is reserved for booking right now (S-17)'
        : 'account call budget exhausted (S-17)',
    );
    this.name = 'AccountBudgetExhaustedError';
  }
}

/** The circuit breaker is open; calls fail fast with a structured reason
 *  while the account sits at DEGRADED (§3.21). */
export class CircuitOpenError extends Error {
  constructor(
    public readonly courierAccountId: string,
    public readonly retryAfterMs: number,
  ) {
    super('courier circuit breaker is open; calls fail fast until the cooldown elapses');
    this.name = 'CircuitOpenError';
  }
}

/** S-17: booking and quote calls share the account's budget, but quotes run
 *  at lower priority than booking. */
export type CallPriority = 'BOOKING' | 'QUOTE';
