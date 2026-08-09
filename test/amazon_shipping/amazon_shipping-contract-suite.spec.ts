import { AmazonShippingAdapter } from '../../src/modules/amazon_shipping/amazon_shipping.adapter';
import { runCourierContractSuite } from '../courier-framework/contract-suite';
import {
  InMemoryTokenCache,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  MOCK_REFRESH_TOKEN,
  createMockAmazonShipping,
} from './mock-amazon-shipping';

/**
 * §15.1: the courier contract suite run against the Amazon Shipping adapter
 * with a scripted mock Amazon Shipping server (mock-amazon-shipping.ts)
 * implementing the suite's conventions:
 * - 'contract-timeout-' intents produce OUTCOME_UNKNOWN resolvable via
 *   lookupByReference (INV-5);
 * - the adapter's requestLog proves A1-04 idempotency (one create issued
 *   across retries of the same intent);
 * - getQuote, schedulePickup and ndrAction are declared unsupported (A1-03)
 *   — Amazon Shipping Services are RATE_CARD (§3.7), pickups auto-collect
 *   under most contracts, and no NDR endpoint is mapped at v1 — so the
 *   suite asserts the UnsupportedCapabilityError throws instead of
 *   functional-testing quotes, pickups, NDR actions and rate limiting.
 *
 * A fixed injected clock keeps every run deterministic; an in-memory token
 * cache stands in for Redis.
 */
const FIXED_NOW = new Date('2026-02-01T10:00:00.000Z');

runCourierContractSuite('amazon_shipping', () => {
  const mock = createMockAmazonShipping();
  return new AmazonShippingAdapter({
    courierAccountId: '00000000-0000-0000-0000-0000000000a1',
    mode: 'TEST',
    refreshToken: MOCK_REFRESH_TOKEN,
    clientId: MOCK_CLIENT_ID,
    clientSecret: MOCK_CLIENT_SECRET,
    tokenCache: new InMemoryTokenCache(),
    now: () => FIXED_NOW,
    fetchFn: mock.fetchFn,
  });
});
