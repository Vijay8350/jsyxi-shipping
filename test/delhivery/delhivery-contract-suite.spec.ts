import { DelhiveryAdapter } from '../../src/modules/delhivery/delhivery.adapter';
import { runCourierContractSuite } from '../courier-framework/contract-suite';
import { MOCK_API_TOKEN, createMockDelhivery } from './mock-delhivery';

/**
 * §15.1: the courier contract suite run against the Delhivery adapter with
 * a scripted mock Delhivery server (mock-delhivery.ts) implementing the
 * suite's conventions:
 * - '999999' is unserviceable;
 * - 'contract-timeout-' intents produce OUTCOME_UNKNOWN resolvable via
 *   lookupByReference (INV-5);
 * - a scripted 429 after 10 successful quote calls satisfies the
 *   rate-limiting row within the suite's 50-call budget;
 * - the adapter's requestLog proves A1-04 idempotency (one create issued
 *   across retries of the same intent).
 *
 * A fixed injected clock keeps every run deterministic.
 */
const FIXED_NOW = new Date('2026-02-01T10:00:00.000Z');

runCourierContractSuite('delhivery', () => {
  const mock = createMockDelhivery({ quoteRateLimit: 10 });
  return new DelhiveryAdapter({
    courierAccountId: '00000000-0000-0000-0000-0000000000a1',
    mode: 'TEST',
    apiToken: MOCK_API_TOKEN,
    now: () => FIXED_NOW,
    fetchFn: mock.fetchFn,
  });
});
