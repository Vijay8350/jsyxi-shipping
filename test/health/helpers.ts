import { Pool } from 'pg';
import { vi } from 'vitest';
import { SetupHealthInput } from '../../src/modules/health/setup-health.service';

/** Shared fixtures/doubles for health specs. MockTxPool / mockAudit are
 *  reused from test/order-sync/helpers. */

export const NOW = new Date('2026-08-06T12:00:00Z');

/** A fully-healthy ADD-29 input — flip one field per test to break a single
 *  item. */
export function healthyInput(
  overrides: Partial<SetupHealthInput> = {},
): SetupHealthInput {
  return {
    pickupLocation: {
      name: 'Main Warehouse',
      address_lines: ['42, Industrial Estate'],
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      phone: '9876543210',
      gstin: '29ABCDE1234F1Z5',
    },
    courierAccounts: [
      {
        health_state: 'HEALTHY',
        has_webhook_secret: true,
        last_event_received_at: '2026-08-06T10:00:00Z',
      },
    ],
    enabledServices: [
      { service_id: 'svc-1', courier_account_id: 'ca-1', cost_source: 'RATE_CARD' },
    ],
    rateCards: [{ service_id: 'svc-1', courier_account_id: 'ca-1' }],
    defaultChain: ['svc-1'],
    hasLabelTemplate: true,
    hasDefaultPackageProfile: true,
    subscriptionState: 'ACTIVE',
    now: NOW,
    ...overrides,
  };
}

/** Item states keyed by item_key for concise assertions. */
export function statesOf(
  items: Array<{ itemKey: string; state: string }>,
): Record<string, string> {
  return Object.fromEntries(items.map((i) => [i.itemKey, i.state]));
}

/**
 * A stateful fake pool for setup_health_item: emulates the upsert semantics
 * (first_detected_at written on insert, preserved on conflict; updated_at
 * always bumped) so recompute behaviour is testable without PostgreSQL.
 * All other statements respond with the provided row sets.
 */
export class FakeHealthPool {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  readonly stored = new Map<
    string,
    { state: string; detail: string | null; first: string; updated: string }
  >();
  private tick = 0;

  constructor(private readonly respond: (sql: string) => unknown[]) {}

  readonly query = (sql: string, params?: unknown[]) => {
    this.calls.push({ sql, params: params ?? [] });
    if (/INSERT INTO setup_health_item/.test(sql)) {
      const [shopId, itemKey, state, detail] = params as [
        string,
        string,
        string,
        string | null,
      ];
      const key = `${shopId}:${itemKey}`;
      this.tick += 1;
      const stamp = `2026-08-06T12:00:${String(this.tick).padStart(2, '0')}Z`;
      const existing = this.stored.get(key);
      this.stored.set(key, {
        state,
        detail,
        first: existing?.first ?? stamp, // ON CONFLICT keeps first_detected_at
        updated: stamp,
      });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (/DELETE FROM setup_health_item/.test(sql)) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (/SELECT item_key, state, detail/.test(sql)) {
      const shopId = (params as [string])[0];
      const rows = [...this.stored.entries()]
        .filter(([k]) => k.startsWith(`${shopId}:`))
        .map(([k, v]) => ({
          item_key: k.slice(shopId.length + 1),
          state: v.state,
          detail: v.detail,
          first_detected_at: v.first,
          updated_at: v.updated,
        }));
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    const rows = this.respond(sql);
    return Promise.resolve({ rows, rowCount: rows.length });
  };

  matching(pattern: RegExp) {
    return this.calls.filter((c) => pattern.test(c.sql));
  }
}

/** Responders for the eight loadInput queries of a fully-healthy shop. */
export function healthyLoadResponder(sql: string): unknown[] {
  if (/FROM pickup_location/.test(sql)) {
    return [
      {
        name: 'Main Warehouse',
        address_lines: ['42, Industrial Estate'],
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560001',
        phone: '9876543210',
        gstin: '29ABCDE1234F1Z5',
      },
    ];
  }
  if (/FROM courier_account/.test(sql)) {
    return [
      {
        health_state: 'HEALTHY',
        has_webhook_secret: true,
        last_event_received_at: '2026-08-06T10:00:00Z',
      },
    ];
  }
  if (/FROM merchant_service/.test(sql)) {
    return [
      { service_id: 'svc-1', courier_account_id: 'ca-1', cost_source: 'RATE_CARD' },
    ];
  }
  if (/FROM rate_card/.test(sql)) {
    return [{ service_id: 'svc-1', courier_account_id: 'ca-1' }];
  }
  if (/FROM order_sync_settings/.test(sql)) return [{ default_chain: ['svc-1'] }];
  if (/FROM label_template/.test(sql)) return [{ present: 1 }];
  if (/FROM package_profile/.test(sql)) return [{ present: 1 }];
  if (/FROM subscription/.test(sql)) return [{ state: 'ACTIVE' }];
  return [];
}

export function asPool(pool: unknown): Pool {
  return pool as unknown as Pool;
}

export function mockRedis() {
  return {
    scan: vi.fn(
      async (_cursor: string, ..._args: unknown[]): Promise<[string, string[]]> => [
        '0',
        [],
      ],
    ),
    del: vi.fn(async (..._keys: string[]) => 0),
  };
}
