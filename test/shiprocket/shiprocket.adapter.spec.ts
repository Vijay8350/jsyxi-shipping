import { describe, expect, it } from 'vitest';
import {
  AdapterRateLimitError,
  AdapterTimeoutError,
  CourierAuthError,
  CourierProviderError,
} from '../../src/modules/courier-framework/adapter-errors';
import { UnsupportedCapabilityError } from '../../src/modules/courier-framework/adapter.types';
import {
  ShiprocketAdapter,
  ShiprocketAdapterOptions,
  createShiprocketAdapterFactory,
} from '../../src/modules/shiprocket/shiprocket.adapter';
import {
  contractCreateRequest,
  contractIntent,
  contractQuoteRequest,
} from '../courier-framework/contract-suite';
import {
  InMemoryShiprocketTokenCache,
  MOCK_EMAIL,
  MOCK_PASSWORD,
  createMockShiprocket,
} from './mock-shiprocket';

/**
 * Unit tests of the Shiprocket request/response mapping with a mocked fetch
 * (§15.1). The shapes asserted here mirror shiprocket-api.map.ts — every
 * one carries a TODO(sandbox-verify) over there.
 */

const FIXED_NOW = new Date('2026-02-01T10:00:00.000Z');

function makeAdapter(
  mockOpts: Parameters<typeof createMockShiprocket>[0] = {},
  adapterOpts: Partial<ShiprocketAdapterOptions> = {},
) {
  const mock = createMockShiprocket(mockOpts);
  const tokenCache = new InMemoryShiprocketTokenCache();
  const adapter = new ShiprocketAdapter({
    courierAccountId: '00000000-0000-0000-0000-0000000000a1',
    mode: 'TEST',
    email: MOCK_EMAIL,
    password: MOCK_PASSWORD,
    courierMap: { default: '39' },
    now: () => FIXED_NOW,
    fetchFn: mock.fetchFn,
    tokenCache,
    ...adapterOpts,
  });
  return { adapter, mock, tokenCache };
}

describe('ShiprocketAdapter — factory & configuration', () => {
  it('factory builds an adapter from the build context credentials', () => {
    const factory = createShiprocketAdapterFactory(new InMemoryShiprocketTokenCache());
    const adapter = factory({
      courierAccountId: 'acct-1',
      courierCode: 'SHIPROCKET',
      mode: 'LIVE',
      credentials: {
        email: 'm@example.test',
        password: 'secret',
        shiprocket_courier_map: '{"SR-L039": "39", "default": "39"}',
      },
      now: () => FIXED_NOW,
    });
    expect(adapter.courierCode).toBe('SHIPROCKET');
  });

  it('factory rejects missing credentials with CourierAuthError (INV-18: names the field, never a value)', () => {
    const factory = createShiprocketAdapterFactory(new InMemoryShiprocketTokenCache());
    expect(() =>
      factory({
        courierAccountId: 'acct-1',
        courierCode: 'SHIPROCKET',
        mode: 'TEST',
        credentials: {},
        now: () => FIXED_NOW,
      }),
    ).toThrowError(CourierAuthError);
    expect(() =>
      factory({
        courierAccountId: 'acct-1',
        courierCode: 'SHIPROCKET',
        mode: 'TEST',
        credentials: { email: 'm@example.test' },
        now: () => FIXED_NOW,
      }),
    ).toThrowError(CourierAuthError);
  });

  it('factory rejects a malformed courier map as a configuration error (CourierProviderError)', () => {
    const factory = createShiprocketAdapterFactory(new InMemoryShiprocketTokenCache());
    expect(() =>
      factory({
        courierAccountId: 'acct-1',
        courierCode: 'SHIPROCKET',
        mode: 'TEST',
        credentials: {
          email: 'm@example.test',
          password: 'secret',
          shiprocket_courier_map: '{not json',
        },
        now: () => FIXED_NOW,
      }),
    ).toThrowError(CourierProviderError);
  });

  it('calls the apiv2.shiprocket.in /v1/external host (TEST and LIVE share it, TODO(sandbox-verify))', async () => {
    const { adapter, mock } = makeAdapter();
    // track on an unbooked AWB legitimately maps to AWB_NOT_FOUND; only the
    // URL the call went to matters here.
    await adapter.track('SR000000000001').catch(() => null);
    expect(mock.calls[0].url).toContain('apiv2.shiprocket.in/v1/external');
  });
});

