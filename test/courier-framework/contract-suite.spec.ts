import { FakeCourierAdapter } from '../../src/modules/courier-framework/fake/fake-courier-adapter';
import { runCourierContractSuite } from './contract-suite';

/**
 * §15.1 / §14 weeks 4–6 ordering: the contract suite runs against the
 * deterministic fake adapter FIRST and must pass — proving the suite
 * itself works before any real adapter is wired.
 *
 * Two runs cover both branches of the capability-aware suite:
 * - 'fake' — a fully capable fake: every functional path is exercised.
 * - 'fake-with-unsupported' — ndrAction declared unsupported (A1-03): the
 *   suite asserts UnsupportedCapabilityError for it and functional-tests
 *   the rest.
 *
 * A fixed injected clock keeps every run deterministic.
 */
const FIXED_NOW = new Date('2026-02-01T10:00:00.000Z');

runCourierContractSuite(
  'fake',
  () =>
    new FakeCourierAdapter(
      { quoteRateLimit: 5 }, // §15.1 rate limiting, exercised by the suite
      () => FIXED_NOW,
    ),
);

runCourierContractSuite(
  'fake-with-unsupported',
  () =>
    new FakeCourierAdapter(
      { quoteRateLimit: 5, unsupportedMethods: ['ndrAction'] },
      () => FIXED_NOW,
    ),
);
