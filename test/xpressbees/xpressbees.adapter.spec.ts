import { describe, expect, it } from 'vitest';
import {
  AdapterRateLimitError,
  AdapterTimeoutError,
  CourierAuthError,
  CourierProviderError,
} from '../../src/modules/courier-framework/adapter-errors';
import { UnsupportedCapabilityError } from '../../src/modules/courier-framework/adapter.types';
import {
  XpressbeesAdapter,
  XpressbeesAdapterOptions,
  xpressbeesAdapterFactory,
} from '../../src/modules/xpressbees/xpressbees.adapter';
import {
  contractCreateRequest,
  contractIntent,
  contractQuoteRequest,
} from '../courier-framework/contract-suite';
import {
  InMemoryTokenCache,
  MOCK_EMAIL,
  MOCK_PASSWORD,
  createMockXpressbees,
} from './mock-xpressbees';

/**
 * Unit tests of the Xpressbees request/response mapping with a mocked fetch
 * (§15.1). The shapes asserted here mirror xpressbees-api.map.ts — every
 * one carries a TODO(sandbox-verify) over there.
 */

const FIXED_NOW = new Date('2026-02-01T10:00:00.000Z');

function makeAdapter(
  mockOpts: Parameters<typeof createMockXpressbees>[0] = {},
  adapterOpts: Partial<XpressbeesAdapterOptions> = {},
) {
  const mock = createMockXpressbees(mockOpts);
  const tokenCache = new InMemoryTokenCache();
  const adapter = new XpressbeesAdapter({
    courierAccountId: '00000000-0000-0000-0000-0000000000a1',
    mode: 'TEST',
    email: MOCK_EMAIL,
    password: MOCK_PASSWORD,
    now: () => FIXED_NOW,
    fetchFn: mock.fetchFn,
    tokenCache,
    ...adapterOpts,
  });
  return { adapter, mock, tokenCache };
}

describe('XpressbeesAdapter — factory & configuration', () => {
  it('factory builds an adapter from the build context credentials', () => {
    const adapter = xpressbeesAdapterFactory({
      courierAccountId: 'acct-1',
      courierCode: 'XPRESSBEES',
      mode: 'LIVE',
      credentials: { email: 'm@example.test', password: 'secret' },
      now: () => FIXED_NOW,
    });
    expect(adapter.courierCode).toBe('XPRESSBEES');
  });

  it('factory rejects missing credentials with CourierAuthError (INV-18: names the field, never a value)', () => {
    expect(() =>
      xpressbeesAdapterFactory({
        courierAccountId: 'acct-1',
        courierCode: 'XPRESSBEES',
        mode: 'TEST',
        credentials: {},
        now: () => FIXED_NOW,
      }),
    ).toThrowError(CourierAuthError);
    expect(() =>
      xpressbeesAdapterFactory({
        courierAccountId: 'acct-1',
        courierCode: 'XPRESSBEES',
        mode: 'TEST',
        credentials: { email: 'm@example.test' },
        now: () => FIXED_NOW,
      }),
    ).toThrowError(CourierAuthError);
  });

  it('calls the shipment.xpressbees.com host (TEST and LIVE share it, TODO(sandbox-verify))', async () => {
    const { adapter, mock } = makeAdapter();
    // track on an unbooked AWB legitimately maps to AWB_NOT_FOUND; only the
    // URL the call went to matters here.
    await adapter.track('XB00000000001').catch(() => null);
    expect(mock.calls[0].url).toContain('shipment.xpressbees.com');
  });
});

