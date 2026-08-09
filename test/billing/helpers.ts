import { Pool } from 'pg';
import { vi } from 'vitest';
import type {
  ActiveSubscription,
  CreateSubscriptionInput,
} from '../../src/modules/billing/shopify-billing.client';

/**
 * Test doubles for billing specs — the FnPool pattern from test/booking:
 * pattern-matched query handlers over a staged state machine, plus fakes for
 * Redis (in-memory NX/PX semantics) and the Shopify Billing boundary.
 */

export const SHOP_ID = '11111111-1111-1111-1111-111111111111';
export const MEMBER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
export const SUBSCRIPTION_ID = '99999999-9999-9999-9999-999999999999';
export const PLAN_TRIAL_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
export const PLAN_STARTER_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
export const PLAN_PRO_ID = '12121212-1212-1212-1212-121212121212';
export const SHIPMENT_ID = '33333333-3333-3333-3333-333333333333';
export const SHIPMENT_ID_2 = '34343434-3434-3434-3434-343434343434';
export const USAGE_GID = 'gid://shopify/AppUsageRecord/777';
export const SUB_GID = 'gid://shopify/AppSubscription/888';
export const USAGE_LINE_ITEM_GID = 'gid://shopify/AppSubscriptionLineItem/999';

export interface RecordedCall {
  sql: string;
  params: unknown[];
}

type HandlerResult = { rows: unknown[]; rowCount: number };
type Handler = (sql: string, params: unknown[]) => HandlerResult | undefined;

export class FnPool {
  readonly calls: RecordedCall[] = [];
  private readonly handlers: Array<{ pattern: RegExp; fn: Handler }> = [];

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
    // Last registration wins, so a test can override a beforeEach handler.
    for (let i = this.handlers.length - 1; i >= 0; i--) {
      const h = this.handlers[i];
      if (h.pattern.test(sql)) {
        const r = h.fn(sql, params ?? []);
        if (r) {
          return Promise.resolve({
            rows: r.rows as never[],
            rowCount: r.rowCount,
          });
        }
      }
    }
    return Promise.resolve({ rows: [] as never[], rowCount: 0 });
  };

  readonly connect = () =>
    Promise.resolve({
      query: this.query,
      release: () => undefined,
    });

  matching(pattern: RegExp): RecordedCall[] {
    return this.calls.filter((c) => pattern.test(c.sql));
  }

  asPool(): Pool {
    return this as unknown as Pool;
  }
}

/** In-memory Redis with the SET NX/PX semantics the alerts rely on. */
export function fakeRedis() {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    strings,
    sets,
    set: vi.fn(
      (
        key: string,
        value: string,
        _px?: string,
        _ttl?: number,
        nx?: string,
      ) => {
        if (nx === 'NX' && strings.has(key)) return Promise.resolve(null);
        strings.set(key, value);
        return Promise.resolve('OK');
      },
    ),
    get: vi.fn((key: string) => Promise.resolve(strings.get(key) ?? null)),
    del: vi.fn((key: string) => {
      const had = strings.delete(key);
      return Promise.resolve(had ? 1 : 0);
    }),
    sadd: vi.fn((key: string, member: string) => {
      const set = sets.get(key) ?? new Set<string>();
      const sizeBefore = set.size;
      set.add(member);
      sets.set(key, set);
      return Promise.resolve(set.size - sizeBefore);
    }),
    srem: vi.fn((key: string, member: string) => {
      const set = sets.get(key);
      return Promise.resolve(set && set.delete(member) ? 1 : 0);
    }),
    smembers: vi.fn((key: string) =>
      Promise.resolve(Array.from(sets.get(key) ?? [])),
    ),
  };
}

export function mockAudit() {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    record: vi.fn((entry: Record<string, unknown>) => {
      entries.push(entry);
      return Promise.resolve();
    }),
  };
}

export function mockLedger(consumed = 0) {
  return {
    allowanceBalance: vi.fn(() =>
      Promise.resolve({ debits: consumed, reversals: 0, consumed }),
    ),
  };
}

