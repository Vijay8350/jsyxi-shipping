import { ShadowfaxAdapter } from '../../src/modules/shadowfax/shadowfax.adapter';
import { runCourierContractSuite } from '../courier-framework/contract-suite';
import { MOCK_API_KEY, createMockShadowfax } from './mock-shadowfax';

/**
 * §15.1: the courier contract suite run against the Shadowfax adapter with
 * a scripted mock Shadowfax server (mock-shadowfax.ts) implementing the
 * suite's conventions:
 * - 'contract-timeout-' intents produce OUTCOME_UNKNOWN resolvable via
 *   lookupByReference (INV-5);
 * - the adapter's requestLog proves A1-04 idempotency (one create issued
 *   across retries of the same intent);
 * - getQuote is DECLARED UNSUPPORTED (A1-03 — RATE_CARD pricing via the
 *   §4.5 cost engine), so the suite's quote/serviceability/rate-limit rows
 *   assert the UnsupportedCapabilityError instead of a live quote path.
 *
 * A fixed injected clock keeps every run deterministic.
 */
const FIXED_NOW = new Date('2026-02-01T10:00:00.000Z');

runCourierContractSuite('shadowfax', () => {
  const mock = createMockShadowfax();
  return new ShadowfaxAdapter({
    courierAccountId: '00000000-0000-0000-0000-0000000000a1',
    mode: 'TEST',
    apiKey: MOCK_API_KEY,
    now: () => FIXED_NOW,
    fetchFn: mock.fetchFn,
  });
});
