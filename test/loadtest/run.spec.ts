import { describe, expect, it } from 'vitest';
import {
  budgetCheck,
  exitCodeForResults,
  ScenarioResult,
} from '../../scripts/loadtest/lib';

/**
 * §5.1 budget-breach → process exit code mapping (run.ts returns
 * exitCodeForResults; guard/usage errors are 2, handled at the CLI level).
 * One case per §5.1 budget line item.
 */
function resultWith(checks: ScenarioResult['checks']): ScenarioResult[] {
  return [{ scenario: checks[0]?.scenario ?? 'x', metrics: {}, checks }];
}

describe('exitCodeForResults', () => {
  it('is 0 when every §5.1 budget is met', () => {
    const results: ScenarioResult[] = [
      {
        scenario: 'tracking',
        metrics: { ackP99Ms: 42 },
        checks: [budgetCheck('tracking', 'webhook ack p99', '< 100 ms (§8.5)', 42, true)],
      },
      {
        scenario: 'dashboard',
        metrics: { p99Ms: 800 },
        checks: [budgetCheck('dashboard', 'read p99', '≤ 1000 ms (§5.1)', 800, true)],
      },
    ];
    expect(exitCodeForResults(results)).toBe(0);
    expect(exitCodeForResults([])).toBe(0);
  });

  it.each<[string, ScenarioResult['checks'][0]]>([
    ['tracking ack p99 > 100 ms (§8.5)',
      { scenario: 'tracking', check: 'webhook ack p99', budget: '< 100 ms (§8.5)', actual: '132 ms', ok: false }],
    ['bulk job failures (§5.1)',
      { scenario: 'bulk', check: 'failed orders', budget: '0 (§5.1, INV-20)', actual: '7', ok: false }],
    ['dashboard p99 > 1 s (§5.1)',
      { scenario: 'dashboard', check: 'read p99', budget: '≤ 1000 ms (§5.1)', actual: '1402 ms', ok: false }],
    ['duplicate AWB (INV-6)',
      { scenario: 'outage', check: 'duplicate AWBs after catch-up', budget: '0 (INV-6)', actual: '1', ok: false }],
  ])('is 1 on breach: %s', (_label, failingCheck) => {
    const passing = budgetCheck('tracking', 'webhook ack p99', '< 100 ms (§8.5)', 10, true);
    const results = [
      ...resultWith([passing]),
      ...resultWith([failingCheck]),
    ];
    expect(exitCodeForResults(results)).toBe(1);
  });
});
