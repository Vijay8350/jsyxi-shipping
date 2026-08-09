import { describe, expect, it } from 'vitest';
import {
  AdapterRateLimitError,
  AdapterTimeoutError,
  CourierAuthError,
  CourierProviderError,
} from '../../src/modules/courier-framework/adapter-errors';
import { UnsupportedCapabilityError } from '../../src/modules/courier-framework/adapter.types';
import {
  DtdcAdapter,
  DtdcAdapterOptions,
  DTDC_NDR_MANUAL_FALLBACK_NOTE,
  dtdcAdapterFactory,
} from '../../src/modules/dtdc/dtdc.adapter';
import {
  contractCreateRequest,
  contractIntent,
  contractQuoteRequest,
} from '../courier-framework/contract-suite';
import { MOCK_API_KEY, createMockDtdc } from './mock-dtdc';

/**
 * Unit tests of the DTDC request/response mapping with a mocked fetch
 * (§15.1). The shapes asserted here mirror dtdc-api.map.ts — every one
 * carries a TODO(sandbox-verify) over there.
 */

const FIXED_NOW = new Date('2026-02-01T10:00:00.000Z');

function makeAdapter(
  mockOpts: Parameters<typeof createMockDtdc>[0] = {},
  adapterOpts: Partial<DtdcAdapterOptions> = {},
) {
  const mock = createMockDtdc(mockOpts);
  const adapter = new DtdcAdapter({
    courierAccountId: '00000000-0000-0000-0000-0000000000a1',
    mode: 'TEST',
    apiKey: MOCK_API_KEY,
    now: () => FIXED_NOW,
    fetchFn: mock.fetchFn,
    ...adapterOpts,
  });
  return { adapter, mock };
}

describe('DtdcAdapter — factory & configuration', () => {
  it('factory builds an adapter from the build context credentials', () => {
    const adapter = dtdcAdapterFactory({
      courierAccountId: 'acct-1',
      courierCode: 'DTDC',
      mode: 'LIVE',
      credentials: { api_key: 'secret-live-key' },
      now: () => FIXED_NOW,
    });
    expect(adapter.courierCode).toBe('DTDC');
  });

  it('factory rejects a missing api_key with CourierAuthError (INV-18: names the field, never a value)', () => {
    expect(() =>
      dtdcAdapterFactory({
        courierAccountId: 'acct-1',
        courierCode: 'DTDC',
        mode: 'TEST',
        credentials: {},
        now: () => FIXED_NOW,
      }),
    ).toThrowError(CourierAuthError);
  });

  it('calls the pxapi.dtdc.in host in both modes (single known host, TODO(sandbox-verify))', async () => {
    // track on an unbooked AWB legitimately parses to AWB_NOT_FOUND; only
    // the URL the call went to matters here.
    const { adapter: testAdapter, mock: testMock } = makeAdapter({}, { mode: 'TEST' });
    await testAdapter.track('DTDC000000001').catch(() => null);
    expect(testMock.calls[0].url).toContain('pxapi.dtdc.in');

    const { adapter: liveAdapter, mock: liveMock } = makeAdapter({}, { mode: 'LIVE' });
    await liveAdapter.track('DTDC000000001').catch(() => null);
    expect(liveMock.calls[0].url).toContain('pxapi.dtdc.in');
  });

  it('sends X-Access-Token: <api_key> on every call', async () => {
    const { adapter } = makeAdapter();
    // The harness answers 401 for any other key; reaching the
    // provider-level AWB_NOT_FOUND proves the header matched.
    await expect(adapter.track('NOPE')).rejects.toThrowError(CourierProviderError);
  });
});

