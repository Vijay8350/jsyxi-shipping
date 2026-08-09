import { describe, expect, it } from 'vitest';
import {
  computeLatencyStats,
  hmacSha256Hex,
  percentile,
  buildTrackingWebhookPayload,
  formatResultTable,
  anyBreach,
  ScenarioResult,
} from '../../scripts/loadtest/lib';

/** Stats math: nearest-rank percentiles must be exact and deterministic. */
describe('computeLatencyStats', () => {
  it('handles empty input without NaN', () => {
    const s = computeLatencyStats([]);
    expect(s).toEqual({
      count: 0, minMs: 0, maxMs: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0,
    });
  });

  it('computes exact percentiles on a known distribution', () => {
    // 1..100 ms: nearest-rank p50 = 50, p95 = 95, p99 = 99.
    const lat = Array.from({ length: 100 }, (_, i) => i + 1);
    const s = computeLatencyStats(lat);
    expect(s.count).toBe(100);
    expect(s.minMs).toBe(1);
    expect(s.maxMs).toBe(100);
    expect(s.meanMs).toBe(50.5);
    expect(s.p50Ms).toBe(50);
    expect(s.p95Ms).toBe(95);
    expect(s.p99Ms).toBe(99);
  });

  it('is order-independent (sorts internally)', () => {
    const a = computeLatencyStats([9, 1, 5, 3, 7]);
    expect(a.p50Ms).toBe(5);
    expect(a.minMs).toBe(1);
    expect(a.maxMs).toBe(9);
  });

  it('nearest-rank edge cases', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([42], 99)).toBe(42);
    expect(percentile([1, 2], 50)).toBe(1); // ceil(0.5*2)=1 → first element
    expect(percentile([1, 2], 100)).toBe(2);
    expect(percentile([1, 2], 0)).toBe(1);
  });
});

describe('hmacSha256Hex', () => {
  it('matches the app’s §8.5 signature scheme (HMAC-SHA256 hex over raw body)', () => {
    // Independently computed (openssl dgst -sha256 -hmac) — the same contract
    // as src/common/crypto.ts hmacSha256Hex, which the webhook controller
    // verifies with safeEqualHex.
    expect(hmacSha256Hex('secret', 'body')).toBe(
      'dc46983557fea127b43af721467eb9b3fde2338fe3e14f51952aa8478c13d355',
    );
    expect(hmacSha256Hex('secret', 'body')).not.toBe(hmacSha256Hex('secret', 'body2'));
    expect(hmacSha256Hex('secret', Buffer.from('body'))).toBe(hmacSha256Hex('secret', 'body'));
  });
});

describe('buildTrackingWebhookPayload', () => {
  it('emits the canonical extractor keys with unique event ids', () => {
    const p1 = buildTrackingWebhookPayload({
      runId: 'abc', seq: 1, awb: 'FAKE0000000001', status: 'IN_TRANSIT',
      occurredAt: '2026-08-07T00:00:00.000Z',
    });
    const p2 = buildTrackingWebhookPayload({
      runId: 'abc', seq: 2, awb: 'FAKE0000000001', status: 'IN_TRANSIT',
      occurredAt: '2026-08-07T00:00:00.000Z',
    });
    // tracking.util extractTrackEvent keys: event_id / awb / status / occurred_at.
    expect(p1).toMatchObject({
      event_id: 'LT-abc-1',
      awb: 'FAKE0000000001',
      status: 'IN_TRANSIT',
      occurred_at: '2026-08-07T00:00:00.000Z',
    });
    expect(p1.event_id).not.toBe(p2.event_id); // unique → no DUPLICATE skew
  });
});

describe('result table + breach aggregation', () => {
  const results: ScenarioResult[] = [
    {
      scenario: 'tracking',
      metrics: { sent: 10, ackP99Ms: 42.123 },
      checks: [
        { scenario: 'tracking', check: 'webhook ack p99', budget: '< 100 ms (§8.5)', actual: '42.12 ms', ok: true },
      ],
    },
    {
      scenario: 'outage',
      metrics: { duplicateAwbs: 2 },
      checks: [
        { scenario: 'outage', check: 'duplicate AWBs after catch-up', budget: '0 (INV-6)', actual: '2', ok: false },
      ],
    },
  ];

  it('anyBreach reflects failing checks only', () => {
    expect(anyBreach(results)).toBe(true);
    expect(anyBreach([results[0] as ScenarioResult])).toBe(false);
    expect(anyBreach([])).toBe(false);
  });

  it('formatResultTable renders PASS/FAIL rows and rounded metrics', () => {
    const table = formatResultTable(results);
    expect(table).toContain('[tracking] sent=10 ackP99Ms=42.12');
    expect(table).toContain('PASS  webhook ack p99: budget < 100 ms (§8.5), actual 42.12 ms');
    expect(table).toContain('FAIL  duplicate AWBs after catch-up: budget 0 (INV-6), actual 2');
  });
});
