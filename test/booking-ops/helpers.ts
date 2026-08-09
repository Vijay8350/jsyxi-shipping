import { Pool } from 'pg';
import Redis from 'ioredis';

/**
 * Test doubles for booking-ops specs, following the test/booking FnPool
 * pattern: regex-matched SQL handlers over a recorded call log, plus a
 * Map-backed Redis fake (counters, NX locks, TTL no-ops).
 */

export const SHOP_ID = '11111111-1111-1111-1111-111111111111';
export const OTHER_SHOP_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
export const MEMBER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
export const BATCH_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
export const ORDER_1 = '22222222-2222-2222-2222-222222222221';
export const ORDER_2 = '22222222-2222-2222-2222-222222222222';
export const ORDER_3 = '22222222-2222-2222-2222-222222222223';
export const SHIPMENT_1 = '33333333-3333-3333-3333-333333333331';
export const SHIPMENT_2 = '33333333-3333-3333-3333-333333333332';
export const SHIPMENT_3 = '33333333-3333-3333-3333-333333333333';
export const SERVICE_1 = '66666666-6666-6666-6666-666666666661';
export const SERVICE_2 = '66666666-6666-6666-6666-666666666662';
export const SERVICE_VERSION_1 = '66666666-6666-6666-6666-666666666671';
export const COURIER_ACCOUNT_1 = '88888888-8888-8888-8888-888888888881';
export const COURIER_ACCOUNT_2 = '88888888-8888-8888-8888-888888888882';
export const PICKUP_LOCATION_ID = '44444444-4444-4444-4444-444444444444';
export const RATE_CARD_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbc';
export const RATE_CARD_VERSION_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
export const DOCUMENT_ID = 'dddddddd-0000-0000-0000-00000000000d';
export const INTENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

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

  asPool(): Pool {
    return this as unknown as Pool;
  }
}

export class FakeRedis {
  readonly store = new Map<string, string>();

  async incr(key: string): Promise<number> {
    const n = Number(this.store.get(key) ?? '0') + 1;
    this.store.set(key, String(n));
    return n;
  }

  async decr(key: string): Promise<number> {
    const n = Number(this.store.get(key) ?? '0') - 1;
    this.store.set(key, String(n));
    return n;
  }

  async expire(): Promise<number> {
    return 1;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<string | null> {
    if (args.includes('NX') && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
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

/** Working values as the booking module reads them (week-4 shape). */
export function workingValues(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    recipient: {
      name: 'Asha Verma',
      addressLines: ['12, MG Road'],
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      phone: '9876543210',
      email: 'buyer@example.in',
    },
    lines: [],
    payment: { mode: 'COD', gatewayNames: ['COD'], collectible: '1250.50' },
    fulfillment: {
      sourceFulfillmentOrderGids: [],
      shopifyLocationGid: null,
      mergePath: 'CONSOLIDATED',
    },
    weight: {
      deadWeightKg: '0.540',
      lineWeightTotalKg: '0.500',
      tareKg: '0.040',
      usedDefaultParcelWeight: false,
      lines: [],
    },
    packageProfile: {
      packageProfileId: '55555555-5555-5555-5555-555555555555',
      source: 'DEFAULT',
      matchedRuleId: null,
      lengthCm: '25.00',
      widthCm: '20.00',
      heightCm: '10.00',
      tareKg: '0.040',
    },
    ...overrides,
  };
}

export function shipmentCandidate(overrides: Record<string, unknown> = {}) {
  return {
    shipment_id: SHIPMENT_1,
    order_id: ORDER_1,
    booking_state: 'DRAFT',
    service_id: SERVICE_1,
    pickup_location_id: PICKUP_LOCATION_ID,
    awb_normalized: null,
    working_values: workingValues(),
    ...overrides,
  };
}