describe('DtdcAdapter — getQuote (§8.3)', () => {
  it('maps a serviceable quote: components pass through unmarked (INV-23), total is the exact component sum (INV-15)', async () => {
    const { adapter } = makeAdapter();
    const quote = await adapter.getQuote(contractQuoteRequest());
    expect(quote.serviceable).toBe(true);
    expect(quote.failureReasons).toEqual([]);
    expect(quote.rateAvailable).toBe(true);
    expect(quote.currency).toBe('INR');
    expect(quote.components.map((c) => c.code)).toEqual(
      expect.arrayContaining(['DTDC_FREIGHT', 'DTDC_FUEL', 'DTDC_GST']),
    );
    for (const c of quote.components) expect(c.amount).toMatch(/^-?\d+\.\d{2}$/);
    // 52.50 + 8.25 + 0.00(COD) + 0.00(RTO) + 10.94 = 71.69
    expect(quote.total).toBe('71.69');
    expect(quote.eddTo).toBe('2026-02-06');
    expect(quote.eddSource).toBe('PROVIDER');
  });

  it('returns serviceable=false with structured failure reasons for an unserviceable destination', async () => {
    const { adapter } = makeAdapter();
    const quote = await adapter.getQuote(contractQuoteRequest({ destinationPincode: '999999' }));
    expect(quote.serviceable).toBe(false);
    expect(quote.failureReasons).toContain('DESTINATION_NOT_SERVICEABLE');
    expect(quote.rateAvailable).toBe(false);
    expect(quote.components).toEqual([]);
    expect(quote.total).toBe('0.00');
  });

  it('maps COD parameters on the calculator request', async () => {
    const { adapter, mock } = makeAdapter();
    const quote = await adapter.getQuote(
      contractQuoteRequest({ paymentMode: 'COD', collectible: '500.00' }),
    );
    expect(quote.serviceable).toBe(true);
    expect(quote.components.map((c) => c.code)).toContain('DTDC_COD');
    expect(quote.total).toBe('91.69');
    const calcCall = mock.calls.find((c) => c.path.includes('calculator'));
    const sent = JSON.parse(calcCall?.body ?? '{}') as Record<string, unknown>;
    expect(sent.payment_type).toBe('COD');
    expect(sent.cod_amount).toBe('500.00');
    expect(sent.weight).toBe('1.000'); // 3dp kg text passed through exactly (INV-15)
  });

  it('flags COD_NOT_SERVICEABLE when the destination refuses COD', async () => {
    const { adapter } = makeAdapter({ codServiceable: false });
    const quote = await adapter.getQuote(
      contractQuoteRequest({ paymentMode: 'COD', collectible: '500.00' }),
    );
    expect(quote.serviceable).toBe(false);
    expect(quote.failureReasons).toEqual(['COD_NOT_SERVICEABLE']);
  });

  it('declares ndrAction unsupported — never a silent no-op (A1-03)', () => {
    const { adapter } = makeAdapter();
    expect(adapter.unsupportedMethods).toEqual(['ndrAction']);
  });
});

describe('DtdcAdapter — error classification (§8.2 transport policy)', () => {
  it('401 → CourierAuthError, without the key anywhere in the error (INV-18)', async () => {
    const { adapter } = makeAdapter({ failAuth: true });
    const err = await adapter.track('DTDC000000001').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CourierAuthError);
    expect(JSON.stringify(err)).not.toContain(MOCK_API_KEY);
  });

  it('429 → AdapterRateLimitError with the Retry-After header mapped to ms', async () => {
    const { adapter } = makeAdapter({ quoteRateLimit: 1 });
    await adapter.getQuote(contractQuoteRequest()); // consumes the allowance
    const err = await adapter.getQuote(contractQuoteRequest()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterRateLimitError);
    expect((err as AdapterRateLimitError).retryAfterMs).toBe(60_000);
  });

  it('timeout on a non-create call throws AdapterTimeoutError', async () => {
    const mock = createMockDtdc();
    const realFetch = mock.fetchFn;
    // Label calls reject with the undici TimeoutError.
    const timeoutFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('operations/label')) {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const adapter = new DtdcAdapter({
      courierAccountId: 'acct',
      mode: 'TEST',
      apiKey: MOCK_API_KEY,
      now: () => FIXED_NOW,
      fetchFn: timeoutFetch,
    });
    await expect(adapter.getLabel('DTDC000000001', 'PDF')).rejects.toThrowError(
      AdapterTimeoutError,
    );
  });

  it('provider 5xx → CourierProviderError with a structured code, no secrets', async () => {
    const mock = createMockDtdc();
    const realFetch = mock.fetchFn;
    const failingFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('pickup/request')) {
        return new Response(JSON.stringify({ error: 'pickup service unavailable' }), { status: 500 });
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const adapter = new DtdcAdapter({
      courierAccountId: 'acct',
      mode: 'TEST',
      apiKey: MOCK_API_KEY,
      now: () => FIXED_NOW,
      fetchFn: failingFetch,
    });
    const err = await adapter
      .schedulePickup({ awbs: ['DTDC000000001'], pickupLocationId: 'loc-1', pickupDate: '2026-02-03' })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CourierProviderError);
    expect((err as CourierProviderError).code).toBe('PICKUP_SERVICE_UNAVAILABLE');
    expect(JSON.stringify(err)).not.toContain(MOCK_API_KEY);
  });
});

