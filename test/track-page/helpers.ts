/** Shared fakes for the track-page suites — in-memory Redis + fixtures. */

/** Minimal ioredis surface the module uses: get/set/incr/expire/del. */
export class FakeRedis {
  store = new Map<string, string>();

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
    return this.store.delete(key) ? 1 : 0;
  }
}

export const SHOP = '11111111-1111-1111-1111-111111111111';
export const SHOP_B = '99999999-9999-9999-9999-999999999999';
export const MEMBER = '22222222-2222-2222-2222-222222222222';
export const SALT = 'test-pii-salt';
export const APP_URL = 'https://app.jsyxi.com';

/** ConfigService stub covering the keys the module reads. */
export function fakeConfig() {
  const values: Record<string, string> = {
    'crypto.piiHashSalt': SALT,
    'shopify.appUrl': APP_URL,
  };
  return { get: (key: string) => values[key] };
}

/** §2.9 snapshot fixture — recipient is PII the page must NEVER render. */
export const SNAPSHOT = {
  recipient: {
    name: 'Riya Sharma',
    addressLines: ['12 MG Road', 'Indiranagar'],
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    phone: '+91 98765 43210',
    email: 'riya@example.com',
  },
  lines: [
    {
      orderLineId: 'ol-1',
      sku: 'KUR-M-BLU',
      title: 'Cotton Kurta',
      variant: 'M / Blue',
      quantity: 2,
      unitPrice: '499.00',
    },
    {
      orderLineId: 'ol-2',
      sku: 'STO-GRN',
      title: 'Silk Stole',
      variant: null,
      quantity: 1,
      unitPrice: '299.00',
    },
  ],
  expectedQuote: {
    eddFrom: '2026-08-03',
    eddTo: '2026-08-05',
    eddSource: 'RATE_CARD_SLA',
    total: '450.00',
    currency: 'INR',
  },
};

export function shipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    shipment_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    shop_id: SHOP,
    order_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    movement_state: 'IN_TRANSIT',
    awb_raw: 'AWB 1234-X',
    is_test: false,
    snapshot: SNAPSHOT,
    courier_name: 'Delhivery',
    ...overrides,
  };
}
