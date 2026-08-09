import { XpressbeesAdapter } from '../../src/modules/xpressbees/xpressbees.adapter';
import { runCourierContractSuite } from '../courier-framework/contract-suite';
import {
  InMemoryTokenCache,
  MOCK_EMAIL,
  MOCK_PASSWORD,
  createMockXpressbees,
} from './mock-xpressbees';

/**
 * §15.1: the courier contract suite run against the Xpressbees adapter with
 * a scripted mock Xpressbees server (mock-xpressbees.ts) implementing the
 * suite's conventions:
 * - 'contract-timeout-' intents produce OUTCOME_UNKNOWN resolvable via
 *   lookupByReference (INV-5);
 * - the adapter's requestLog proves A1-04 idempotency (one create issued
 *   across retries of the same intent);
 * - getQuote is declared unsupported (A1-03) — Xpressbees Services are
 *   RATE_CARD (§3.7), priced by the §4.5 cost engine — so the suite asserts
 *   the UnsupportedCapabilityError throw instead of functional-testing
 *   quotes and rate limiting.
 *
 * A fixed injected clock keeps every run deterministic; an in-memory token
 * cache stands in for Redis.
 */
const FIXED_NOW = new Date('2026-02-01T10:00:00.000Z');

runCourierContractSuite('xpressbees', () => {
  const mock = createMockXpressbees();
  return new XpressbeesAdapter({
    courierAccountId: '00000000-0000-0000-0000-0000000000a1',
    mode: 'TEST',
    email: MOCK_EMAIL,
    password: MOCK_PASSWORD,
    now: () => FIXED_NOW,
    fetchFn: mock.fetchFn,
    tokenCache: new InMemoryTokenCache(),
  });
});