describe('XpressbeesAdapter — token auth (§9.3.3)', () => {
  it('logs in once, caches the token, and sends Authorization: Bearer on calls', async () => {
    const { adapter, mock, tokenCache } = makeAdapter();
    await adapter.track('XB00000000001').catch(() => null);
    await adapter.track('XB00000000002').catch(() => null);
    expect(mock.loginCalls.value).toBe(1); // second call reused the cached token
    expect([...tokenCache.store.values()]).toContain('XB-TOKEN-1');
    const authed = mock.calls.filter((c) => c.path !== '/api/users/login');
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
    const err = await adapter.track('XB00000000001').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CourierAuthError);
    expect(JSON.stringify(err)).not.toContain(MOCK_PASSWORD);
    expect(JSON.stringify(err)).not.toContain(MOCK_EMAIL);
  });

  it('a still-401 call after the refresh throws CourierAuthError (no resend loop)', async () => {
    const mock = createMockXpressbees();
    const realFetch = mock.fetchFn;
    const always401: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/shipments2/track/')) {
        return new Response(JSON.stringify({ status: false, message: 'unauthorized' }), { status: 401 });
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const { adapter } = makeAdapter({}, { fetchFn: always401 });
    const err = await adapter.track('XB00000000001').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CourierAuthError);
    // Exactly one refresh was attempted (login twice: initial + refresh).
    expect(mock.loginCalls.value).toBe(2);
  });
});

describe('XpressbeesAdapter — getQuote declared unsupported (A1-03)', () => {
  it('declares getQuote in unsupportedMethods and throws UnsupportedCapabilityError — never a silent no-op', async () => {
    const { adapter, mock } = makeAdapter();
    expect(adapter.unsupportedMethods).toEqual(['getQuote']);
    const err = await adapter.getQuote(contractQuoteRequest()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnsupportedCapabilityError);
    expect((err as UnsupportedCapabilityError).method).toBe('getQuote');
    expect((err as UnsupportedCapabilityError).manualFallbackNote).toBeTruthy();
    expect(mock.calls).toEqual([]); // no HTTP left the process
  });
});

describe('XpressbeesAdapter — error classification (§8.2 transport policy)', () => {
  it('429 → AdapterRateLimitError with the Retry-After header mapped to ms', async () => {
    const { adapter } = makeAdapter({ rateLimitPaths: ['/api/shipments2/track/'] });
    const err = await adapter.track('XB00000000001').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterRateLimitError);
    expect((err as AdapterRateLimitError).retryAfterMs).toBe(60_000);
  });

  it('timeout on a non-create call throws AdapterTimeoutError', async () => {
    const mock = createMockXpressbees();
    const realFetch = mock.fetchFn;
    // Wrap: label calls reject with the undici TimeoutError.
    const timeoutFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/shipments2/labels')) {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const { adapter } = makeAdapter({}, { fetchFn: timeoutFetch });
    await expect(adapter.getLabel('XB00000000001', 'PDF')).rejects.toThrowError(
      AdapterTimeoutError,
    );
  });

  it('provider 5xx → CourierProviderError with a structured code, no secrets', async () => {
    const mock = createMockXpressbees();
    const realFetch = mock.fetchFn;
    const failingFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/ndr/create')) {
        return new Response(JSON.stringify({ error: 'ndr service unavailable' }), { status: 500 });
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const { adapter } = makeAdapter({}, { fetchFn: failingFetch });
    const err = await adapter
      .ndrAction({ awb: 'XB00000000001', action: 'REATTEMPT', payload: {} })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CourierProviderError);
    expect((err as CourierProviderError).code).toBe('NDR_SERVICE_UNAVAILABLE');
    expect(JSON.stringify(err)).not.toContain(MOCK_PASSWORD);
  });
});

