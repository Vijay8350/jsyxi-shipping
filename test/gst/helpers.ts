import { Pool } from 'pg';
import type { BookingSnapshot } from '../../src/modules/booking/booking.types';
import type {
  GstInvoiceLineRow,
  GstInvoiceRow,
  MissingField,
} from '../../src/modules/gst/gst.types';

/**
 * Test doubles for the GST specs — the same FnPool pattern as
 * test/order-sync / test/booking: regex-matched SQL handlers over a recorded
 * call log, with stateful handlers for multi-transaction flows.
 */

export const SHOP_ID = '11111111-1111-1111-1111-111111111111';
export const ORDER_ID = '22222222-2222-2222-2222-222222222222';
export const SHIPMENT_ID = '33333333-3333-3333-3333-333333333333';
export const INVOICE_ID = '44444444-4444-4444-4444-444444444444';
export const MEMBER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
export const GSTIN = '24AAAAA0000A1Z5';

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

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */

/** A frozen §2.9 booking snapshot as the worker stores it (parsed jsonb). */
export function snapshot(overrides: Record<string, unknown> = {}): BookingSnapshot {
  return {
    schemaVersion: 1,
    frozenAt: '2026-07-31T10:00:00.000Z',
    recipient: {
      name: 'Asha Verma',
      addressLines: ['12, MG Road'],
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      phone: '9876543210',
      email: null,
    },
    lines: [
      {
        orderLineId: 'l1',
        shopifyLineGid: 'gid://shopify/LineItem/1',
        sku: 'TEE-BLK-M',
        title: 'Cotton Tee',
        variant: 'Black / M',
        quantity: 2,
        unitPrice: '500.00',
        tags: [],
        hsnCode: '6109',
      },
    ],
    pickupLocation: {
      pickupLocationId: 'pl1',
      name: 'Jsyxi Apparel Pvt Ltd',
      contactName: 'Ops',
      phone: null,
      addressLines: ['Plot 7, Industrial Area'],
      city: 'Ahmedabad',
      state: 'Gujarat',
      pincode: '380015',
      gstin: GSTIN,
    },
    ...overrides,
  } as unknown as BookingSnapshot;
}

export function shipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    shipment_id: SHIPMENT_ID,
    shop_id: SHOP_ID,
    order_id: ORDER_ID,
    booking_state: 'CONFIRMED',
    is_test: false,
    snapshot: snapshot(),
    ...overrides,
  };
}

export function invoiceRow(overrides: Record<string, unknown> = {}): GstInvoiceRow {
  return {
    invoice_id: INVOICE_ID,
    shop_id: SHOP_ID,
    order_id: ORDER_ID,
    state: 'ISSUE_PENDING',
    series_code: 'INV',
    invoice_number: null,
    financial_year: null,
    issued_at: null,
    seller_snapshot: {
      legalName: 'Jsyxi Apparel Pvt Ltd',
      gstin: GSTIN,
      addressLines: ['Plot 7, Industrial Area'],
      city: 'Ahmedabad',
      state: 'Gujarat',
      pincode: '380015',
    },
    buyer_snapshot: {
      legalName: 'Asha Verma',
      gstin: null,
      addressLines: ['12, MG Road'],
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
    },
    place_of_supply: 'Karnataka',
    totals: null,
    currency: 'INR',
    missing_fields: [] as MissingField[],
    void_of_invoice_id: null,
    version: 1,
    created_at: '2026-07-31T10:00:00.000Z',
    updated_at: '2026-07-31T10:00:00.000Z',
    ...overrides,
  };
}

export function lineRow(overrides: Record<string, unknown> = {}): GstInvoiceLineRow {
  return {
    invoice_line_id: 'il1',
    invoice_id: INVOICE_ID,
    order_line_id: 'l1',
    hsn_code: '6109',
    quantity: 2,
    taxable_value: '1000.00',
    tax_components: [{ type: 'IGST', rate: '0.180000', amount: '180.00' }],
    line_total: '1180.00',
    ...overrides,
  };
}
