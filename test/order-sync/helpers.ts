/**
 * Test doubles for order-sync specs. The MockTxPool extends the pattern in
 * test/shopify/helpers.ts with connect()/BEGIN/COMMIT so transactional
 * services run against the same pattern-matched responders.
 */

export interface RecordedCall {
  sql: string;
  params: unknown[];
}

interface Responder {
  pattern: RegExp;
  rows: unknown[];
}

export class MockTxPool {
  readonly calls: RecordedCall[] = [];
  private readonly responders: Responder[] = [];
  releaseCount = 0;

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

  /** Assert INV-1: every data statement carries the shop id as a param. */
  callsWithParam(value: unknown): RecordedCall[] {
    return this.calls.filter((c) => c.params.includes(value));
  }
}

export const SHOP_ID = '11111111-1111-1111-1111-111111111111';
export const ORDER_ID = '22222222-2222-2222-2222-222222222222';
export const ORDER_GID = 'gid://shopify/Order/555000111';

/** A full REST-webhook-shaped order payload for mapper/ingest tests. */
export function sampleOrderPayload() {
  return {
    id: 555000111,
    admin_graphql_api_id: ORDER_GID,
    order_number: 1042,
    name: '#1042',
    created_at: '2026-07-20T10:15:00+05:30',
    email: 'buyer@example.in',
    test: false,
    current_total_price_set: {
      shop_money: { amount: '1250.50', currency_code: 'INR' },
      presentment_money: { amount: '1250.50', currency_code: 'INR' },
    },
    payment_gateway_names: ['Cash on Delivery (COD)'],
    risk_level: 'HIGH',
    shipping_address: {
      name: 'Asha Verma',
      address1: '12, MG Road',
      address2: 'Near Metro Gate 3',
      city: 'Bengaluru',
      province: 'Karnataka',
      zip: '560001',
      phone: '9876543210',
    },
    shipping_lines: [
      {
        title: 'Express',
        price_set: { shop_money: { amount: '80.00', currency_code: 'INR' } },
      },
    ],
    line_items: [
      {
        id: 9001,
        admin_graphql_api_id: 'gid://shopify/LineItem/9001',
        sku: 'TEE-BLK-M',
        title: 'Cotton Tee',
        variant_title: 'Black / M',
        quantity: 2,
        price: '500.00',
        price_set: { shop_money: { amount: '500.00', currency_code: 'INR' } },
        tags: 'summer, bestseller',
        grams: 250,
        hsn_code: '6109',
      },
      {
        id: 9002,
        admin_graphql_api_id: 'gid://shopify/LineItem/9002',
        sku: null,
        title: 'Gift Wrap',
        variant_title: null,
        quantity: 1,
        price: '170.50',
        price_set: { shop_money: { amount: '170.50', currency_code: 'INR' } },
        tags: '',
        grams: 0,
      },
    ],
  };
}

export function mockAudit() {
  const entries: unknown[] = [];
  return {
    entries,
    record: (entry: unknown) => {
      entries.push(entry);
      return Promise.resolve();
    },
  };
}
