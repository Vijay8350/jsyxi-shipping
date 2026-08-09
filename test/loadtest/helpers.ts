import { Queryable, RedisLike } from '../../scripts/loadtest/lib';

/**
 * Recording test doubles for the load harness specs — the same FnPool-style
 * pattern as test/booking-ops/helpers.ts: regex-matched SQL handlers over a
 * recorded call log, so specs assert both the SQL shape and the parameters.
 */

export interface RecordedQuery {
  text: string;
  params: unknown[];
}

export type SqlHandler = (params: unknown[]) => { rows: any[]; rowCount?: number };

export class FakeDb implements Queryable {
  readonly queries: RecordedQuery[] = [];
  private handlers: Array<{ pattern: RegExp; handler: SqlHandler }> = [];

  on(pattern: RegExp, handler: SqlHandler): this {
    // Later registrations win, so a spec can override a shared wiring helper.
    this.handlers.unshift({ pattern, handler });
    return this;
  }

  async query(text: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number | null }> {
    this.queries.push({ text, params });
    for (const { pattern, handler } of this.handlers) {
      if (pattern.test(text)) {
        const result = handler(params);
        return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
      }
    }
    return { rows: [], rowCount: 0 };
  }

  /** All parameter sets recorded for statements matching the pattern. */
  paramsFor(pattern: RegExp): unknown[][] {
    return this.queries.filter((q) => pattern.test(q.text)).map((q) => q.params);
  }

  textFor(pattern: RegExp): string[] {
    return this.queries.filter((q) => pattern.test(q.text)).map((q) => q.text);
  }
}

export class FakeRedis implements RedisLike {
  readonly hashes = new Map<string, Map<string, string>>();
  readonly deleted: string[] = [];
  /** Full hset history — survives del, so specs can assert pause→restore. */
  readonly hsets: Array<{ key: string; field: string; value: string }> = [];

  async hset(key: string, field: string, value: string): Promise<number> {
    this.hsets.push({ key, field, value });
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    h.set(field, value);
    return 1;
  }

  async del(key: string): Promise<number> {
    this.deleted.push(key);
    return this.hashes.delete(key) ? 1 : 0;
  }
}

export const MASTER_KEY_HEX = 'a'.repeat(64); // 32 zero-nibbled bytes, valid hex

export const SHOP = {
  shopId: '11111111-1111-1111-1111-111111111111',
  memberId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  sessionToken: 'session-token',
  courierAccountId: '88888888-8888-8888-8888-888888888881',
  merchantServiceId: '66666666-6666-6666-6666-666666666661',
  serviceId: '66666666-6666-6666-6666-666666666662',
  pickupLocationId: '44444444-4444-4444-4444-444444444444',
  packageProfileId: '44444444-4444-4444-4444-444444444445',
  webhookUrlToken: 'lt_test_token',
  webhookSecret: 'webhook-secret',
  orderIds: ['22222222-2222-2222-2222-222222222221'],
};