export function mockNotify() {
  const calls: Array<{ shopId: string; event: string; context: unknown }> = [];
  return {
    calls,
    notify: vi.fn(
      (shopId: string, event: string, context: unknown) => {
        calls.push({ shopId, event, context });
        return Promise.resolve({
          delivered: 1,
          suppressed: 0,
          digested: 0,
          skipped: false,
        });
      },
    ),
  };
}

/** The Shopify Billing boundary — records every charge attempt. */
export function mockShopifyBilling() {
  const usageCharges: Array<{
    shopId: string;
    lineItemId: string;
    amountRupees: string;
    description: string;
  }> = [];
  return {
    usageCharges,
    createSubscription: vi.fn(
      (_shopId: string, _input: CreateSubscriptionInput) =>
        Promise.resolve({
          subscriptionGid: SUB_GID,
          confirmationUrl: 'https://admin.shopify.com/charges/confirm',
        }),
    ),
    cancelSubscription: vi.fn((_shopId: string, _gid: string) =>
      Promise.resolve('CANCELLED'),
    ),
    activeSubscriptions: vi.fn(
      (_shopId: string): Promise<ActiveSubscription[]> =>
        Promise.resolve([
          {
            gid: SUB_GID,
            name: 'Jsyxi Starter',
            status: 'ACTIVE',
            createdAt: '2026-07-15T00:00:00.000Z',
            currentPeriodEnd: '2026-08-14T00:00:00.000Z',
            usageLineItemId: USAGE_LINE_ITEM_GID,
            cappedAmount: '500.00',
          },
        ]),
    ),
    createUsageRecord: vi.fn(
      (
        shopId: string,
        lineItemId: string,
        amountRupees: string,
        description: string,
      ) => {
        usageCharges.push({ shopId, lineItemId, amountRupees, description });
        return Promise.resolve(USAGE_GID);
      },
    ),
    listUsageRecordGids: vi.fn(() => Promise.resolve([USAGE_GID])),
  };
}

export function planRow(overrides: Record<string, unknown> = {}) {
  return {
    plan_id: PLAN_STARTER_ID,
    code: 'STARTER',
    name: 'Starter',
    awb_allowance_per_cycle: 500,
    price: '499.0000',
    currency: 'INR',
    overage_unit_price: '2.0000',
    is_trial: false,
    is_active: true,
    ...overrides,
  };
}

export function trialPlanRow() {
  return planRow({
    plan_id: PLAN_TRIAL_ID,
    code: 'TRIAL',
    name: 'Trial',
    awb_allowance_per_cycle: 50,
    price: '0.0000',
    overage_unit_price: '0.0000',
    is_trial: true,
  });
}

export function proPlanRow() {
  return planRow({
    plan_id: PLAN_PRO_ID,
    code: 'PRO',
    name: 'Pro',
    awb_allowance_per_cycle: 2000,
    price: '1499.0000',
    overage_unit_price: '1.5000',
  });
}

export function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    subscription_id: SUBSCRIPTION_ID,
    shop_id: SHOP_ID,
    plan_id: PLAN_STARTER_ID,
    shopify_subscription_gid: SUB_GID,
    cycle_start_at: '2026-07-01T00:00:00.000Z',
    cycle_end_at: '2026-07-31T00:00:00.000Z',
    state: 'ACTIVE',
    capped_amount: '500.0000',
    currency: 'INR',
    created_at: '2026-07-01T00:00:00.000Z',
    plan: planRow(),
    ...overrides,
  };
}

export function usageRecordRow(overrides: Record<string, unknown> = {}) {
  return {
    usage_id: 'abababab-abab-abab-abab-abababababab',
    shop_id: SHOP_ID,
    subscription_id: SUBSCRIPTION_ID,
    idempotency_key: `overage:${SHOP_ID}:${SHIPMENT_ID}:2026-07-01T00:00:00.000Z`,
    shopify_usage_record_gid: USAGE_GID,
    amount: '2.0000',
    currency: 'INR',
    state: 'ACCEPTED',
    submitted_at: '2026-07-10T00:00:00.000Z',
    created_at: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}
