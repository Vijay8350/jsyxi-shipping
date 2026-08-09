import { vi } from 'vitest';

/** Shared fakes for the notifications suites — in-memory Redis + fixtures. */

export class FakeRedis {
  store = new Map<string, string>();
  lists = new Map<string, string[]>();

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  async set(key: string, value: string): Promise<string> {
    this.store.set(key, value);
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    const next = Number(this.store.get(key) ?? 0) + 1;
    this.store.set(key, String(next));
    return next;
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }

  async del(key: string): Promise<number> {
    const had = this.store.delete(key) || this.lists.delete(key);
    return had ? 1 : 0;
  }

  async rpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  }
}

export const SHOP = '11111111-1111-1111-1111-111111111111';
export const OWNER = '22222222-2222-2222-2222-222222222222';
export const OPERATOR = '33333333-3333-3333-3333-333333333333';
export const FINANCE = '44444444-4444-4444-4444-444444444444';
export const SHIPMENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const ORDER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
export const NDR_CASE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
export const SALT = 'test-pii-salt';
export const APP_URL = 'https://app.jsyxi.com';
/** 32-byte master key for EnvelopeCipher tests. */
export const MASTER_KEY_HEX = 'ab'.repeat(32);

export function fakeConfig() {
  const values: Record<string, string> = {
    'crypto.piiHashSalt': SALT,
    'crypto.masterKeyHex': MASTER_KEY_HEX,
    'shopify.appUrl': APP_URL,
    nodeEnv: 'test',
  };
  return { get: (key: string) => values[key] };
}

/** A query mock whose behaviour is routed by SQL substring matchers. */
export function routedQuery(
  routes: Array<[string | RegExp, (sql: string, params: unknown[]) => unknown]>,
) {
  return vi.fn(async (sql: string, params: unknown[] = []) => {
    for (const [match, handler] of routes) {
      const hit =
        typeof match === 'string' ? sql.includes(match) : match.test(sql);
      if (hit) return handler(sql, params);
    }
    return { rows: [], rowCount: 0 };
  });
}

export const MEMBER_ROWS = [
  {
    member_id: OWNER,
    role: 'OWNER',
    email: 'owner@shop.example',
    last_active_at: null,
  },
  {
    member_id: OPERATOR,
    role: 'OPERATOR',
    email: 'ops@shop.example',
    last_active_at: null,
  },
  {
    member_id: FINANCE,
    role: 'FINANCE',
    email: 'fin@shop.example',
    last_active_at: null,
  },
];