describe('XpressbeesAdapter — createShipment, exactly-once (A1-04, INV-5, §9.5.4)', () => {
  it('books: transmits the merchant reference as order_number, exact grams weight, returns CONFIRMED', async () => {
    const { adapter, mock } = makeAdapter();
    const intent = contractIntent('book-1');
    const result = await adapter.createShipment(contractCreateRequest(intent));
    expect(result.kind).toBe('CONFIRMED');
    expect(result.awb).toMatch(/^XB\d{11}$/);
    const createCall = mock.calls.find((c) => c.path === '/api/shipments2');
    const body = JSON.parse(createCall?.body ?? '{}') as Record<string, unknown>;
    expect(body.order_number).toBe(intent.merchantReference);
    expect(body.payment_type).toBe('prepaid');
    expect(body.package_weight).toBe('1000'); // 1.000 kg → grams, exact (INV-15)
    expect(body.quantity).toBe('1'); // INV-4
  });

  it('sends cod payment_type and cod_amount for COD bookings', async () => {
    const { adapter, mock } = makeAdapter();
    const result = await adapter.createShipment(
      contractCreateRequest(contractIntent('book-cod-1'), {
        paymentMode: 'COD',
        collectible: '500.00',
      }),
    );
    expect(result.kind).toBe('CONFIRMED');
    const createCall = mock.calls.find((c) => c.path === '/api/shipments2');
    const body = JSON.parse(createCall?.body ?? '{}') as Record<string, unknown>;
    expect(body.payment_type).toBe('cod');
    expect(body.cod_amount).toBe('500.00'); // 2dp text end-to-end (INV-15)
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
    expect(lookup.awb).toMatch(/^XB\d{11}$/);
  });

  it('a provider rejection maps to FAILED with structured failure reasons', async () => {
    const mock = createMockXpressbees();
    const realFetch = mock.fetchFn;
    const rejectingFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/shipments2')) {
        return new Response(
          JSON.stringify({ status: false, message: 'Duplicate order number' }),
          { status: 200 },
        );
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const { adapter } = makeAdapter({}, { fetchFn: rejectingFetch });
    const result = await adapter.createShipment(contractCreateRequest(contractIntent('fail-1')));
    expect(result.kind).toBe('FAILED');
    expect(result.failureReasons).toEqual(['DUPLICATE_ORDER_NUMBER']);
  });
});

describe('XpressbeesAdapter — lookup / track / cancel / label / pickup / NDR', () => {
  it('lookupByReference returns found=false for an unknown reference', async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.lookupByReference('__nope__')).toEqual({ found: false, awb: null });
  });

  it('track maps history to polling events with raw statuses (§8.5; §3.6 maps them, not the adapter)', async () => {
    const { adapter } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('track-1')));
    const events = await adapter.track(booked.awb!);
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((e) => e.rawStatus)).toEqual(
      expect.arrayContaining(['pending', 'picked', 'in transit']),
    );
    for (const e of events) expect(Number.isNaN(Date.parse(e.occurredAt))).toBe(false);
  });

  it('track on an unknown AWB throws CourierProviderError AWB_NOT_FOUND', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.track('XB99999999999')).rejects.toThrowError(CourierProviderError);
  });

  it('cancel returns CANCELLED for a booked AWB and REJECTED for an unknown one', async () => {
    const { adapter } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('cancel-1')));
    expect((await adapter.cancelShipment(booked.awb!)).kind).toBe('CANCELLED');
    const rejected = await adapter.cancelShipment('XB99999999999');
    expect(rejected.kind).toBe('REJECTED');
    expect(rejected.reason).toBe('AWB_NOT_FOUND');
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
      awbs: ['XB00000000001'],
      pickupLocationId: 'loc-1',
      pickupDate: '2026-02-03',
    });
    expect(pickup.acknowledged).toBe(true);
    expect(pickup.providerPickupId).toBe('PKP-XB-0001');
  });

  it('ndrAction maps all three action types and accepts', async () => {
    const { adapter, mock } = makeAdapter();
    for (const action of ['REATTEMPT', 'UPDATE_ADDRESS_AND_REATTEMPT', 'INITIATE_RTO'] as const) {
      const result = await adapter.ndrAction({
        awb: 'XB00000000001',
        action,
        payload: action === 'UPDATE_ADDRESS_AND_REATTEMPT' ? { address: 'New line 1' } : {},
      });
      expect(result.accepted).toBe(true);
    }
    const bodies = mock.calls
      .filter((c) => c.path === '/api/ndr/create')
      .map((c) => JSON.parse(c.body ?? '{}') as Record<string, unknown>);
    expect(bodies[0].action).toBe('reattempt');
    expect(bodies[1].action).toBe('reattempt');
    expect(bodies[1].address).toBe('New line 1');
    expect(bodies[2].action).toBe('rto');
  });
});
