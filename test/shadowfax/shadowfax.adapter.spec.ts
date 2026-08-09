import { describe, expect, it } from 'vitest';
import {
  AdapterRateLimitError,
  AdapterTimeoutError,
  CourierAuthError,
  CourierProviderError,
} from '../../src/modules/courier-framework/adapter-errors';
import { UnsupportedCapabilityError } from '../../src/modules/courier-framework/adapter.types';
import {
  ShadowfaxAdapter,
  ShadowfaxAdapterOptions,
  shadowfaxAdapterFactory,
} from '../../src/modules/shadowfax/shadowfax.adapter';
import { SHADOWFAX_GETQUOTE_FALLBACK_NOTE } from '../../src/modules/shadowfax/shadowfax.seed';
import {
  contractCreateRequest,
  contractIntent,
  contractQuoteRequest,
} from '../courier-framework/contract-suite';
import { MOCK_API_KEY, createMockShadowfax } from './mock-shadowfax';

/**
 * Unit tests of the Shadowfax request/response mapping with a mocked fetch
 * (§15.1). The shapes asserted here mirror shadowfax-api.map.ts — every one
 * carries a TODO(sandbox-verify) over there.
 */

const FIXED_NOW = new Date('2026-02-01T10:00:00.000Z');

function makeAdapter(
  mockOpts: Parameters<typeof createMockShadowfax>[0] = {},
  adapterOpts: Partial<ShadowfaxAdapterOptions> = {},
) {
  const mock = createMockShadowfax(mockOpts);
  const adapter = new ShadowfaxAdapter({
    courierAccountId: '00000000-0000-0000-0000-0000000000a1',
    mode: 'TEST',
    apiKey: MOCK_API_KEY,
    now: () => FIXED_NOW,
    fetchFn: mock.fetchFn,
    ...adapterOpts,
  });
  return { adapter, mock };
}

describe('ShadowfaxAdapter — factory & configuration', () => {
  it('factory builds an adapter from the build context credentials', () => {
    const adapter = shadowfaxAdapterFactory({
      courierAccountId: 'acct-1',
      courierCode: 'SHADOWFAX',
      mode: 'LIVE',
      credentials: { api_key: 'secret-live-key' },
      now: () => FIXED_NOW,
    });
    expect(adapter.courierCode).toBe('SHADOWFAX');
  });

  it('factory rejects a missing api_key with CourierAuthError (INV-18: names the field, never a value)', () => {
    expect(() =>
      shadowfaxAdapterFactory({
        courierAccountId: 'acct-1',
        courierCode: 'SHADOWFAX',
        mode: 'TEST',
        credentials: {},
        now: () => FIXED_NOW,
      }),
    ).toThrowError(CourierAuthError);
  });

  it('sends Authorization: Token <api_key> on every call', async () => {
    const { adapter } = makeAdapter();
    // The harness answers 401 for any other key; reaching the
    // provider-level AWB_NOT_FOUND proves the header matched.
    await expect(adapter.track('NOPE')).rejects.toThrowError(CourierProviderError);
  });
});

describe('ShadowfaxAdapter — getQuote declared unsupported (A1-03)', () => {
  it('declares getQuote as the only unsupported §8.2 method', () => {
    const { adapter } = makeAdapter();
    expect(adapter.unsupportedMethods).toEqual(['getQuote']);
  });

  it('throws UnsupportedCapabilityError with the manual fallback note — never a silent no-op', async () => {
    const { adapter } = makeAdapter();
    const err = await adapter.getQuote(contractQuoteRequest()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnsupportedCapabilityError);
    expect((err as UnsupportedCapabilityError).method).toBe('getQuote');
    expect((err as UnsupportedCapabilityError).manualFallbackNote).toBe(
      SHADOWFAX_GETQUOTE_FALLBACK_NOTE,
    );
  });
});

describe('ShadowfaxAdapter — error classification (§8.2 transport policy)', () => {
  it('401 → CourierAuthError, without the key anywhere in the error (INV-18)', async () => {
    const { adapter } = makeAdapter({ failAuth: true });
    const err = await adapter.track('SFX0000000001').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CourierAuthError);
    expect(JSON.stringify(err)).not.toContain(MOCK_API_KEY);
  });

  it('429 → AdapterRateLimitError with the Retry-After header mapped to ms', async () => {
    const { adapter } = makeAdapter({ trackRateLimit: 1 });
    await adapter.track('NOPE').catch(() => null); // consumes the allowance (AWB_NOT_FOUND)
    const err = await adapter.track('NOPE').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterRateLimitError);
    expect((err as AdapterRateLimitError).retryAfterMs).toBe(60_000);
  });

  it('timeout on a non-create call throws AdapterTimeoutError', async () => {
    const mock = createMockShadowfax();
    const realFetch = mock.fetchFn;
    // Wrap: label calls reject with the undici TimeoutError.
    const timeoutFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v1/label')) {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const adapter = new ShadowfaxAdapter({
      courierAccountId: 'acct',
      mode: 'TEST',
      apiKey: MOCK_API_KEY,
      now: () => FIXED_NOW,
      fetchFn: timeoutFetch,
    });
    await expect(adapter.getLabel('SFX0000000001', 'PDF')).rejects.toThrowError(
      AdapterTimeoutError,
    );
  });

  it('provider 5xx → CourierProviderError with a structured code, no secrets', async () => {
    const mock = createMockShadowfax();
    const realFetch = mock.fetchFn;
    const failingFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v1/ndr/action')) {
        return new Response(JSON.stringify({ message: 'ndr service unavailable' }), { status: 500 });
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const adapter = new ShadowfaxAdapter({
      courierAccountId: 'acct',
      mode: 'TEST',
      apiKey: MOCK_API_KEY,
      now: () => FIXED_NOW,
      fetchFn: failingFetch,
    });
    const err = await adapter
      .ndrAction({ awb: 'SFX0000000001', action: 'REATTEMPT', payload: {} })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CourierProviderError);
    expect((err as CourierProviderError).code).toBe('NDR_SERVICE_UNAVAILABLE');
    expect(JSON.stringify(err)).not.toContain(MOCK_API_KEY);
  });
});

