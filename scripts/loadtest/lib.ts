import { createHmac } from 'node:crypto';

/**
 * Load-test harness shared library (spec.md §5.1 capacity envelope).
 *
 * Everything in this file is pure / dependency-injected so the harness logic
 * is unit-testable without a live stack (test/loadtest/). The live wiring
 * (pg Pool, ioredis, global fetch) happens in run.ts.
 *
 * §5.1 budgets enforced by evaluateBudgets():
 *  - tracking webhook ack p99 < 100 ms        (§8.5)
 *  - bulk jobs: no failed orders              (§9.5.2, INV-20)
 *  - dashboard read p99 ≤ 1 s at 250 readers  (§5.1 dashboard line item)
 *  - zero duplicate AWBs after any scenario   (INV-6)
 */

/* -------------------------------------------------------------------------
 * Localhost guard — the harness inserts LIVE-mode (is_test = false, INV-19)
 * fixtures and drives real queue workers. It must NEVER run against a
 * non-local database.
 * ---------------------------------------------------------------------- */

export class LoadtestGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoadtestGuardError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Hard guard: throws unless the given DATABASE_URL points at localhost.
 * Accepts postgres/postgresql URLs; a bare empty host (Unix-domain socket
 * DSN such as postgres:///dbname) is also local and allowed.
 */
export function assertLocalDatabaseUrl(databaseUrl: string): void {
  if (!databaseUrl || databaseUrl.trim() === '') {
    throw new LoadtestGuardError('DATABASE_URL is empty; refusing to run the load harness');
  }
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new LoadtestGuardError(
      `DATABASE_URL is not a parseable URL; refusing to run the load harness`,
    );
  }
  if (host === '') return; // Unix-domain socket DSN — local by definition.
  if (!LOCAL_HOSTS.has(host.toLowerCase())) {
    throw new LoadtestGuardError(
      `refusing to run the load harness against non-local database host '${host}' — ` +
        `fixtures are LIVE-mode (is_test = false, INV-19) and are only safe on a disposable local DB`,
    );
  }
}

/* -------------------------------------------------------------------------
 * Latency statistics (nearest-rank percentiles — deterministic, testable).
 * ---------------------------------------------------------------------- */

export interface LatencyStats {
  count: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

/** Nearest-rank percentile over ascending-sorted values; 0 for empty input. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (p <= 0) return sortedAsc[0] as number;
  if (p >= 100) return sortedAsc[sortedAsc.length - 1] as number;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.max(0, Math.min(sortedAsc.length - 1, rank - 1))] as number;
}

export function computeLatencyStats(latenciesMs: number[]): LatencyStats {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count,
    minMs: count ? (sorted[0] as number) : 0,
    maxMs: count ? (sorted[count - 1] as number) : 0,
    meanMs: count ? sum / count : 0,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
  };
}

/* -------------------------------------------------------------------------
 * §8.5 webhook signing — must match src/common/crypto.ts hmacSha256Hex.
 * ---------------------------------------------------------------------- */

export function hmacSha256Hex(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Canonical fake-courier webhook payload (consumed by tracking.util's
 *  extractTrackEvent keys: awb / status / occurred_at / event_id / location). */
export interface TrackingWebhookPayload {
  event_id: string;
  awb: string;
  status: string;
  occurred_at: string;
  location: string;
}

export function buildTrackingWebhookPayload(input: {
  runId: string;
  seq: number;
  awb: string;
  status: string;
  occurredAt: string;
  location?: string;
}): TrackingWebhookPayload {
  return {
    // Unique per event → every payload is a NEW dedupe key (a repeat would
    // land as DUPLICATE and skew the convergence count).
    event_id: `LT-${input.runId}-${input.seq}`,
    awb: input.awb,
    status: input.status,
    occurred_at: input.occurredAt,
    location: input.location ?? 'Loadtest Hub',
  };
}

/* -------------------------------------------------------------------------
 * Injectable fetch type (global fetch satisfies this structurally).
 * ---------------------------------------------------------------------- */

export interface FetchResponseLike {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponseLike>;

/* -------------------------------------------------------------------------
 * Minimal DB / Redis interfaces — run.ts passes the real pg Pool / ioredis
 * client; tests pass recording fakes (no vi.mock needed).
 * ---------------------------------------------------------------------- */

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface RedisLike {
  hset(key: string, field: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/* -------------------------------------------------------------------------
 * §5.1 budget evaluation + result table.
 * ---------------------------------------------------------------------- */

export interface BudgetCheck {
  scenario: string;
  check: string;
  budget: string;
  actual: string;
  ok: boolean;
}

export interface ScenarioResult {
  scenario: string;
  /** Free-form measured stats; printed as key=value pairs. */
  metrics: Record<string, number | string>;
  checks: BudgetCheck[];
}

export function budgetCheck(
  scenario: string,
  check: string,
  budget: string,
  actual: number,
  ok: boolean,
  format: (v: number) => string = (v) => String(v),
): BudgetCheck {
  return { scenario, check, budget, actual: format(actual), ok };
}

export function anyBreach(results: ScenarioResult[]): boolean {
  return results.some((r) => r.checks.some((c) => !c.ok));
}

/** §5.1 budget-breach exit code: 1 when any check fails, else 0.
 *  (Usage/guard errors are 2, raised separately by run.ts.) */
export function exitCodeForResults(results: ScenarioResult[]): 0 | 1 {
  return anyBreach(results) ? 1 : 0;
}

/** Compact result table for the console; one row per budget check. */
export function formatResultTable(results: ScenarioResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const metrics = Object.entries(r.metrics)
      .map(([k, v]) => `${k}=${typeof v === 'number' ? round2(v) : v}`)
      .join(' ');
    lines.push(`[${r.scenario}] ${metrics}`);
    for (const c of r.checks) {
      lines.push(
        `  ${c.ok ? 'PASS' : 'FAIL'}  ${c.check}: budget ${c.budget}, actual ${c.actual}`,
      );
    }
  }
  return lines.join('\n');
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Monotonic-ish sleep helper exported for tests. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a predicate until it holds or the deadline passes. Returns the wait
 * in ms, or null on timeout. Used for post-hoc convergence measurements
 * (tracking normalization lag, booking-queue drain).
 */
export async function pollUntil(
  predicate: () => Promise<boolean>,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<number | null> {
  const start = Date.now();
  const interval = opts.intervalMs ?? 250;
  for (;;) {
    if (await predicate()) return Date.now() - start;
    if (Date.now() - start >= opts.timeoutMs) return null;
    await sleep(interval);
  }
}
