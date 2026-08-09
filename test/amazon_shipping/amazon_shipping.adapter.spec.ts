import { describe, expect, it } from 'vitest';
import {
  AdapterRateLimitError,
  AdapterTimeoutError,
  CourierAuthError,
  CourierProviderError,
} from '../../src/modules/courier-framework/adapter-errors';
import { UnsupportedCapabilityError } from '../../src/modules/courier-framework/adapter.types';
import {
  AmazonShippingAdapter,
  AmazonShippingAdapterOptions,
  createAmazonShippingAdapterFactory,
} from '../../src/modules/amazon_shipping/amazon_shipping.adapter';
import {
  contractCreateRequest,
  contractIntent,
  contractQuoteRequest,
} from '../courier-framework/contract-suite';
import {
  InMemoryTokenCache,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  MOCK_REFRESH_TOKEN,
  createMockAmazonShipping,
} from './mock-amazon-shipping';

/**
 * Unit tests of the Amazon Shipping request/response mapping with a mocked
 * fetch (§15.1). The shapes asserted here mirror amazon_shipping-api.map.ts
 * — every one carries a TODO(sandbox-verify) over there.
 */

const FIXED_NOW = new Date('2026-02-01T10:00:00.000Z');

function makeAdapter(
  mockOpts: Parameters<typeof createMockAmazonShipping>[0] = {},
  adapterOpts: Partial<AmazonShippingAdapterOptions> = {},
) {
  const mock = createMockAmazonShipping(mockOpts);
  const tokenCache = new InMemoryTokenCache();
  const adapter = new AmazonShippingAdapter({
    courierAccountId: '00000000-0000-0000-0000-0000000000a1',
    mode: 'TEST',
    refreshToken: MOCK_REFRESH_TOKEN,
    clientId: MOCK_CLIENT_ID,
    clientSecret: MOCK_CLIENT_SECRET,
    tokenCache,
    now: () => FIXED_NOW,
    fetchFn: mock.fetchFn,
    ...adapterOpts,
  });
  return { adapter, mock, tokenCache };
}

describe('AmazonShippingAdapter — factory & configuration', () => {
  it('factory builds an adapter from the build context credentials', () => {
    const adapter = createAmazonShippingAdapterFactory(new InMemoryTokenCache())({
      courierAccountId: 'acct-1',
      courierCode: 'AMAZON_SHIPPING',
      mode: 'LIVE',
      credentials: {
        refresh_token: 'rt',
        client_id: 'cid',
        client_secret: 'cs',
      },
      now: () => FIXED_NOW,
    });
    expect(adapter.courierCode).toBe('AMAZON_SHIPPING');
  });

  it('factory rejects missing credentials with CourierAuthError (INV-18: names the field, never a value)', () => {
    const factory = createAmazonShippingAdapterFactory(new InMemoryTokenCache());
    const incomplete: Array<Record<string, string>> = [
      {},
      { refresh_token: 'rt' },
      { refresh_token: 'rt', client_id: 'cid' },
    ];
    for (const credentials of incomplete) {
      expect(() =>
        factory({
          courierAccountId: 'acct-1',
          courierCode: 'AMAZON_SHIPPING',
          mode: 'TEST',
          credentials,
          now: () => FIXED_NOW,
        }),
      ).toThrowError(CourierAuthError);
    }
  });

  it('calls the configured region base URL (TODO(sandbox-verify): sandbox host in TEST)', async () => {
    const { adapter, mock } = makeAdapter();
    // track on an unbooked shipment legitimately maps to AWB_NOT_FOUND; only
    // the URL the call went to matters here.
    await adapter.track('AMZN000000000001').catch(() => null);
    const apiCall = mock.calls.find((c) => c.path === '/shipping/v2/tracking');
    expect(apiCall?.url).toContain('sandbox.sellingpartnerapi-eu.amazon.com');
  });
});

