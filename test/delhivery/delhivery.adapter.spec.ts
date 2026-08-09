import { describe, expect, it } from 'vitest';
import {
  AdapterRateLimitError,
  AdapterTimeoutError,
  CourierAuthError,
  CourierProviderError,
} from '../../src/modules/courier-framework/adapter-errors';
import {
  DelhiveryAdapter,
  DelhiveryAdapterOptions,
  delhiveryAdapterFactory,
} from '../../src/modules/delhivery/delhivery.adapter';
import {
  contractCreateRequest,
  contractIntent,
  contractQuoteRequest,
} from '../courier-framework/contract-suite';
import { MOCK_API_TOKEN, createMockDelhivery } from './mock-delhivery';

/**
 * Unit tests of the Delhivery request/response mapping with a mocked fetch
 * (§15.1). The shapes asserted here mirror delhivery-api.map.ts — every one
 * carries a TODO(sandbox-verify) over there.
 */

const FIXED_NOW = new Date('2026-02-01T10:00:00.000Z');

function makeAdapter(
  mockOpts: Parameters<typeof createMockDelhivery>[0] = {},
  adapterOpts: Partial<DelhiveryAdapterOptions> = {},
) {
  const mock = createMockDelhivery(mockOpts);
  const adapter = new DelhiveryAdapter({
    courierAccountId: '00000000-0000-0000-0000-0000000000a1',
    mode: 'TEST',
    apiToken: MOCK_API_TOKEN,
    now: () => FIXED_NOW,
    fetchFn: mock.fetchFn,
    ...adapterOpts,
  });
  return { adapter, mock };
}

describe('DelhiveryAdapter — factory & configuration', () => {
  it('factory builds an adapter from the build context credentials', () => {
    const adapter = delhiveryAdapterFactory({
      courierAccountId: 'acct-1',
      courierCode: 'DELHIVERY',
      mode: 'LIVE',
      credentials: { api_token: 'secret-live-token' },
      now: () => FIXED_NOW,
    });
    expect(adapter.courierCode).toBe('DELHIVERY');
  });

  it('factory rejects a missing api_token with CourierAuthError (INV-18: names the field, never a value)', () => {
    expect(() =>
      delhiveryAdapterFactory({
        courierAccountId: 'acct-1',
        courierCode: 'DELHIVERY',
        mode: 'TEST',
        credentials: {},
        now: () => FIXED_NOW,
      }),
    ).toThrowError(CourierAuthError);
  });

  it('picks the staging base URL in TEST mode and production in LIVE mode', async () => {
    // track on an unbooked AWB legitimately 404s into AWB_NOT_FOUND; only
    // the URL the call went to matters here.
    const { adapter: testAdapter, mock: testMock } = makeAdapter({}, { mode: 'TEST' });
    await testAdapter.track('DLV00000000001').catch(() => null);
    expect(testMock.calls[0].url).toContain('staging-express.delhivery.com');

    const { adapter: liveAdapter, mock: liveMock } = makeAdapter({}, { mode: 'LIVE' });
    await liveAdapter.track('DLV00000000001').catch(() => null);
    expect(liveMock.calls[0].url).toContain('track.delhivery.com');
  });

  it('sends Authorization: Token <api_token> on every call', async () => {
    const { adapter } = makeAdapter();
    // The harness answers 401 for any other token; reaching the
    // provider-level AWB_NOT_FOUND proves the header matched.
    await expect(adapter.track('NOPE')).rejects.toThrowError(CourierProviderError);
  });
});