describe('ShadowfaxAdapter — createShipment, exactly-once (A1-04, INV-5, §9.5.4)', () => {
  it('books: transmits client_order_id = merchant reference, returns CONFIRMED', async () => {
    const { adapter, mock } = makeAdapter();
    const intent = contractIntent('book-1');
    const result = await adapter.createShipment(contractCreateRequest(intent));
    expect(result.kind).toBe('CONFIRMED');
    expect(result.awb).toMatch(/^SFX\d{10}$/);
    const createCall = mock.calls.find((c) => c.path === '/api/v4/orders');
    const body = JSON.parse(createCall?.body ?? '{}') as Record<string, unknown>;
    expect(body.client_order_id).toBe(intent.merchantReference);
    expect(body.payment_mode).toBe('Prepaid');
    expect((body.parcel_details as Record<string, unknown>).weight).toBe('1000'); // 1.000 kg → grams, exact
  });

  it('maps COD parameters on the create request', async () => {
    const { adapter, mock } = makeAdapter();
    const intent = contractIntent('book-cod-1');
    await adapter.createShipment(
      contractCreateRequest(intent, { paymentMode: 'COD', collectible: '500.00' }),
    );
    const createCall = mock.calls.find((c) => c.path === '/api/v4/orders');
    const body = JSON.parse(createCall?.body ?? '{}') as Record<string, unknown>;
    expect(body.payment_mode).toBe('COD');
    expect(body.cod_amount).toBe('500.00');
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
    expect(lookup.awb).toMatch(/^SFX\d{10}$/);
  });

  it('a provider rejection maps to FAILED with structured failure reasons', async () => {
    const mock = createMockShadowfax();
    const realFetch = mock.fetchFn;
    const rejectingFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v4/orders')) {
        return new Response(
          JSON.stringify({ success: false, message: 'Duplicate order reference' }),
          { status: 200 },
        );
      }
      return realFetch(input as string, init);
    }) as typeof fetch;
    const adapter = new ShadowfaxAdapter({
      courierAccountId: 'acct',
      mode: 'TEST',
      apiKey: MOCK_API_KEY,
      now: () => FIXED_NOW,
      fetchFn: rejectingFetch,
    });
    const result = await adapter.createShipment(contractCreateRequest(contractIntent('fail-1')));
    expect(result.kind).toBe('FAILED');
    expect(result.failureReasons).toEqual(['DUPLICATE_ORDER_REFERENCE']);
  });
});

describe('ShadowfaxAdapter — lookup / track / cancel / label / pickup / NDR', () => {
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
      expect.arrayContaining(['Created', 'Picked Up', 'In Transit']),
    );
    for (const e of events) expect(Number.isNaN(Date.parse(e.occurredAt))).toBe(false);
  });

  it('track on an unknown AWB throws CourierProviderError AWB_NOT_FOUND', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.track('SFX9999999999')).rejects.toThrowError(CourierProviderError);
  });

  it('cancel returns CANCELLED for a booked AWB and REJECTED for an unknown one', async () => {
    const { adapter } = makeAdapter();
    const booked = await adapter.createShipment(contractCreateRequest(contractIntent('cancel-1')));
    expect((await adapter.cancelShipment(booked.awb!)).kind).toBe('CANCELLED');
    const rejected = await adapter.cancelShipment('SFX9999999999');
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
      awbs: ['SFX0000000001'],
      pickupLocationId: 'loc-1',
      pickupDate: '2026-02-03',
    });
    expect(pickup.acknowledged).toBe(true);
    expect(pickup.providerPickupId).toBe('SFX-PKP-MOCK-0001');
  });

  it('ndrAction maps all three action types and accepts', async () => {
    const { adapter, mock } = makeAdapter();
    for (const action of ['REATTEMPT', 'UPDATE_ADDRESS_AND_REATTEMPT', 'INITIATE_RTO'] as const) {
      const result = await adapter.ndrAction({
        awb: 'SFX0000000001',
        action,
        payload: action === 'UPDATE_ADDRESS_AND_REATTEMPT' ? { address: 'New line 1' } : {},
      });
      expect(result.accepted).toBe(true);
    }
    const bodies = mock.calls
      .filter((c) => c.path === '/api/v1/ndr/action')
      .map((c) => JSON.parse(c.body ?? '{}') as Record<string, unknown>);
    expect(bodies[0].action).toBe('reattempt');
    expect(bodies[1].action).toBe('reattempt');
    expect(bodies[1].address).toBe('New line 1');
    expect(bodies[2].action).toBe('rto');
  });
});