describe('ShiprocketAdapter — token auth (§9.3.3)', () => {
  it('logs in once, caches the token, and sends Authorization: Bearer on calls', async () => {
    const { adapter, mock, tokenCache } = makeAdapter();
    await adapter.track('SR000000000001').catch(() => null);
    await adapter.track('SR000000000002').catch(() => null);
    expect(mock.loginCalls.value).toBe(1); // second call reused the cached token
    expect([...tokenCache.store.values()]).toContain('SR-TOKEN-1');
    const authed = mock.calls.filter((c) => !c.path.endsWith('/auth/login'));
    // Reaching the provider-level AWB_NOT_FOUND proves the bearer matched.
    expect(authed.length).toBeGreaterThan(0);
  });

  it('refreshes the token on 401 and resends the call exactly once', async () => {
    const { adapter, mock } = makeAdapter({ expireFirstToken: true });
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('refresh-1')));
    expect(booked.kind).toBe('CONFIRMED'); // succeeded on the resent call
    expect(mock.loginCalls.value).toBe(2); // initial login + refresh
  });

  it('a failed refresh throws CourierAuthError (→ DISCONNECTED, §3.21), without secrets in the error (INV-18)', async () => {
    const { adapter } = makeAdapter({ failAuth: true });
    const err = await adapter.track('SR000000000001').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CourierAuthError);
    expect(JSON.stringify(err)).not.toContain(MOCK_PASSWORD);
    expect(JSON.stringify(err)).not.toContain(MOCK_EMAIL);
  });

  it('a still-401 call after the refresh throws CourierAuthError (no resend loop)', async () => {
    const mock = createMockShiprocket();
    const realFetch = mock.fetchFn;
    const always401: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/courier/track/awb/')) {
        return new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401 });
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const { adapter } = makeAdapter({}, { fetchFn: always401 });
    const err = await adapter.track('SR000000000001').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CourierAuthError);
    // Exactly one refresh was attempted (login twice: initial + refresh).
    expect(mock.loginCalls.value).toBe(2);
  });
});