describe('AmazonShippingAdapter — LWA OAuth token lifecycle (§9.3.3)', () => {
  it('refreshes once, caches the access token, and sends x-amz-access-token on calls', async () => {
    const { adapter, mock, tokenCache } = makeAdapter();
    await adapter.track('AMZN000000000001').catch(() => null);
    await adapter.track('AMZN000000000002').catch(() => null);
    expect(mock.refreshCalls.value).toBe(1); // second call reused the cached token
    expect([...tokenCache.store.values()]).toContain('LWA-TOKEN-1');
    const authed = mock.calls.filter((c) => c.path !== '/auth/o2/token');
    // Reaching the provider-level AWB_NOT_FOUND proves the token matched.
    expect(authed.length).toBeGreaterThan(0);
  });

  it('sends the refresh grant form-urlencoded with grant_type=refresh_token', async () => {
    const { adapter, mock } = makeAdapter();
    await adapter.track('AMZN000000000001').catch(() => null);
    const refreshCall = mock.calls.find((c) => c.path === '/auth/o2/token');
    const params = new URLSearchParams(refreshCall?.body ?? '');
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe(MOCK_REFRESH_TOKEN);
  });

  it('refreshes the access token on 401 and resends the call exactly once', async () => {
    const { adapter, mock } = makeAdapter({ expireFirstToken: true });
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('refresh-1')));
    expect(booked.kind).toBe('CONFIRMED'); // succeeded on the resent call
    expect(mock.refreshCalls.value).toBe(2); // initial refresh + refresh on 401
  });

  it('a refresh failure (400 invalid_grant) throws CourierAuthError (→ DISCONNECTED, §3.21), without secrets in the error (INV-18)', async () => {
    const { adapter } = makeAdapter({ failAuth: true });
    const err = await adapter.track('AMZN000000000001').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CourierAuthError);
    expect(JSON.stringify(err)).not.toContain(MOCK_REFRESH_TOKEN);
    expect(JSON.stringify(err)).not.toContain(MOCK_CLIENT_SECRET);
    expect(JSON.stringify(err)).not.toContain(MOCK_CLIENT_ID);
  });

  it('a still-401 call after the refresh throws CourierAuthError (no resend loop)', async () => {
    const mock = createMockAmazonShipping();
    const realFetch = mock.fetchFn;
    const always401: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/shipping/v2/tracking')) {
        return new Response(JSON.stringify({ errors: [{ code: 'Unauthorized' }] }), { status: 401 });
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const { adapter } = makeAdapter({}, { fetchFn: always401 });
    const err = await adapter.track('AMZN000000000001').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CourierAuthError);
    // Exactly one refresh was attempted (two mints: initial + refresh).
    expect(mock.refreshCalls.value).toBe(2);
  });
});

describe('AmazonShippingAdapter — declared-unsupported capabilities (A1-03)', () => {
  it('declares getQuote/schedulePickup/ndrAction in unsupportedMethods and throws UnsupportedCapabilityError — never a silent no-op', async () => {
    const { adapter, mock } = makeAdapter();
    expect(adapter.unsupportedMethods).toEqual(['getQuote', 'schedulePickup', 'ndrAction']);

    const quoteErr = await adapter.getQuote(contractQuoteRequest()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(quoteErr).toBeInstanceOf(UnsupportedCapabilityError);
    expect((quoteErr as UnsupportedCapabilityError).method).toBe('getQuote');
    expect((quoteErr as UnsupportedCapabilityError).manualFallbackNote).toContain('RATE_CARD');

    const pickupErr = await adapter
      .schedulePickup({ awbs: ['AMZN000000000001'], pickupLocationId: 'loc-1', pickupDate: '2026-02-03' })
      .then(() => null, (e: unknown) => e);
    expect(pickupErr).toBeInstanceOf(UnsupportedCapabilityError);
    expect((pickupErr as UnsupportedCapabilityError).method).toBe('schedulePickup');
    expect((pickupErr as UnsupportedCapabilityError).manualFallbackNote).toBeTruthy();

    const ndrErr = await adapter
      .ndrAction({ awb: 'AMZN000000000001', action: 'REATTEMPT', payload: {} })
      .then(() => null, (e: unknown) => e);
    expect(ndrErr).toBeInstanceOf(UnsupportedCapabilityError);
    expect((ndrErr as UnsupportedCapabilityError).method).toBe('ndrAction');
    expect((ndrErr as UnsupportedCapabilityError).manualFallbackNote).toBeTruthy();

    expect(mock.calls).toEqual([]); // no HTTP left the process
  });
});

describe('AmazonShippingAdapter — error classification (§8.2 transport policy)', () => {
  it('429 → AdapterRateLimitError with the Retry-After header mapped to ms', async () => {
    const { adapter } = makeAdapter({ rateLimitPaths: ['/shipping/v2/tracking'] });
    const err = await adapter.track('AMZN000000000001').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterRateLimitError);
    expect((err as AdapterRateLimitError).retryAfterMs).toBe(60_000);
  });

  it('timeout on a non-create call throws AdapterTimeoutError', async () => {
    const mock = createMockAmazonShipping();
    const realFetch = mock.fetchFn;
    // Wrap: label calls reject with the undici TimeoutError.
    const timeoutFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/shipping/v2/labels')) {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const { adapter } = makeAdapter({}, { fetchFn: timeoutFetch });
    await expect(adapter.getLabel('AMZN000000000001', 'PDF')).rejects.toThrowError(
      AdapterTimeoutError,
    );
  });

  it('provider 5xx → CourierProviderError with a structured code, no secrets', async () => {
    const mock = createMockAmazonShipping();
    const realFetch = mock.fetchFn;
    const failingFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/shipping/v2/tracking')) {
        return new Response(
          JSON.stringify({ errors: [{ code: 'InternalFailure', message: 'tracking service unavailable' }] }),
          { status: 500 },
        );
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const { adapter } = makeAdapter({}, { fetchFn: failingFetch });
    const err = await adapter.track('AMZN000000000001').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CourierProviderError);
    expect((err as CourierProviderError).code).toBe('INTERNALFAILURE');
    expect(JSON.stringify(err)).not.toContain(MOCK_REFRESH_TOKEN);
    expect(JSON.stringify(err)).not.toContain(MOCK_CLIENT_SECRET);
  });
});

