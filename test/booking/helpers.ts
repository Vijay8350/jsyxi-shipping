import { Pool } from 'pg';
import type { BookingSnapshot } from '../../src/modules/booking/booking.types';

/**
 * Test doubles and fixtures for booking specs. FnPool extends the
 * test/order-sync MockTxPool pattern with function handlers, so responders
 * can read and mutate a staged state machine across multi-transaction flows
 * (queue → submit → confirm).
 */

export const SHOP_ID = '11111111-1111-1111-1111-111111111111';
export const ORDER_ID = '22222222-2222-2222-2222-222222222222';
export const SHIPMENT_ID = '33333333-3333-3333-3333-333333333333';
export const PICKUP_LOCATION_ID = '44444444-4444-4444-4444-444444444444';
export const PROFILE_ID = '55555555-5555-5555-5555-555555555555';
export const SERVICE_ID = '66666666-6666-6666-6666-666666666666';
export const SERVICE_VERSION_ID = '66666666-6666-6666-6666-666666666667';
export const MERCHANT_SERVICE_ID = '77777777-7777-7777-7777-777777777777';
export const COURIER_ACCOUNT_ID = '88888888-8888-8888-8888-888888888888';
export const SUBSCRIPTION_ID = '99999999-9999-9999-9999-999999999999';
export const INTENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const RATE_CARD_VERSION_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
export const ZONE_MAP_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
export const MEMBER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

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

export function validRecipient() {
  return {
    name: 'Asha Verma',
    addressLines: ['12, MG Road'],
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    phone: '9876543210',
    email: 'buyer@example.in',
  };
}

export function workingValues(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    recipient: validRecipient(),
    lines: [
      {
        orderLineId: 'l1',
        shopifyLineGid: 'gid://shopify/LineItem/1',
        sku: 'TEE-BLK-M',
        title: 'Cotton Tee',
        variant: 'Black / M',
        quantity: 2,
        unitPrice: '500.00',
        tags: ['summer'],
        hsnCode: '6109',
        weightKgPerUnit: '0.250',
      },
    ],
    payment: {
      mode: 'COD',
      gatewayNames: ['Cash on Delivery (COD)'],
      collectible: '1250.50',
    },
    fulfillment: {
      sourceFulfillmentOrderGids: ['gid://shopify/FulfillmentOrder/1'],
      shopifyLocationGid: 'gid://shopify/Location/1',
      mergePath: 'CONSOLIDATED',
    },
    weight: {
      deadWeightKg: '0.540',
      lineWeightTotalKg: '0.500',
      tareKg: '0.040',
      usedDefaultParcelWeight: false,
      lines: [
        {
          orderLineId: 'l1',
          sku: 'TEE-BLK-M',
          quantity: 2,
          perUnitWeightKg: '0.250',
          lineWeightKg: '0.500',
          source: 'SHOPIFY',
          noWeight: false,
        },
      ],
    },
    packageProfile: {
      packageProfileId: PROFILE_ID,
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

export function shipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    shipment_id: SHIPMENT_ID,
    shop_id: SHOP_ID,
    order_id: ORDER_ID,
    pickup_location_id: PICKUP_LOCATION_ID,
    service_id: SERVICE_ID,
    booking_state: 'DRAFT',
    working_values: workingValues(),
    collectible: '0.00',
    version: 3,
    created_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

export function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    order_id: ORDER_ID,
    shopify_order_gid: 'gid://shopify/Order/555000111',
    payment_mode: 'COD',
    cod_outstanding: '1250.50',
    order_amount: '1250.50',
    ...overrides,
  };
}

export function selectionRow(overrides: Record<string, unknown> = {}) {
  return {
    merchant_service_id: MERCHANT_SERVICE_ID,
    courier_account_id: COURIER_ACCOUNT_ID,
    service_id: SERVICE_ID,
    enabled: true,
    service_code: 'EXP',
    service_name: 'Express',
    cost_source: 'RATE_CARD',
    service_active: true,
    account_mode: 'LIVE',
    account_disabled_at: null,
    has_test_credentials: true,
    has_live_credentials: true,
    ...overrides,
  };
}

export function serviceVersionRow() {
  return {
    service_version_id: SERVICE_VERSION_ID,
    volumetric_divisor: '5000',
    min_billable_kg: '0.5',
    billable_increment_kg: '0.5',
  };
}

export function pickupRow() {
  return {
    pickup_location_id: PICKUP_LOCATION_ID,
    name: 'Main warehouse',
    contact_name: 'Ops',
    phone: '9800000000',
    address_lines: ['Plot 7, Industrial Area'],
    city: 'Ahmedabad',
    state: 'Gujarat',
    pincode: '380015',
    gstin: '24AAAAA0000A1Z5',
  };
}