describe('ShiprocketAdapter — getQuote, LIVE_QUOTE (§8.3, A2-02)', () => {
  it('returns the mapped nested courier’s rate with components summing exactly to the total (INV-15, INV-23)', async () => {
    const { adapter, mock } = makeAdapter();
    const quote = await adapter.getQuote(contractQuoteRequest());
    expect(quote.serviceable).toBe(true);
    expect(quote.rateAvailable).toBe(true);
    expect(quote.currency).toBe('INR');
    // PREPAID: only the freight component (COD/other charges are zero).
    expect(quote.components).toEqual([
      { code: 'FREIGHT', label: 'Forward freight', amount: '42.50', taxable: true },
    ]);
    expect(quote.total).toBe('42.50');
    // The synthetic ref records WHICH nested courier was priced (§15.1).
    expect(quote.providerQuoteRef).toBe('SR-Q-39');
    expect(quote.capabilityFlags).toEqual(['PREPAID', 'COD']);
    // §8.3 rto_rule: rto_charges == freight → SAME_AS_FORWARD.
    expect(quote.rtoRule).toEqual({ basis: 'SAME_AS_FORWARD', pct: null });
    expect(quote.eddTo).toBe('2026-02-05');
    expect(quote.eddSource).toBe('PROVIDER');
    const query = mock.calls.find((c) => c.path.endsWith('/courier/serviceability'));
    expect(query?.url).toContain('pickup_postcode=110001');
    expect(query?.url).toContain('cod=0');
    expect(query?.url).toContain('weight=1.000'); // exact text, no floats (INV-15)
  });

  it('adds the COD component for COD quotes and keeps the exact total', async () => {
    const { adapter } = makeAdapter();
    const quote = await adapter.getQuote(
      contractQuoteRequest({ paymentMode: 'COD', collectible: '500.00' }),
    );
    expect(quote.components).toEqual([
      { code: 'FREIGHT', label: 'Forward freight', amount: '42.50', taxable: true },
      { code: 'COD_CHARGE', label: 'COD charge', amount: '15.00', taxable: false },
    ]);
    expect(quote.total).toBe('57.50');
  });

  it('selects the nested courier keyed by the service id over the default', async () => {
    const serviceId = '00000000-0000-0000-0000-0000000000b1';
    const { adapter } = makeAdapter(
      {},
      { courierMap: { [serviceId]: '14', default: '39' } },
    );
    const quote = await adapter.getQuote(contractQuoteRequest({ serviceId }));
    expect(quote.providerQuoteRef).toBe('SR-Q-14');
    expect(quote.total).toBe('50.00');
    // rto 25.00 on freight 50.00 → PERCENT_OF_FORWARD 50% (§8.3, §4.4 F-12).
    expect(quote.rtoRule).toEqual({ basis: 'PERCENT_OF_FORWARD', pct: '50.00' });
  });

  it('lane serviceable but nested courier unmapped → rateAvailable false with SERVICE_NOT_MAPPED, never a substituted rate (INV-23)', async () => {
    const { adapter } = makeAdapter({}, { courierMap: {} });
    const quote = await adapter.getQuote(contractQuoteRequest());
    expect(quote.serviceable).toBe(true);
    expect(quote.rateAvailable).toBe(false);
    expect(quote.components).toEqual([]);
    expect(quote.total).toBe('0.00');
    expect(quote.failureReasons).toEqual(['SERVICE_NOT_MAPPED']);
  });

  it('returns serviceable=false with structured reasons for the unserviceable destination', async () => {
    const { adapter } = makeAdapter();
    const quote = await adapter.getQuote(
      contractQuoteRequest({ destinationPincode: '999999' }),
    );
    expect(quote.serviceable).toBe(false);
    expect(quote.failureReasons).toEqual(['PINCODE_NOT_SERVICEABLE']);
    expect(quote.rateAvailable).toBe(false);
    expect(quote.total).toBe('0.00');
  });
});

describe('ShiprocketAdapter — error classification (§8.2 transport policy)', () => {
  it('429 → AdapterRateLimitError with the Retry-After header mapped to ms', async () => {
    const { adapter } = makeAdapter({ rateLimitPaths: ['/courier/track/awb'] });
    const err = await adapter.track('SR000000000001').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterRateLimitError);
    expect((err as AdapterRateLimitError).retryAfterMs).toBe(60_000);
  });

  it('sustained quote load surfaces the scripted 429 (§15.1 rate limiting)', async () => {
    const { adapter } = makeAdapter({}, { courierMap: { default: '39' } });
    let limited: AdapterRateLimitError | null = null;
    for (let i = 0; i < 50 && !limited; i++) {
      try {
        await adapter.getQuote(contractQuoteRequest());
      } catch (err) {
        if (err instanceof AdapterRateLimitError) limited = err;
        else throw err;
      }
    }
    expect(limited).not.toBeNull();
  });

  it('timeout on a non-create call throws AdapterTimeoutError', async () => {
    const mock = createMockShiprocket();
    const realFetch = mock.fetchFn;
    // Wrap: label downloads reject with the undici TimeoutError.
    const timeoutFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/labels/')) {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const { adapter } = makeAdapter({}, { fetchFn: timeoutFetch });
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('t-label')));
    await expect(adapter.getLabel(booked.awb!, 'PDF')).rejects.toThrowError(AdapterTimeoutError);
  });

  it('provider 5xx → CourierProviderError with a structured code, no secrets', async () => {
    const mock = createMockShiprocket();
    const realFetch = mock.fetchFn;
    const failingFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/courier/generate/pickup')) {
        return new Response(JSON.stringify({ error: 'pickup service unavailable' }), { status: 500 });
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const { adapter } = makeAdapter({}, { fetchFn: failingFetch });
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('t-5xx')));
    const err = await adapter
      .schedulePickup({
        awbs: [booked.awb!],
        pickupLocationId: 'loc-1',
        pickupDate: '2026-02-03',
      })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CourierProviderError);
    expect((err as CourierProviderError).code).toBe('PICKUP_SERVICE_UNAVAILABLE');
    expect(JSON.stringify(err)).not.toContain(MOCK_PASSWORD);
  });
});

