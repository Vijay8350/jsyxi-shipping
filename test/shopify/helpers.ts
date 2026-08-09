import { vi } from 'vitest';
import { ConfigService } from '@nestjs/config';

/** Deterministic 32-byte master key for EnvelopeCipher in tests. */
export const TEST_MASTER_KEY_HEX = 'ab'.repeat(32);

export const TEST_CONFIG: Record<string, unknown> = {
  'shopify.apiKey': 'test_api_key',
  'shopify.apiSecret': 'test_api_secret',
  'shopify.scopes': ['read_orders', 'write_orders'],
  'shopify.appUrl': 'https://app.jsyxi.test',
  'shopify.apiUrl': 'https://api.jsyxi.test',
  'crypto.masterKeyHex': TEST_MASTER_KEY_HEX,
  'crypto.piiHashSalt': 'test-pii-salt',
  'session.ttlSeconds': 43200,
};

export function mockConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values = { ...TEST_CONFIG, ...overrides };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

interface Responder {
  pattern: RegExp;
  rows: unknown[];
}

/**
 * Pattern-matched mock Pool. Records every call (sql + params) so tests can
 * assert shop scoping (INV-1) and parameterization.
 */
export class MockPool {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  private readonly responders: Responder[] = [];

  on(pattern: RegExp, rows: unknown[]): this {
    this.responders.push({ pattern, rows });
    return this;
  }

  readonly query = (sql: string, params?: unknown[]) => {
    this.calls.push({ sql, params: params ?? [] });
    const r = this.responders.find((x) => x.pattern.test(sql));
    const rows = (r?.rows ?? []) as never[];
    return Promise.resolve({ rows, rowCount: rows.length });
  };

  matching(pattern: RegExp): Array<{ sql: string; params: unknown[] }> {
    return this.calls.filter((c) => pattern.test(c.sql));
  }
}

/** In-memory Redis stand-in honoring EX TTLs against Date.now(). */
export function createMockRedis() {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  const alive = (key: string): boolean => {
    const e = store.get(key);
    if (!e) return false;
    if (e.expiresAt !== undefined && e.expiresAt <= Date.now()) {
      store.delete(key);
      return false;
    }
    return true;
  };
  const api = {
    store,
    get: vi.fn((key: string) => Promise.resolve(alive(key) ? store.get(key)!.value : null)),
    set: vi.fn((key: string, value: string, ...args: unknown[]) => {
      let expiresAt: number | undefined;
      const exIdx = args.indexOf('EX');
      if (exIdx !== -1) expiresAt = Date.now() + Number(args[exIdx + 1]) * 1000;
      store.set(key, { value, expiresAt });
      return Promise.resolve('OK');
    }),
    getdel: vi.fn((key: string) => {
      const v = alive(key) ? store.get(key)!.value : null;
      store.delete(key);
      return Promise.resolve(v);
    }),
    del: vi.fn((key: string) => {
      const had = store.delete(key);
      return Promise.resolve(had ? 1 : 0);
    }),
  };
  return api;
}

/** Minimal fetch Response stand-in. */
export function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  } as unknown as Response;
}

export function stubFetch(impl: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('fetch', impl);
}
