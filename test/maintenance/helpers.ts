import { Pool } from 'pg';
import { vi } from 'vitest';

/** Shared doubles for maintenance specs — same style as test/health. */

export const NOW = new Date('2026-08-07T12:00:00Z');
export const SHOP = '11111111-1111-1111-1111-111111111111';
export const MEMBER = '22222222-2222-2222-2222-222222222222';

export interface FakeResult {
  rows?: unknown[];
  rowCount?: number;
}
export type Respond = (sql: string, params: unknown[]) => FakeResult;

/** No rows anywhere, every DELETE affects nothing. */
export const EMPTY: Respond = () => ({ rows: [], rowCount: 0 });

/**
 * A recording fake pg Pool. `connect()` returns a client that shares the
 * same query recorder, so transactional code paths (BEGIN/COMMIT/DELETEs)
 * are captured in the same call log as plain pool queries.
 */
export class FakePool {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];

  constructor(private readonly respond: Respond = EMPTY) {}

  readonly query = (sql: string, params?: unknown[]) => {
    const p = params ?? [];
    this.calls.push({ sql, params: p });
    const r = this.respond(sql, p);
    return Promise.resolve({
      rows: r.rows ?? [],
      rowCount: r.rowCount ?? r.rows?.length ?? 0,
    });
  };

  readonly connect = () =>
    Promise.resolve({ query: this.query, release: () => undefined });

  matching(pattern: RegExp) {
    return this.calls.filter((c) => pattern.test(c.sql));
  }
}

export function asPool(pool: unknown): Pool {
  return pool as unknown as Pool;
}

export function mockAudit() {
  const entries: unknown[] = [];
  return {
    entries,
    record: vi.fn(async (entry: unknown) => {
      entries.push(entry);
    }),
  };
}

export function mockErase() {
  const deleted: string[] = [];
  return {
    deleted,
    delete: vi.fn(async (key: string) => {
      deleted.push(key);
    }),
  };
}