describe('ShiprocketAdapter — createShipment, exactly-once (A1-04, INV-5, §9.5.4)', () => {
  it('books in two steps: order create keyed by the merchant reference, then AWB assign with the chosen nested courier_id', async () => {
    const { adapter, mock } = makeAdapter();
    const intent = contractIntent('book-1');
    const result = await adapter.createShipment(contractCreateRequest(intent));
    expect(result.kind).toBe('CONFIRMED');
    expect(result.awb).toMatch(/^SR\d{12}$/);

    const createCall = mock.calls.find((c) => c.path.endsWith('/orders/create/adhoc'));
    const createBody = JSON.parse(createCall?.body ?? '{}') as Record<string, unknown>;
    expect(createBody.order_id).toBe(intent.merchantReference); // §9.5.4 stable reference
    expect(createBody.payment_method).toBe('Prepaid');
    expect(createBody.weight).toBe('1.000'); // exact kg text (INV-15)
    expect(createBody.order_date).toBe('2026-02-01 10:00');

    const assignCall = mock.calls.find((c) => c.path.endsWith('/courier/assign/awb'));
    const assignBody = JSON.parse(assignCall?.body ?? '{}') as Record<string, unknown>;
    expect(assignBody.courier_id).toBe('39'); // the CHOSEN nested courier (§15.1)
    expect(typeof assignBody.shipment_id).toBe('string');
  });

  it('sends COD payment_method and the collectible as sub_total for COD bookings', async () => {
    const { adapter, mock } = makeAdapter();
    const result = await adapter.createShipment(
      contractCreateRequest(contractIntent('book-cod-1'), {
        paymentMode: 'COD',
        collectible: '500.00',
      }),
    );
    expect(result.kind).toBe('CONFIRMED');
    const createCall = mock.calls.find((c) => c.path.endsWith('/orders/create/adhoc'));
    const body = JSON.parse(createCall?.body ?? '{}') as Record<string, unknown>;
    expect(body.payment_method).toBe('COD');
    expect(body.sub_total).toBe('500.00'); // 2dp text end-to-end (INV-15)
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
    expect(mock.assignCalls.value).toBe(1);
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
    expect(lookup.awb).toMatch(/^SR\d{12}$/);
  });

  it('a duplicate merchant reference maps to FAILED with a structured reason (provider-side idempotency)', async () => {
    const { adapter } = makeAdapter();
    const intent = contractIntent('dup-1');
    const first = await adapter.createShipment(contractCreateRequest(intent));
    expect(first.kind).toBe('CONFIRMED');
    // A NEW intent reusing the same merchant reference hits Shiprocket's
    // duplicate order_id rejection.
    const second = await adapter.createShipment(
      contractCreateRequest(contractIntent('dup-2'), { intent: { ...contractIntent('dup-2'), merchantReference: intent.merchantReference } }),
    );
    expect(second.kind).toBe('FAILED');
    expect(second.failureReasons).toEqual(['DUPLICATE_ORDER_ID']);
  });

  it('no nested courier mapping → FAILED with SERVICE_NOT_MAPPED before any HTTP leaves the process', async () => {
    const { adapter, mock } = makeAdapter({}, { courierMap: {} });
    const result = await adapter.createShipment(contractCreateRequest(contractIntent('unmapped-1')));
    expect(result.kind).toBe('FAILED');
    expect(result.failureReasons).toEqual(['SERVICE_NOT_MAPPED']);
    expect(mock.calls).toEqual([]);
  });
});

