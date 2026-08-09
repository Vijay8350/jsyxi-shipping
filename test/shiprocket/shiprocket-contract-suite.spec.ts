import { ShiprocketAdapter } from '../../src/modules/shiprocket/shiprocket.adapter';
import { runCourierContractSuite } from '../courier-framework/contract-suite';
import {
  InMemoryShiprocketTokenCache,
  MOCK_EMAIL,
  MOCK_PASSWORD,
  createMockShiprocket,
} from './mock-shiprocket';

/**
 * §15.1: the courier contract suite run against the Shiprocket adapter with
 * a scripted mock Shiprocket server (mock-shiprocket.ts) implementing the
 * suite's conventions:
 * - 'contract-timeout-' intents produce OUTCOME_UNKNOWN resolvable via
 *   lookupByReference (INV-5);
 * - '999999' is unserviceable; the default mock courier (id 39) prices the
 *   serviceable lane;
 * - sustained quote load trips the scripted 429 (rate limiting row);
 * - the adapter's requestLog proves A1-04 idempotency (one create issued
 *   across retries of the same intent);
 * - ndrAction is declared unsupported (A1-03) — Shiprocket's NDR action API
 *   is not externally verified at v1 — so the suite asserts the
 *   UnsupportedCapabilityError throw instead of functional-testing NDR.
 *
 * The courier map (`default: '39'`) is the nested-identity selection
 * (§15.1): the chosen Shiprocket courier_id for quote and AWB assign.
 *
 * A fixed injected clock keeps every run deterministic; an in-memory token
 * cache stands in for Redis.
 */
const FIXED_NOW = new Date('2026-02-01T10:00:00.000Z');

runCourierContractSuite('shiprocket', () => {
  const mock = createMockShiprocket();
  return new ShiprocketAdapter({
    courierAccountId: '00000000-0000-0000-0000-0000000000a1',
    mode: 'TEST',
    email: MOCK_EMAIL,
    password: MOCK_PASSWORD,
    courierMap: { default: '39' },
    now: () => FIXED_NOW,
    fetchFn: mock.fetchFn,
    tokenCache: new InMemoryShiprocketTokenCache(),
  });
});