describe('DtdcAdapter — createShipment, exactly-once (A1-04, INV-5, §9.5.4)', () => {
  it('books: transmits the customer reference, returns CONFIRMED with the provider-confirmed charge (§3.25)', async () => {
    const { adapter, mock } = makeAdapter();
    const intent = contractIntent('book-1');
    const result = await adapter.createShipment(contractCreateRequest(intent));
    expect(result.kind).toBe('CONFIRMED');
    expect(result.awb).toMatch(/^DTDC\d{9}$/);
    expect(result.confirmedCharge).toBe('71.69');
    const createCall = mock.calls.find((c) =>
      c.path.includes('customer_awb_consignment_booking'),
    );
    const sent = JSON.parse(createCall?.body ?? '{}') as Record<string, unknown>;
    expect(sent.customer_reference_number).toBe(intent.merchantReference);
    expect(sent.payment_type).toBe('PREPAID');
  });

  it('a retried intent never issues a second create and returns the same outcome', async () => {
    const { adapter, mock } = makeAdapter();
    const intent = contractIntent('idem-1');
    const request = contractCreateRequest(intent);
    const first = await adapter.createShipment(request);
    const second = await adapter.createShipment(request);
    const third = await adapter.createShipment(request);
    expect(second.awb).toBe(first.awb);
    expect(third.awb).toBe(first.awb);
    expect(mock.createCalls.value).toBe(1);
    const creates = adapter.requestLog.filter(
      (r) => r.method === 'createShipment' && r.bookingIntentId === intent.bookingIntentId,
    );
    expect(creates.filter((r) => !r.deduplicated).length).toBe(1);
    expect(creates.filter((r) => r.deduplicated).length).toBe(2);
  });

  it('create timeout → OUTCOME_UNKNOWN, never a blind retry; lookupByReference resolves it (§9.5.4)', async () => {
    const { adapter } = makeAdapter();
    const intent = contractIntent('contract-timeout-1');
    const result = await adapter.createShipment(contractCreateRequest(intent));
    expect(result.kind).toBe('OUTCOME_UNKNOWN');
    expect(result.awb).toBeNull();

    // The same intent retried returns the cached OUTCOME_UNKNOWN — INV-5.
    const retry = await adapter.createShipment(contractCreateRequest(intent));
    expect(retry.kind).toBe('OUTCOME_UNKNOWN');

    const lookup = await adapter.lookupByReference(intent.merchantReference);
    expect(lookup.found).toBe(true);
    expect(lookup.awb).toMatch(/^DTDC\d{9}$/);
  });

  it('a provider rejection maps to FAILED with structured failure reasons', async () => {
    const mock = createMockDtdc();
    const realFetch = mock.fetchFn;
    const rejectingFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('customer_awb_consignment_booking')) {
        return new Response(
          JSON.stringify({ success: false, error: 'Duplicate reference number' }),
          { status: 200 },
        );
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const adapter = new DtdcAdapter({
      courierAccountId: 'acct',
      mode: 'TEST',
      apiKey: MOCK_API_KEY,
      now: () => FIXED_NOW,
      fetchFn: rejectingFetch,
    });
    const result = await adapter.createShipment(contractCreateRequest(contractIntent('fail-1')));
    expect(result.kind).toBe('FAILED');
    expect(result.failureReasons).toEqual(['DUPLICATE_REFERENCE_NUMBER']);
  });
});

describe('DtdcAdapter — lookup / track / cancel / label / pickup / NDR', () => {
  it('lookupByReference returns found=false for an unknown reference', async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.lookupByReference('__nope__')).toEqual({ found: false, awb: null });
  });

  it('track maps scans to polling events with raw statuses (§8.5; §3.6 maps them, not the adapter)', async () => {
    const { adapter } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('track-1')));
    const events = await adapter.track(booked.awb!);
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((e) => e.rawStatus)).toEqual(
      expect.arrayContaining(['Booked', 'Picked Up', 'In Transit']),
    );
    for (const e of events) expect(Number.isNaN(Date.parse(e.occurredAt))).toBe(false);
  });

  it('track on an unknown AWB throws CourierProviderError AWB_NOT_FOUND', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.track('DTDC999999999')).rejects.toThrowError(CourierProviderError);
  });

  it('cancel returns CANCELLED for a booked AWB and REJECTED for an unknown one', async () => {
    const { adapter } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('cancel-1')));
    expect((await adapter.cancelShipment(booked.awb!)).kind).toBe('CANCELLED');
    const rejected = await adapter.cancelShipment('DTDC999999999');
    expect(rejected.kind).toBe('REJECTED');
    expect(rejected.reason).toBe('CONSIGNMENT_NOT_FOUND');
  });

  it('getLabel returns PDF bytes', async () => {
    const { adapter } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('label-1')));
    const label = await adapter.getLabel(booked.awb!, 'PDF');
    expect(label.contentType).toBe('application/pdf');
    expect(label.bytes.subarray(0, 4).toString('utf8')).toBe('%PDF');
  });

  it('schedulePickup acknowledges with the provider pickup id', async () => {
    const { adapter } = makeAdapter();
    const pickup = await adapter.schedulePickup({
      awbs: ['DTDC000000001'],
      pickupLocationId: 'loc-1',
      pickupDate: '2026-02-03',
    });
    expect(pickup.acknowledged).toBe(true);
    expect(pickup.providerPickupId).toBe('DTDC-PKP-0001');
  });

  it('ndrAction throws UnsupportedCapabilityError with the manual fallback note (A1-03)', async () => {
    const { adapter } = makeAdapter();
    const err = await adapter
      .ndrAction({ awb: 'DTDC000000001', action: 'REATTEMPT', payload: {} })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedCapabilityError);
    expect((err as UnsupportedCapabilityError).method).toBe('ndrAction');
    expect((err as UnsupportedCapabilityError).courierCode).toBe('DTDC');
    expect((err as UnsupportedCapabilityError).manualFallbackNote).toBe(
      DTDC_NDR_MANUAL_FALLBACK_NOTE,
    );
  });
});
