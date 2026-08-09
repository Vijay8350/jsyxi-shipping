import { describe, expect, it } from 'vitest';
import {
  AdapterRateLimitError,
  AdapterTimeoutError,
  CourierAuthError,
  CourierProviderError,
} from '../../src/modules/courier-framework/adapter-errors';
import { UnsupportedCapabilityError } from '../../src/modules/courier-framework/adapter.types';
import {
  BluedartAdapter,
  BluedartAdapterOptions,
  createBluedartAdapterFactory,
  createInMemoryTokenCache,
} from '../../src/modules/bluedart/bluedart.adapter';
import { BLUEDART_NDR_FALLBACK_NOTE } from '../../src/modules/bluedart/bluedart-api.map';
import {
  contractCreateRequest,
  contractIntent,
  contractQuoteRequest,
} from '../courier-framework/contract-suite';
import {
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  createMockBluedart,
} from './mock-bluedart';

/**
 * Unit tests of the Blue Dart request/response mapping with a mocked fetch
 * (§15.1). The shapes asserted here mirror bluedart-api.map.ts — every one
 * carries a TODO(sandbox-verify) over there.
 */

const FIXED_NOW = new Date('2026-02-01T10:00:00.000Z');

function makeAdapter(
  mockOpts: Parameters<typeof createMockBluedart>[0] = {},
  adapterOpts: Partial<BluedartAdapterOptions> = {},
) {
  const mock = createMockBluedart(mockOpts);
  const adapter = new BluedartAdapter({
    courierAccountId: '00000000-0000-0000-0000-0000000000a1',
    mode: 'TEST',
    clientId: MOCK_CLIENT_ID,
    clientSecret: MOCK_CLIENT_SECRET,
    tokenCache: createInMemoryTokenCache(),
    now: () => FIXED_NOW,
    fetchFn: mock.fetchFn,
    ...adapterOpts,
  });
  return { adapter, mock };
}

describe('BluedartAdapter — factory & configuration', () => {
  it('factory builds an adapter from the build context credentials', () => {
    const adapter = createBluedartAdapterFactory(createInMemoryTokenCache())({
      courierAccountId: 'acct-1',
      courierCode: 'BLUEDART',
      mode: 'LIVE',
      credentials: { client_id: 'id', client_secret: 'secret-live' },
      now: () => FIXED_NOW,
    });
    expect(adapter.courierCode).toBe('BLUEDART');
  });

  it('factory rejects missing credentials with CourierAuthError (INV-18: names the field, never a value)', () => {
    const missing: Array<Record<string, string>> = [
      {},
      { client_id: 'id' },
      { client_secret: 'secret' },
    ];
    for (const credentials of missing) {
      expect(() =>
        createBluedartAdapterFactory(createInMemoryTokenCache())({
          courierAccountId: 'acct-1',
          courierCode: 'BLUEDART',
          mode: 'TEST',
          credentials,
          now: () => FIXED_NOW,
        }),
      ).toThrowError(CourierAuthError);
    }
  });

  it('points every call at the Blue Dart API gateway', async () => {
    // track on an unbooked AWB legitimately ends in AWB_NOT_FOUND; only the
    // URL the call went to matters here.
    const { adapter, mock } = makeAdapter();
    await adapter.track('BD000000001').catch(() => null);
    expect(mock.calls[0].url).toContain('apigateway.bluedart.com');
  });
});

describe('BluedartAdapter — token auth (login, Redis cache, 401 refresh)', () => {
  it('logs in once and reuses the cached JWT across calls', async () => {
    const { adapter, mock } = makeAdapter();
    await adapter.track('BD000000001').catch(() => null);
    await adapter.track('BD000000002').catch(() => null);
    await adapter.getQuote(contractQuoteRequest());
    expect(mock.loginCalls.value).toBe(1);
    // The login body carried the pasted credentials (never echoed back out).
    const loginCall = mock.calls.find((c) => c.path.includes('token/v1/login'));
    expect(JSON.parse(loginCall?.body ?? '{}')).toEqual({
      client_id: MOCK_CLIENT_ID,
      client_secret: MOCK_CLIENT_SECRET,
    });
  });

  it('a 401 invalidates the cached token, re-logs in and retries the call once', async () => {
    const { adapter, mock } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('auth-1')));
    expect(booked.kind).toBe('CONFIRMED');
    expect(mock.loginCalls.value).toBe(1);

    // Server-side the JWT expires; the next call gets 401, refreshes and
    // succeeds without the caller seeing an error.
    mock.expireAllTokens();
    const events = await adapter.track(booked.awb!);
    expect(events.length).toBeGreaterThan(0);
    expect(mock.loginCalls.value).toBe(2);
  });

  it('a failed refresh throws CourierAuthError (→ DISCONNECTED, §3.21), without credential values (INV-18)', async () => {
    const { adapter } = makeAdapter({ failLogin: true });
    const err = await adapter.track('BD000000001').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CourierAuthError);
    expect(JSON.stringify(err)).not.toContain(MOCK_CLIENT_SECRET);
    expect(JSON.stringify(err)).not.toContain(MOCK_CLIENT_ID);
  });

  it('a persistent 401 after refresh surfaces CourierAuthError', async () => {
    // The mock rejects every issued token immediately: each call 401s, the
    // adapter refreshes, the retry 401s again → CourierAuthError.
    const mock = createMockBluedart();
    const realFetch = mock.fetchFn;
    const revokingFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      mock.expireAllTokens();
      return realFetch(input as string, init);
    }) as typeof fetch;
    const adapter = new BluedartAdapter({
      courierAccountId: 'acct',
      mode: 'TEST',
      clientId: MOCK_CLIENT_ID,
      clientSecret: MOCK_CLIENT_SECRET,
      tokenCache: createInMemoryTokenCache(),
      now: () => FIXED_NOW,
      fetchFn: revokingFetch,
    });
    await expect(adapter.track('BD000000001')).rejects.toThrowError(CourierAuthError);
  });
});

