import { vi } from 'vitest';

export const SHOP_ID = '11111111-1111-1111-1111-111111111111';
export const OWNER_ID = '22222222-2222-2222-2222-222222222222';
export const COURIER_ID = '33333333-3333-3333-3333-333333333333';
export const ACCOUNT_ID = '44444444-4444-4444-4444-444444444444';
export const SERVICE_ID = '55555555-5555-5555-5555-555555555555';

/** A fixed 32-byte master key for envelope-crypto tests (test-only value). */
export const MASTER_KEY_HEX = 'ab'.repeat(32);

/** A Pool mock where every query handler is matched on a SQL substring. */
export function mockPool() {
  const client = { query: vi.fn(), release: vi.fn() };
  const pool = {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue(client),
  };
  return { pool, client };
}

/** Route mock queries by SQL substring. */
export function routeBySql(
  mock: ReturnType<typeof vi.fn>,
  routes: Array<[string, (params?: unknown[]) => unknown]>,
) {
  mock.mockImplementation((sql: string, params?: unknown[]) => {
    for (const [needle, handler] of routes) {
      if (sql.includes(needle)) return handler(params);
    }
    throw new Error(`unmocked query: ${sql}`);
  });
}

export function mockConfig(values: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    'crypto.masterKeyHex': MASTER_KEY_HEX,
    'shopify.apiUrl': 'https://api.jsyxi.test',
    ...values,
  };
  return { get: vi.fn((key: string) => all[key]) };
}

export function mockAudit() {
  return { record: vi.fn().mockResolvedValue(undefined) };
}

/**
 * In-memory Redis stand-in implementing just the surface the transport
 * policy and webhook stats use — including a JS evaluation of the token
 * bucket Lua script so limiter tests run the real algorithm.
 */
export function mockRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const strings = new Map<string, string>();

  const redis = {
    hget: vi.fn(async (key: string, field: string) => hashes.get(key)?.get(field) ?? null),
    hset: vi.fn(async (key: string, field: string, value: string) => {
      if (!hashes.has(key)) hashes.set(key, new Map());
      hashes.get(key)!.set(field, value);
      return 1;
    }),
    hgetall: vi.fn(async (key: string) => {
      const h = hashes.get(key);
      if (!h) return {};
      return Object.fromEntries(h.entries());
    }),
    hincrby: vi.fn(async (key: string, field: string, by: number) => {
      if (!hashes.has(key)) hashes.set(key, new Map());
      const next = Number(hashes.get(key)!.get(field) ?? 0) + by;
      hashes.get(key)!.set(field, String(next));
      return next;
    }),
    incr: vi.fn(async (key: string) => {
      const next = Number(strings.get(key) ?? 0) + 1;
      strings.set(key, String(next));
      return next;
    }),
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => strings.get(k) ?? null)),
    del: vi.fn(async (key: string) => {
      const had = hashes.delete(key) || strings.delete(key);
      return had ? 1 : 0;
    }),
    expire: vi.fn(async () => 1),
    pexpire: vi.fn(async () => 1),
    // JS mirror of TOKEN_BUCKET_LUA (transport-policy.ts). Keep in sync.
    eval: vi.fn(
      async (
        _script: string,
        _nkeys: number,
        key: string,
        capacityS: string,
        refillPerMsS: string,
        costS: string,
        floorS: string,
        nowS: string,
      ) => {
        const capacity = Number(capacityS);
        const refillPerMs = Number(refillPerMsS);
        const cost = Number(costS);
        const floor = Number(floorS);
        const now = Number(nowS);
        const h = hashes.get(key);
        let tokens = h?.get('tokens') !== undefined ? Number(h!.get('tokens')) : capacity;
        const ts = h?.get('ts') !== undefined ? Number(h!.get('ts')) : now;
        tokens = Math.min(capacity, tokens + (now - ts) * refillPerMs);
        if (!hashes.has(key)) hashes.set(key, new Map());
        if (tokens - cost >= floor) {
          hashes.get(key)!.set('tokens', String(tokens - cost));
          hashes.get(key)!.set('ts', String(now));
          return [1, 0];
        }
        hashes.get(key)!.set('tokens', String(tokens));
        hashes.get(key)!.set('ts', String(now));
        return [0, Math.ceil((floor + cost - tokens) / refillPerMs)];
      },
    ),
  };
  return redis;
}
