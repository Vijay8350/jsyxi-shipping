import { Pool } from 'pg';
import Redis from 'ioredis';

/**
 * Test doubles for tracking specs, following the test/booking-ops FnPool
 * pattern: regex-matched SQL handlers over a recorded call log, a Map-backed
 * Redis fake, a stub audit writer and a stub raw-event queue.
 */

export const SHOP_ID = '11111111-1111-1111-1111-111111111111';
export const OTHER_SHOP_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
export const MEMBER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
export const ORDER_ID = '22222222-2222-2222-2222-222222222222';
export const SHIPMENT_ID = '33333333-3333-3333-3333-333333333333';
export const COURIER_ID = '77777777-7777-7777-7777-777777777777';
export const COURIER_ACCOUNT_ID = '88888888-8888-8888-8888-888888888888';
export const RAW_EVENT_ID = '99999999-9999-9999-9999-999999999999';
export const EVENT_ID = 'aaaaaaaa-0000-0000-0000-00000000000e';

export const AWB_RAW = 'dl-123 45';
export const AWB_NORMALIZED = 'DL12345';

export interface RecordedCall {
  sql: string;
  params: unknown[];
}

type HandlerResult = { rows: unknown[]; rowCount: number };
type Handler = (sql: string, params: unknown[]) => HandlerResult | undefined;

export class FnPool {
  readonly calls: RecordedCall[] = [];
  private readonly handlers: Array<{ pattern: RegExp; fn: Handler }> = [];
  releaseCount = 0;

  on(pattern: RegExp, rows: unknown[], rowCount?: number): this {
    this.handlers.push({
      pattern,
      fn: () => ({ rows, rowCount: rowCount ?? rows.length }),
    });
    return this;
  }

  onFn(pattern: RegExp, fn: Handler): this {
    this.handlers.push({ pattern, fn });
    return this;
  }

  readonly query = (sql: string, params?: unknown[]) => {
    this.calls.push({ sql, params: params ?? [] });
    for (const h of this.handlers) {
      if (h.pattern.test(sql)) {
        const r = h.fn(sql, params ?? []);
        if (r) return Promise.resolve({ rows: r.rows as never[], rowCount: r.rowCount });
      }
    }
    return Promise.resolve({ rows: [] as never[], rowCount: 0 });
  };

  readonly connect = () =>
    Promise.resolve({
      query: this.query,
      release: () => {
        this.releaseCount += 1;
      },
    });

  matching(pattern: RegExp): RecordedCall[] {
    return this.calls.filter((c) => pattern.test(c.sql));
  }

  /** Index of the first matching call in the log, or -1 (ordering checks). */
  firstIndexOf(pattern: RegExp): number {
    return this.calls.findIndex((c) => pattern.test(c.sql));
  }

  asPool(): Pool {
    return this as unknown as Pool;
  }
}

export class FakeRedis {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<string | null> {
    if (args.includes('NX') && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    const n = Number(this.store.get(key) ?? '0') + 1;
    this.store.set(key, String(n));
    return n;
  }

  async expire(): Promise<number> {
    return 1;
  }

  asRedis(): Redis {
    return this as unknown as Redis;
  }
}

export function mockAudit() {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    record: (entry: Record<string, unknown>) => {
      entries.push(entry);
      return Promise.resolve();
    },
  };
}

/** Captured queue: records enqueue order against the pool call log. */
export function stubQueue() {
  const enqueued: string[] = [];
  return {
    enqueued,
    enqueueRawEvent: (rawEventId: string) => {
      enqueued.push(rawEventId);
      return Promise.resolve();
    },
    schedulePollSweeps: () => Promise.resolve(),
  };
}

/** Canonical webhook payload (extractTrackEvent's alias coverage). */
export function webhookPayload(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'evt-1001',
    waybill: AWB_RAW,
    status: 'In Transit',
    timestamp: '2026-08-01T10:00:00.000Z',
    location: 'Bengaluru',
    reason: null,
    ...overrides,
  };
}

/** Same event WITHOUT a provider id — the §8.5 fingerprint path. */
export function fingerprintPayload(overrides: Record<string, unknown> = {}) {
  const p = webhookPayload(overrides);
  delete (p as Record<string, unknown>).event_id;
  return p;
}

export function rawEventRow(overrides: Record<string, unknown> = {}) {
  return {
    raw_event_id: RAW_EVENT_ID,
    shop_id: SHOP_ID,
    courier_account_id: COURIER_ACCOUNT_ID,
    awb_normalized: null,
    payload: webhookPayload(),
    received_at: '2026-08-01T10:00:01.000Z',
    source: 'WEBHOOK',
    signature_valid: true,
    dedupe_hash: 'pid:test',
    parse_result: 'PENDING',
    ...overrides,
  };
}

export function shipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    shipment_id: SHIPMENT_ID,
    shop_id: SHOP_ID,
    order_id: ORDER_ID,
    movement_state: 'NOT_SHIPPED',
    custody_state: 'PICKUP_PENDING',
    delivered_at: null,
    version: 1,
    ...overrides,
  };
}