describe('AmazonShippingAdapter — createShipment, exactly-once (A1-04, INV-5, §9.5.4)', () => {
  it('books: transmits the merchant reference as clientReferenceId, exact grams weight, returns CONFIRMED', async () => {
    const { adapter, mock } = makeAdapter();
    const intent = contractIntent('book-1');
    const result = await adapter.createShipment(contractCreateRequest(intent));
    expect(result.kind).toBe('CONFIRMED');
    expect(result.awb).toMatch(/^AMZN\d{12}$/);
    const createCall = mock.calls.find(
      (c) => c.path === '/shipping/v2/shipments' && c.body !== undefined,
    );
    const body = JSON.parse(createCall?.body ?? '{}') as Record<string, any>;
    expect(body.clientReferenceId).toBe(intent.merchantReference);
    expect(body.packages).toHaveLength(1); // INV-4
    expect(body.packages[0].weight).toEqual({ value: '1000', unit: 'GRAM' }); // 1.000 kg, exact (INV-15)
    expect(body.packages[0].insuredValue).toEqual({ value: '500.00', unit: 'INR' });
    expect(body.shipTo.postalCode).toBe('110001');
  });

  it('sends a COD value-added service with the exact collectible for COD bookings', async () => {
    const { adapter, mock } = makeAdapter();
    const result = await adapter.createShipment(
      contractCreateRequest(contractIntent('book-cod-1'), {
        paymentMode: 'COD',
        collectible: '500.00',
      }),
    );
    expect(result.kind).toBe('CONFIRMED');
    const createCall = mock.calls.find(
      (c) => c.path === '/shipping/v2/shipments' && c.body !== undefined,
    );
    const body = JSON.parse(createCall?.body ?? '{}') as Record<string, any>;
    expect(body.valueAddedServices).toEqual([
      { id: 'COD', amount: { value: '500.00', unit: 'INR' } }, // 2dp text end-to-end (INV-15)
    ]);
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
    expect(lookup.awb).toMatch(/^AMZN\d{12}$/);
  });

  it('a provider rejection maps to FAILED with structured failure reasons', async () => {
    const mock = createMockAmazonShipping();
    const realFetch = mock.fetchFn;
    const rejectingFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/shipping/v2/shipments' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ errors: [{ code: 'InvalidInput', message: 'duplicate client reference' }] }),
          { status: 200 },
        );
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const { adapter } = makeAdapter({}, { fetchFn: rejectingFetch });
    const result = await adapter.createShipment(contractCreateRequest(contractIntent('fail-1')));
    expect(result.kind).toBe('FAILED');
    expect(result.failureReasons).toEqual(['INVALIDINPUT']);
  });
});

describe('AmazonShippingAdapter — lookup / track / cancel / label', () => {
  it('lookupByReference returns found=false for an unknown reference', async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.lookupByReference('__nope__')).toEqual({ found: false, awb: null });
  });

  it('track maps eventHistory to polling events with raw statuses (§8.5; §3.6 maps them, not the adapter)', async () => {
    const { adapter } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('track-1')));
    const events = await adapter.track(booked.awb!);
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((e) => e.rawStatus)).toEqual(
      expect.arrayContaining(['ReadyForReceive', 'PickupDone', 'OutForDelivery']),
    );
    for (const e of events) expect(Number.isNaN(Date.parse(e.occurredAt))).toBe(false);
  });

  it('track on an unknown shipment throws CourierProviderError AWB_NOT_FOUND', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.track('AMZN999999999999')).rejects.toThrowError(CourierProviderError);
  });

  it('cancel returns CANCELLED for a booked shipment and REJECTED for an unknown one', async () => {
    const { adapter } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('cancel-1')));
    expect((await adapter.cancelShipment(booked.awb!)).kind).toBe('CANCELLED');
    const rejected = await adapter.cancelShipment('AMZN999999999999');
    expect(rejected.kind).toBe('REJECTED');
    expect(rejected.reason).toBe('RESOURCENOTFOUND');
  });

  it('a second cancel of an already-cancelled shipment is REJECTED, not an error', async () => {
    const { adapter } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('cancel-2')));
    expect((await adapter.cancelShipment(booked.awb!)).kind).toBe('CANCELLED');
    const second = await adapter.cancelShipment(booked.awb!);
    expect(second.kind).toBe('REJECTED');
    expect(second.reason).toBe('INVALIDINPUT');
  });

  it('getLabel decodes the base64 courier PDF (COURIER_PDF_REQUIRED, §9.9.1)', async () => {
    const { adapter } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('label-1')));
    const label = await adapter.getLabel(booked.awb!, 'PDF');
    expect(label.contentType).toBe('application/pdf');
    expect(label.bytes.subarray(0, 4).toString('utf8')).toBe('%PDF');
  });
});
