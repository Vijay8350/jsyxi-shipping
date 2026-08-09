import { BluedartAdapter, createInMemoryTokenCache } from '../../src/modules/bluedart/bluedart.adapter';
import { runCourierContractSuite } from '../courier-framework/contract-suite';
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, createMockBluedart } from './mock-bluedart';

/**
 * §15.1: the courier contract suite run against the Blue Dart adapter with
 * a scripted mock Blue Dart server (mock-bluedart.ts) implementing the
 * suite's conventions:
 * - '999999' is unserviceable;
 * - 'contract-timeout-' intents produce OUTCOME_UNKNOWN resolvable via
 *   lookupByReference (INV-5);
 * - a scripted 429 after 10 successful pricing calls satisfies the
 *   rate-limiting row within the suite's 50-call budget;
 * - the adapter's requestLog proves A1-04 idempotency (one create issued
 *   across retries of the same intent);
 * - ndrAction is declared unsupported (A1-03) and the suite asserts the
 *   UnsupportedCapabilityError.
 *
 * A fixed injected clock keeps every run deterministic.
 */
const FIXED_NOW = new Date('2026-02-01T10:00:00.000Z');

runCourierContractSuite('bluedart', () => {
  const mock = createMockBluedart({ quoteRateLimit: 10 });
  return new BluedartAdapter({
    courierAccountId: '00000000-0000-0000-0000-0000000000a1',
    mode: 'TEST',
    clientId: MOCK_CLIENT_ID,
    clientSecret: MOCK_CLIENT_SECRET,
    tokenCache: createInMemoryTokenCache(),
    now: () => FIXED_NOW,
    fetchFn: mock.fetchFn,
  });
});
