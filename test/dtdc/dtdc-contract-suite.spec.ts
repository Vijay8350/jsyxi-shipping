import { DtdcAdapter } from '../../src/modules/dtdc/dtdc.adapter';
import { runCourierContractSuite } from '../courier-framework/contract-suite';
import { MOCK_API_KEY, createMockDtdc } from './mock-dtdc';

/**
 * §15.1: the courier contract suite run against the DTDC adapter with a
 * scripted mock DTDC server (mock-dtdc.ts) implementing the suite's
 * conventions:
 * - '999999' is unserviceable;
 * - 'contract-timeout-' intents produce OUTCOME_UNKNOWN resolvable via
 *   lookupByReference (INV-5);
 * - a scripted 429 after 10 successful quote calls satisfies the
 *   rate-limiting row within the suite's 50-call budget;
 * - the adapter's requestLog proves A1-04 idempotency (one create issued
 *   across retries of the same intent);
 * - ndrAction is declared unsupported (A1-03) and the suite asserts the
 *   UnsupportedCapabilityError throw.
 *
 * A fixed injected clock keeps every run deterministic.
 */
const FIXED_NOW = new Date('2026-02-01T10:00:00.000Z');

runCourierContractSuite('dtdc', () => {
  const mock = createMockDtdc({ quoteRateLimit: 10 });
  return new DtdcAdapter({
    courierAccountId: '00000000-0000-0000-0000-0000000000a1',
    mode: 'TEST',
    apiKey: MOCK_API_KEY,
    now: () => FIXED_NOW,
    fetchFn: mock.fetchFn,
  });
});