describe('BluedartAdapter — getQuote (§8.3)', () => {
  it('maps a serviceable quote: components pass through unmarked (INV-23), total is the exact component sum (INV-15)', async () => {
    const { adapter } = makeAdapter();
    const quote = await adapter.getQuote(contractQuoteRequest());
    expect(quote.serviceable).toBe(true);
    expect(quote.failureReasons).toEqual([]);
    expect(quote.rateAvailable).toBe(true);
    expect(quote.currency).toBe('INR');
    expect(quote.components.map((c) => c.code)).toEqual(
      expect.arrayContaining(['BD_FREIGHT', 'BD_FUEL', 'BD_GST']),
    );
    for (const c of quote.components) expect(c.amount).toMatch(/^-?\d+\.\d{2}$/);
    // 64.40 + 9.60 + 0.00(COD) + 13.32 = 87.32
    expect(quote.total).toBe('87.32');
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

  it('maps COD parameters on the pricing request', async () => {
    const { adapter, mock } = makeAdapter();
    const quote = await adapter.getQuote(
      contractQuoteRequest({ paymentMode: 'COD', collectible: '500.00' }),
    );
    expect(quote.serviceable).toBe(true);
    expect(quote.components.map((c) => c.code)).toContain('BD_COD');
    expect(quote.total).toBe('122.32');
    const pricingCall = mock.calls.find((c) => c.path.includes('transitTimeAndPrice'));
    expect(pricingCall?.url).toContain('paymentType=COD');
    expect(pricingCall?.url).toContain('collectableAmount=500.00');
    expect(pricingCall?.url).toContain('weightKg=1.000'); // 3dp kg text, exact
  });

  it('flags COD_NOT_SERVICEABLE when the destination refuses COD', async () => {
    const { adapter } = makeAdapter({ codServiceable: false });
    const quote = await adapter.getQuote(
      contractQuoteRequest({ paymentMode: 'COD', collectible: '500.00' }),
    );
    expect(quote.serviceable).toBe(false);
    expect(quote.failureReasons).toEqual(['COD_NOT_SERVICEABLE']);
  });

  it('declares ndrAction unsupported and everything else supported (A1-03)', () => {
    const { adapter } = makeAdapter();
    expect(adapter.unsupportedMethods).toEqual(['ndrAction']);
  });
});

describe('BluedartAdapter — error classification (§8.2 transport policy)', () => {
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
    const mock = createMockBluedart();
    const realFetch = mock.fetchFn;
    // Wrap: label calls reject with the undici TimeoutError.
    const timeoutFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('GetGeneratedWaybill')) {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const adapter = new BluedartAdapter({
      courierAccountId: 'acct',
      mode: 'TEST',
      clientId: MOCK_CLIENT_ID,
      clientSecret: MOCK_CLIENT_SECRET,
      tokenCache: createInMemoryTokenCache(),
      now: () => FIXED_NOW,
      fetchFn: timeoutFetch,
    });
    await expect(adapter.getLabel('BD000000001', 'PDF')).rejects.toThrowError(
      AdapterTimeoutError,
    );
  });

  it('provider 5xx → CourierProviderError with a structured code, no secrets', async () => {
    const mock = createMockBluedart();
    const realFetch = mock.fetchFn;
    const failingFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('RegisterPickup')) {
        return new Response(JSON.stringify({ error: 'pickup service unavailable' }), { status: 500 });
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const adapter = new BluedartAdapter({
      courierAccountId: 'acct',
      mode: 'TEST',
      clientId: MOCK_CLIENT_ID,
      clientSecret: MOCK_CLIENT_SECRET,
      tokenCache: createInMemoryTokenCache(),
      now: () => FIXED_NOW,
      fetchFn: failingFetch,
    });
    const err = await adapter
      .schedulePickup({ awbs: ['BD000000001'], pickupLocationId: 'loc-1', pickupDate: '2026-02-03' })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CourierProviderError);
    expect((err as CourierProviderError).code).toBe('PICKUP_SERVICE_UNAVAILABLE');
    expect(JSON.stringify(err)).not.toContain(MOCK_CLIENT_SECRET);
  });
});