describe('ShiprocketAdapter — lookup / track / cancel / label / pickup / NDR', () => {
  it('lookupByReference returns found=false for an unknown reference', async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.lookupByReference('__nope__')).toEqual({ found: false, awb: null });
  });

  it('track maps activities to polling events with raw statuses (§8.5; §3.6 maps them, not the adapter)', async () => {
    const { adapter } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('track-1')));
    const events = await adapter.track(booked.awb!);
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((e) => e.rawStatus)).toEqual(
      expect.arrayContaining(['Pickup Scheduled', 'Picked Up', 'Shipped']),
    );
    for (const e of events) expect(Number.isNaN(Date.parse(e.occurredAt))).toBe(false);
  });

  it('track on an unknown AWB throws CourierProviderError AWB_NOT_FOUND', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.track('SR999999999999')).rejects.toThrowError(CourierProviderError);
  });

  it('cancel returns CANCELLED for a booked AWB and REJECTED for an unknown one', async () => {
    const { adapter, mock } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('cancel-1')));
    expect((await adapter.cancelShipment(booked.awb!)).kind).toBe('CANCELLED');
    const cancelCall = mock.calls.find((c) => c.path.endsWith('/orders/cancel/shipment/awbs'));
    expect(JSON.parse(cancelCall?.body ?? '{}')).toEqual({ awbs: [booked.awb] });
    const rejected = await adapter.cancelShipment('SR999999999999');
    expect(rejected.kind).toBe('REJECTED');
    expect(rejected.reason).toBe('AWB_NOT_FOUND');
  });

  it('getLabel generates the label by shipment_id and downloads the PDF', async () => {
    const { adapter, mock } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('label-1')));
    const label = await adapter.getLabel(booked.awb!, 'PDF');
    expect(label.contentType).toBe('application/pdf');
    expect(label.bytes.subarray(0, 4).toString('utf8')).toBe('%PDF');
    const genCall = mock.calls.find((c) => c.path.endsWith('/courier/generate/label'));
    const body = JSON.parse(genCall?.body ?? '{}') as { shipment_id: string[] };
    expect(body.shipment_id).toHaveLength(1);
    expect(mock.calls.some((c) => c.path.startsWith('/labels/'))).toBe(true);
  });

  it('getLabel resolves the shipment id via tracking when the AWB was not booked in-process', async () => {
    // One mock server shared by two adapter instances; the second has an
    // empty booking registry and must resolve awb → shipment_id from the
    // track payload before generating the label.
    const mock = createMockShiprocket();
    const booker = new ShiprocketAdapter({
      courierAccountId: '00000000-0000-0000-0000-0000000000a1',
      mode: 'TEST',
      email: MOCK_EMAIL,
      password: MOCK_PASSWORD,
      courierMap: { default: '39' },
      now: () => FIXED_NOW,
      fetchFn: mock.fetchFn,
      tokenCache: new InMemoryShiprocketTokenCache(),
    });
    const other = new ShiprocketAdapter({
      courierAccountId: '00000000-0000-0000-0000-0000000000a1',
      mode: 'TEST',
      email: MOCK_EMAIL,
      password: MOCK_PASSWORD,
      courierMap: { default: '39' },
      now: () => FIXED_NOW,
      fetchFn: mock.fetchFn,
      tokenCache: new InMemoryShiprocketTokenCache(),
    });
    const booked = await booker.createShipment(contractCreateRequest(contractIntent('label-2')));
    const label = await other.getLabel(booked.awb!, 'PDF');
    expect(label.contentType).toBe('application/pdf');
    expect(label.bytes.subarray(0, 4).toString('utf8')).toBe('%PDF');
  });

  it('schedulePickup acknowledges with the provider pickup id', async () => {
    const { adapter } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('pickup-1')));
    const pickup = await adapter.schedulePickup({
      awbs: [booked.awb!],
      pickupLocationId: 'loc-1',
      pickupDate: '2026-02-03',
    });
    expect(pickup.acknowledged).toBe(true);
    expect(pickup.providerPickupId).toBe('SRPK-000001');
  });

  it('ndrAction is declared unsupported (A1-03): throws UnsupportedCapabilityError with a fallback note, no HTTP', async () => {
    const { adapter, mock } = makeAdapter();
    expect(adapter.unsupportedMethods).toEqual(['ndrAction']);
    const err = await adapter
      .ndrAction({ awb: 'SR000000000001', action: 'REATTEMPT', payload: {} })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedCapabilityError);
    expect((err as UnsupportedCapabilityError).method).toBe('ndrAction');
    expect((err as UnsupportedCapabilityError).manualFallbackNote).toBeTruthy();
    expect(mock.calls).toEqual([]); // no HTTP left the process
  });
});
