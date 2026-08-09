import { Pool } from 'pg';
import { vi } from 'vitest';
import { BookingSnapshot } from '../../src/modules/booking/booking.types';
import { TariffInput } from '../../src/modules/rate-engine/pricing';
import { FreightColumnMap } from '../../src/modules/recon-freight/recon-freight.types';

/**
 * Test doubles for the recon-freight specs — the same FnPool pattern as
 * test/dashboard: regex-matched SQL handlers over a recorded call log.
 */

export const SHOP_ID = '11111111-1111-1111-1111-111111111111';
export const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
export const COURIER_ID = '33333333-3333-3333-3333-333333333333';
export const MAP_ID = '44444444-4444-4444-4444-444444444444';
export const BATCH_ID = '55555555-5555-5555-5555-555555555555';
export const ROW_ID = '66666666-6666-6666-6666-666666666666';
export const RCV_ID = '77777777-7777-7777-7777-777777777777';
export const SHIPMENT_ID = '88888888-8888-8888-8888-888888888888';
export const MEMBER_ID = '99999999-9999-9999-9999-999999999999';

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
      release: () => undefined,
    });

  matching(pattern: RegExp): RecordedCall[] {
    return this.calls.filter((c) => pattern.test(c.sql));
  }

  asPool(): Pool {
    return this as unknown as Pool;
  }
}

export function fakeAudit() {
  return { record: vi.fn(async () => undefined) };
}

export function fakeQueue() {
  return { enqueueProcessBatch: vi.fn(async () => undefined) };
}

export function fakeNotifications() {
  return { notify: vi.fn(async () => ({ delivered: 1, suppressed: 0, digested: 0, skipped: false })) };
}

/** In-memory object store with the LocalFilesystemObjectStore surface. */
export function fakeStore(hmac: (payload: string) => string) {
  const files = new Map<string, Buffer>();
  return {
    files,
    put: vi.fn(async (key: string, bytes: Buffer) => void files.set(key, bytes)),
    get: vi.fn(async (key: string) => {
      const b = files.get(key);
      if (!b) throw new Error(`no object: ${key}`);
      return b;
    }),
    getSignedUrl: vi.fn(async (key: string, ttlSeconds: number) => {
      const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
      const signature = hmac(`key:${key}:${expires}`);
      return `/recon/freight/exports/download?key=${encodeURIComponent(key)}&expires=${expires}&signature=${signature}`;
    }),
  };
}

/* ---------------------------------------------------------------------------
 * §4.4 worked example A fixtures — the tariff and snapshot behind AWB
 * DL0087412391 (Zone C, COD ₹2,000, F-3 1.000 kg, F-11 ₹158.59).
 * ------------------------------------------------------------------------- */

export const EXAMPLE_TARIFF: TariffInput = {
  fuelPct: '0.180000',
  codFlat: '35.00',
  codPct: '0.020000',
  gstPct: '0.180000',
  taxableComponents: ['F-5', 'F-6', 'F-7', 'F-8'],
  slabs: [
    {
      zone: 'C',
      baseWeightKg: '0.500',
      baseRate: '42.00',
      additionalStepKg: '0.500',
      additionalRate: '38.00',
    },
  ],
  components: [],
};

export function exampleSnapshot(overrides: Partial<BookingSnapshot> = {}): BookingSnapshot {
  return {
    schemaVersion: 1,
    frozenAt: '2026-07-01T10:00:00.000Z',
    recipient: null,
    lines: [],
    pickupLocation: null,
    packageProfile: null,
    payment: { mode: 'COD', collectible: '2000.00', currency: 'INR' },
    weights: {
      deadWeightKg: '0.420',
      lineWeightTotalKg: '0.380',
      usedDefaultParcelWeight: false,
      tareKg: '0.040',
      perLine: [],
      volumetricWeightKg: '1.000',
      rawChargeableKg: '1.000',
      billableWeightKg: '1.000',
    },
    service: {
      serviceId: 'svc-1',
      serviceVersionId: 'sv-1',
      code: 'SURFACE',
      name: 'Delhivery Surface',
      costSource: 'RATE_CARD',
      volumetricDivisor: '5000.0000',
      minBillableKg: '0.500',
      billableIncrementKg: '0.500',
    },
    courierAccount: { courierAccountId: ACCOUNT_ID, mode: 'LIVE' },
    rateCardVersionId: RCV_ID,
    zoneMapId: 'zm-1',
    zone: 'C',
    formulaInputs: {
      shipDate: '2026-07-01',
      pieces: 1,
      originPincode: '380015',
      destinationPincode: '110001',
      deadWeightKg: '0.420',
      lengthCm: '25.00',
      widthCm: '20.00',
      heightCm: '10.00',
      paymentMode: 'COD',
      collectible: '2000.00',
      declaredValue: '0.00',
      zone: 'C',
      billableWeightKg: '1.000',
    },
    expectedQuote: {
      costSource: 'RATE_CARD',
      components: [
        { code: 'F-5', label: 'Base freight', amount: '80.00', taxable: true },
        { code: 'F-6', label: 'Fuel surcharge', amount: '14.40', taxable: true },
        { code: 'F-7', label: 'COD charge', amount: '40.00', taxable: true },
        { code: 'F-10', label: 'GST', amount: '24.19', taxable: false },
      ],
      total: '158.59',
      currency: 'INR',
      rtoRule: { basis: 'SAME_AS_FORWARD', pct: null },
      eddFrom: null,
      eddTo: null,
      eddSource: null,
      providerQuoteRef: null,
      fetchedAt: '2026-07-01T09:59:00.000Z',
    },
    shopify: { orderGid: null, lineGids: [], fulfillmentOrderGids: [] },
    rule: null,
    ...overrides,
  };
}

/** A FREIGHT column map for the canonical header set. */
export function exampleColumnMap(overrides: Partial<FreightColumnMap> = {}): FreightColumnMap {
  return {
    columnMapId: MAP_ID,
    courierId: COURIER_ID,
    name: 'default',
    mappings: {
      awb: 'AWB',
      amount: 'Amount',
      weight: 'Weight',
      invoice_reference: 'Invoice Ref',
      shipper_company: 'Shipper',
    },
    chargeTypeColumn: 'Charge Type',
    chargeTypeValueMap: {
      forward: 'FORWARD',
      rto: 'RTO',
      'cod charges': 'COD_FEE',
      reattempt: 'REATTEMPT',
      adjustment: 'ADJUSTMENT',
    },
    ...overrides,
  };
}