describe('BluedartAdapter — createShipment, exactly-once (A1-04, INV-5, §9.5.4)', () => {
  it('books: transmits the merchant reference as CreditReferenceNo, returns CONFIRMED', async () => {
    const { adapter, mock } = makeAdapter();
    const intent = contractIntent('book-1');
    const result = await adapter.createShipment(contractCreateRequest(intent));
    expect(result.kind).toBe('CONFIRMED');
    expect(result.awb).toMatch(/^BD\d{9}$/);
    const createCall = mock.calls.find((c) => c.path.includes('GenerateWayBill'));
    const body = JSON.parse(createCall?.body ?? '{}') as {
      Request: { Services: Record<string, string> };
    };
    expect(body.Request.Services.CreditReferenceNo).toBe(intent.merchantReference);
    expect(body.Request.Services.CollectableAmount).toBe('0.00'); // prepaid
    expect(body.Request.Services.PieceCount).toBe('1'); // INV-4
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
    expect(lookup.awb).toMatch(/^BD\d{9}$/);
  });

  it('a provider rejection maps to FAILED with structured failure reasons', async () => {
    const mock = createMockBluedart();
    const realFetch = mock.fetchFn;
    const rejectingFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('GenerateWayBill')) {
        return new Response(
          JSON.stringify({
            GenerateWayBillResult: {
              Status: [{ StatusType: 'Error', StatusInformation: 'Duplicate credit reference' }],
            },
          }),
          { status: 200 },
        );
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const adapter = new BluedartAdapter({
      courierAccountId: 'acct',
      mode: 'TEST',
      clientId: MOCK_CLIENT_ID,
      clientSecret: MOCK_CLIENT_SECRET,
      tokenCache: createInMemoryTokenCache(),
      now: () => FIXED_NOW,
      fetchFn: rejectingFetch,
    });
    const result = await adapter.createShipment(contractCreateRequest(contractIntent('fail-1')));
    expect(result.kind).toBe('FAILED');
    expect(result.failureReasons).toEqual(['DUPLICATE_CREDIT_REFERENCE']);
  });
});

describe('BluedartAdapter — lookup / track / cancel / label / pickup / NDR', () => {
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
      expect.arrayContaining(['Shipment Booked', 'Picked Up', 'In Transit']),
    );
    for (const e of events) expect(Number.isNaN(Date.parse(e.occurredAt))).toBe(false);
  });

  it('track on an unknown AWB throws CourierProviderError AWB_NOT_FOUND', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.track('BD999999999')).rejects.toThrowError(CourierProviderError);
  });

  it('cancel returns CANCELLED for a booked AWB and REJECTED for an unknown one', async () => {
    const { adapter } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('cancel-1')));
    expect((await adapter.cancelShipment(booked.awb!)).kind).toBe('CANCELLED');
    const rejected = await adapter.cancelShipment('BD999999999');
    expect(rejected.kind).toBe('REJECTED');
    expect(rejected.reason).toBe('WAYBILL_NOT_FOUND');
  });

  it('getLabel returns the courier PDF bytes (COURIER_PDF_REQUIRED, §9.9.1)', async () => {
    const { adapter } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('label-1')));
    const label = await adapter.getLabel(booked.awb!, 'PDF');
    expect(label.contentType).toBe('application/pdf');
    expect(label.bytes.subarray(0, 4).toString('utf8')).toBe('%PDF');
  });

  it('schedulePickup acknowledges with the provider confirmation number', async () => {
    const { adapter } = makeAdapter();
    const pickup = await adapter.schedulePickup({
      awbs: ['BD000000001'],
      pickupLocationId: 'loc-1',
      pickupDate: '2026-02-03',
    });
    expect(pickup.acknowledged).toBe(true);
    expect(pickup.providerPickupId).toBe('PKP-BD-MOCK-0001');
  });

  it('ndrAction is declared unsupported and throws UnsupportedCapabilityError with the manual fallback (A1-03)', async () => {
    const { adapter, mock } = makeAdapter();
    const err = await adapter
      .ndrAction({ awb: 'BD000000001', action: 'REATTEMPT', payload: {} })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedCapabilityError);
    const uce = err as UnsupportedCapabilityError;
    expect(uce.method).toBe('ndrAction');
    expect(uce.courierCode).toBe('BLUEDART');
    expect(uce.manualFallbackNote).toBe(BLUEDART_NDR_FALLBACK_NOTE);
    // Never a silent no-op: no NDR-shaped HTTP call left the adapter.
    expect(mock.calls.some((c) => c.path.toLowerCase().includes('ndr'))).toBe(false);
  });
});