export function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    subscription_id: SUBSCRIPTION_ID,
    cycle_start_at: '2026-07-01T00:00:00.000Z',
    capped_amount: null,
    awb_allowance_per_cycle: 50,
    ...overrides,
  };
}

export function rateCardQuote(overrides: Record<string, unknown> = {}) {
  return {
    serviceable: true,
    failureReasons: [] as string[],
    rateAvailable: true,
    components: [
      { code: 'F-5', label: 'Base freight', amount: '80.00', taxable: true },
      { code: 'F-6', label: 'Fuel surcharge', amount: '14.40', taxable: true },
    ],
    total: '94.40',
    currency: 'INR' as const,
    rtoRule: { basis: 'SAME_AS_FORWARD' as const, pct: null },
    eddFrom: null,
    eddTo: null,
    eddSource: null,
    fetchedAt: '2026-07-31T10:00:00.000Z',
    providerQuoteRef: null,
    capabilityFlags: [] as string[],
    ...overrides,
  };
}

/** A frozen snapshot as the worker reads it (jsonb already parsed). */
export function sampleSnapshot(overrides: Record<string, unknown> = {}): BookingSnapshot {
  return {
    schemaVersion: 1,
    frozenAt: '2026-07-31T10:00:00.000Z',
    recipient: validRecipient(),
    lines: [
      {
        orderLineId: 'l1',
        shopifyLineGid: 'gid://shopify/LineItem/1',
        sku: 'TEE-BLK-M',
        title: 'Cotton Tee',
        variant: 'Black / M',
        quantity: 2,
        unitPrice: '500.00',
        tags: ['summer'],
        hsnCode: '6109',
      },
    ],
    pickupLocation: {
      pickupLocationId: PICKUP_LOCATION_ID,
      name: 'Main warehouse',
      contactName: 'Ops',
      phone: '9800000000',
      addressLines: ['Plot 7, Industrial Area'],
      city: 'Ahmedabad',
      state: 'Gujarat',
      pincode: '380015',
      gstin: '24AAAAA0000A1Z5',
    },
    packageProfile: {
      packageProfileId: PROFILE_ID,
      lengthCm: '25.00',
      widthCm: '20.00',
      heightCm: '10.00',
      tareKg: '0.040',
      source: 'DEFAULT',
    },
    payment: { mode: 'COD', collectible: '1250.50', currency: 'INR' },
    weights: {
      deadWeightKg: '0.540',
      lineWeightTotalKg: '0.500',
      usedDefaultParcelWeight: false,
      tareKg: '0.040',
      perLine: [],
      volumetricWeightKg: '1.000',
      rawChargeableKg: '1.000',
      billableWeightKg: '1.000',
    },
    service: {
      serviceId: SERVICE_ID,
      serviceVersionId: SERVICE_VERSION_ID,
      code: 'EXP',
      name: 'Express',
      costSource: 'RATE_CARD',
      volumetricDivisor: '5000',
      minBillableKg: '0.5',
      billableIncrementKg: '0.5',
    },
    courierAccount: { courierAccountId: COURIER_ACCOUNT_ID, mode: 'LIVE' },
    rateCardVersionId: RATE_CARD_VERSION_ID,
    zoneMapId: ZONE_MAP_ID,
    zone: 'C',
    formulaInputs: {
      shipDate: '2026-07-31',
      pieces: 1,
      originPincode: '380015',
      destinationPincode: '560001',
      deadWeightKg: '0.540',
      lengthCm: '25.00',
      widthCm: '20.00',
      heightCm: '10.00',
      paymentMode: 'COD',
      collectible: '1250.50',
      declaredValue: '1250.50',
      zone: 'C',
      billableWeightKg: '1.000',
    },
    expectedQuote: {
      costSource: 'RATE_CARD',
      components: rateCardQuote().components,
      total: '94.40',
      currency: 'INR',
      rtoRule: { basis: 'SAME_AS_FORWARD', pct: null },
      eddFrom: null,
      eddTo: null,
      eddSource: null,
      providerQuoteRef: null,
      fetchedAt: '2026-07-31T10:00:00.000Z',
    },
    shopify: {
      orderGid: 'gid://shopify/Order/555000111',
      lineGids: ['gid://shopify/LineItem/1'],
      fulfillmentOrderGids: ['gid://shopify/FulfillmentOrder/1'],
    },
    rule: null,
    ...overrides,
  } as BookingSnapshot;
}