describe('DelhiveryAdapter — getQuote (§8.3)', () => {
  it('maps a serviceable quote: components pass through unmarked (INV-23), total is the exact component sum (INV-15)', async () => {
    const { adapter } = makeAdapter();
    const quote = await adapter.getQuote(contractQuoteRequest());
    expect(quote.serviceable).toBe(true);
    expect(quote.failureReasons).toEqual([]);
    expect(quote.rateAvailable).toBe(true);
    expect(quote.currency).toBe('INR');
    expect(quote.components.map((c) => c.code)).toEqual(
      expect.arrayContaining(['DL_FREIGHT', 'DL_FUEL', 'DL_GST']),
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

  it('maps COD parameters on the charges request', async () => {
    const { adapter, mock } = makeAdapter();
    const quote = await adapter.getQuote(
      contractQuoteRequest({ paymentMode: 'COD', collectible: '500.00' }),
    );
    expect(quote.serviceable).toBe(true);
    expect(quote.components.map((c) => c.code)).toContain('DL_COD');
    expect(quote.total).toBe('91.69');
    const chargesCall = mock.calls.find((c) => c.path.includes('kinko'));
    expect(chargesCall?.url).toContain('pt=COD');
    expect(chargesCall?.url).toContain('cod=500.00');
    expect(chargesCall?.url).toContain('cgm=1000'); // 1.000 kg → grams, exact
  });

  it('flags COD_NOT_SERVICEABLE when the destination refuses COD', async () => {
    const { adapter } = makeAdapter({ codServiceable: false });
    const quote = await adapter.getQuote(
      contractQuoteRequest({ paymentMode: 'COD', collectible: '500.00' }),
    );
    expect(quote.serviceable).toBe(false);
    expect(quote.failureReasons).toEqual(['COD_NOT_SERVICEABLE']);
  });

  it('declares all §8.2 methods supported (no silent no-ops, A1-03)', () => {
    const { adapter } = makeAdapter();
    expect(adapter.unsupportedMethods).toEqual([]);
  });
});

describe('DelhiveryAdapter — error classification (§8.2 transport policy)', () => {
  it('401 → CourierAuthError, without the token anywhere in the error (INV-18)', async () => {
    const { adapter } = makeAdapter({ failAuth: true });
    const err = await adapter.track('DLV00000000001').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CourierAuthError);
    expect(JSON.stringify(err)).not.toContain(MOCK_API_TOKEN);
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
    const mock = createMockDelhivery();
    const realFetch = mock.fetchFn;
    // Wrap: packing-slip calls hang the mock → abort via a short timeout
    // is impractical in tests; instead reject with the undici TimeoutError.
    const timeoutFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('packing_slip')) {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const adapter = new DelhiveryAdapter({
      courierAccountId: 'acct',
      mode: 'TEST',
      apiToken: MOCK_API_TOKEN,
      now: () => FIXED_NOW,
      fetchFn: timeoutFetch,
    });
    await expect(adapter.getLabel('DLV00000000001', 'PDF')).rejects.toThrowError(
      AdapterTimeoutError,
    );
  });

  it('provider 5xx → CourierProviderError with a structured code, no secrets', async () => {
    const mock = createMockDelhivery();
    const realFetch = mock.fetchFn;
    const failingFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('ndr_action')) {
        return new Response(JSON.stringify({ error: 'ndr service unavailable' }), { status: 500 });
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const adapter = new DelhiveryAdapter({
      courierAccountId: 'acct',
      mode: 'TEST',
      apiToken: MOCK_API_TOKEN,
      now: () => FIXED_NOW,
      fetchFn: failingFetch,
    });
    const err = await adapter
      .ndrAction({ awb: 'DLV00000000001', action: 'REATTEMPT', payload: {} })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CourierProviderError);
    expect((err as CourierProviderError).code).toBe('NDR_SERVICE_UNAVAILABLE');
    expect(JSON.stringify(err)).not.toContain(MOCK_API_TOKEN);
  });
});

describe('DelhiveryAdapter — createShipment, exactly-once (A1-04, INV-5, §9.5.4)', () => {
  it('books: fetches a waybill, transmits the merchant reference, returns CONFIRMED', async () => {
    const { adapter, mock } = makeAdapter();
    const intent = contractIntent('book-1');
    const result = await adapter.createShipment(contractCreateRequest(intent));
    expect(result.kind).toBe('CONFIRMED');
    expect(result.awb).toMatch(/^DLV\d{11}$/);
    const createCall = mock.calls.find((c) => c.path.includes('cmu/create'));
    expect(createCall?.body).toContain(encodeURIComponent(intent.merchantReference));
    expect(createCall?.body).toContain(encodeURIComponent('"payment_mode":"Prepaid"'));
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
    expect(lookup.awb).toMatch(/^DLV\d{11}$/);
  });

  it('a provider rejection maps to FAILED with structured failure reasons', async () => {
    const mock = createMockDelhivery();
    const realFetch = mock.fetchFn;
    const rejectingFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('cmu/create')) {
        return new Response(
          JSON.stringify({ success: false, error: 'Duplicate order reference' }),
          { status: 200 },
        );
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const adapter = new DelhiveryAdapter({
      courierAccountId: 'acct',
      mode: 'TEST',
      apiToken: MOCK_API_TOKEN,
      now: () => FIXED_NOW,
      fetchFn: rejectingFetch,
    });
    const result = await adapter.createShipment(contractCreateRequest(contractIntent('fail-1')));
    expect(result.kind).toBe('FAILED');
    expect(result.failureReasons).toEqual(['DUPLICATE_ORDER_REFERENCE']);
  });
});

describe('DelhiveryAdapter — lookup / track / cancel / label / pickup / NDR', () => {
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
      expect.arrayContaining(['Manifested', 'Picked Up', 'In Transit']),
    );
    for (const e of events) expect(Number.isNaN(Date.parse(e.occurredAt))).toBe(false);
  });

  it('track on an unknown AWB throws CourierProviderError AWB_NOT_FOUND', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.track('DLV99999999999')).rejects.toThrowError(CourierProviderError);
  });

  it('cancel returns CANCELLED for a booked AWB and REJECTED for an unknown one', async () => {
    const { adapter } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('cancel-1')));
    expect((await adapter.cancelShipment(booked.awb!)).kind).toBe('CANCELLED');
    const rejected = await adapter.cancelShipment('DLV99999999999');
    expect(rejected.kind).toBe('REJECTED');
    expect(rejected.reason).toBe('WAYBILL_NOT_FOUND');
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
      awbs: ['DLV00000000001'],
      pickupLocationId: 'loc-1',
      pickupDate: '2026-02-03',
    });
    expect(pickup.acknowledged).toBe(true);
    expect(pickup.providerPickupId).toBe('PKP-MOCK-0001');
  });

  it('ndrAction maps all three action types and accepts', async () => {
    const { adapter, mock } = makeAdapter();
    for (const action of ['REATTEMPT', 'UPDATE_ADDRESS_AND_REATTEMPT', 'INITIATE_RTO'] as const) {
      const result = await adapter.ndrAction({
        awb: 'DLV00000000001',
        action,
        payload: action === 'UPDATE_ADDRESS_AND_REATTEMPT' ? { address: 'New line 1' } : {},
      });
      expect(result.accepted).toBe(true);
    }
    const bodies = mock.calls
      .filter((c) => c.path.includes('ndr_action'))
      .map((c) => JSON.parse(c.body ?? '{}') as Record<string, unknown>);
    expect(bodies[0].action).toBe('REATTEMPT');
    expect(bodies[1].action).toBe('REATTEMPT');
    expect(bodies[1].address).toBe('New line 1');
    expect(bodies[2].action).toBe('RTO');
  });
});
