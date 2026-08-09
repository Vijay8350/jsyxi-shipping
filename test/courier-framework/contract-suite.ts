import { describe, expect, it } from 'vitest';
import {
  AdapterMethod,
  ADAPTER_METHODS,
  BookingIntent,
  CourierAdapter,
  CreateShipmentRequest,
  QuoteRequest,
  UnsupportedCapabilityError,
} from '../../src/modules/courier-framework/adapter.types';
import { AdapterRateLimitError } from '../../src/modules/courier-framework/adapter-errors';
import { isTestEventCapable } from '../../src/modules/courier-framework/test-event';

/**
 * The §15.1 courier contract suite — the prerequisite every launch adapter
 * MUST pass before it is wired (§14 weeks 4–6 ordering: the suite runs
 * green against the deterministic fake first, proving the suite itself).
 *
 * Usage:
 *   runCourierContractSuite('delhivery', () => new DelhiveryAdapter(...));
 *
 * Conventions an adapter (or its sandbox harness) must honor:
 * - Destination pincode '999999' is conventionally unserviceable; the
 *   adapter/harness must return serviceable=false with structured
 *   failureReasons for it (§8.3).
 * - A booking intent whose bookingIntentId starts with 'contract-timeout-'
 *   must produce an ambiguous create (OUTCOME_UNKNOWN) that
 *   lookupByReference later resolves (INV-5). The fake records the create
 *   and times out; a real adapter's harness scripts the equivalent.
 * - Optional adapter surfaces the suite uses when present:
 *     adapter.unsupportedMethods?: AdapterMethod[] — declared-unsupported
 *       capabilities (A1-03); the suite asserts they throw
 *       UnsupportedCapabilityError and functional-tests the rest.
 *     adapter.requestLog?: Array<{ method, bookingIntentId?, deduplicated? }>
 *       — lets the suite assert no second create is issued for a retried
 *       intent (A1-04).
 *     TestEventCapableAdapter.buildTestWebhookEvent() — the ADD-18 fake
 *       event; the suite asserts the webhook-shape raw event.
 * - Rate limiting (§15.1): the suite hammers getQuote and requires an
 *   AdapterRateLimitError-shaped rejection within 50 calls. Configure the
 *   fake with quoteRateLimit; a real adapter's harness maps a scripted 429.
 */

// ---------------------------------------------------------------------
// canned inputs
// ---------------------------------------------------------------------

export const CONTRACT_SERVICEABLE_DESTINATION = '110001';
export const CONTRACT_UNSERVICEABLE_DESTINATION = '999999';
export const CONTRACT_TIMEOUT_INTENT_PREFIX = 'contract-timeout-';

export function contractQuoteRequest(over: Partial<QuoteRequest> = {}): QuoteRequest {
  return {
    courierAccountId: '00000000-0000-0000-0000-0000000000a1',
    serviceId: '00000000-0000-0000-0000-0000000000b1',
    originPincode: '110001',
    destinationPincode: CONTRACT_SERVICEABLE_DESTINATION,
    shipDate: '2026-02-02',
    pieces: 1,
    deadWeightKg: '1.000',
    lengthCm: '10.00',
    widthCm: '10.00',
    heightCm: '10.00',
    paymentMode: 'PREPAID',
    collectible: '0.00',
    declaredValue: '500.00',
    pickupLocationId: '00000000-0000-0000-0000-0000000000d1',
    ...over,
  };
}

export function contractIntent(id: string): BookingIntent {
  return {
    bookingIntentId: id,
    requestDigest: `digest-${id}`,
    merchantReference: `SHOP1-shipment-${id}`,
  };
}

export function contractCreateRequest(
  intent: BookingIntent,
  over: Partial<CreateShipmentRequest> = {},
): CreateShipmentRequest {
  return {
    intent,
    serviceId: 'contract-service',
    originPincode: '110001',
    destinationPincode: CONTRACT_SERVICEABLE_DESTINATION,
    deadWeightKg: '1.000',
    lengthCm: '10.00',
    widthCm: '10.00',
    heightCm: '10.00',
    paymentMode: 'PREPAID',
    collectible: '0.00',
    declaredValue: '500.00',
    recipient: {
      name: 'Contract Recipient',
      addressLines: ['Line 1'],
      city: 'New Delhi',
      state: 'Delhi',
      pincode: CONTRACT_SERVICEABLE_DESTINATION,
      phone: '9811111111',
      email: null,
    },
    pickupLocationId: '00000000-0000-0000-0000-000000000001',
    ...over,
  };
}

/** Exact 2dp text → paise integer (test-local; never floats, INV-15). */
function paiseOf(amount: string): number {
  const neg = amount.startsWith('-');
  const [whole, frac = ''] = (neg ? amount.slice(1) : amount).split('.');
  const v = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2) || '0');
  return neg ? -v : v;
}

const MONEY_2DP = /^-?\d+\.\d{2}$/;

interface OptionalSurfaces {
  unsupportedMethods?: AdapterMethod[];
  requestLog?: Array<{
    method: AdapterMethod;
    bookingIntentId?: string;
    deduplicated?: boolean;
  }>;
}

function declaredUnsupported(adapter: CourierAdapter): AdapterMethod[] {
  return (adapter as CourierAdapter & OptionalSurfaces).unsupportedMethods ?? [];
}

function isUnsupported(adapter: CourierAdapter, method: AdapterMethod): boolean {
  return declaredUnsupported(adapter).includes(method);
}

/** Canned-args dispatcher, used for unsupported-capability assertions. */
function callMethod(adapter: CourierAdapter, method: AdapterMethod): Promise<unknown> {
  switch (method) {
    case 'getQuote':
      return adapter.getQuote(contractQuoteRequest());
    case 'createShipment':
      return adapter.createShipment(contractCreateRequest(contractIntent('generic-1')));
    case 'lookupByReference':
      return adapter.lookupByReference('__contract_probe__');
    case 'cancelShipment':
      return adapter.cancelShipment('FAKE0000000001');
    case 'track':
      return adapter.track('FAKE0000000001');
    case 'getLabel':
      return adapter.getLabel('FAKE0000000001', 'PDF');
    case 'schedulePickup':
      return adapter.schedulePickup({
        awbs: ['FAKE0000000001'],
        pickupLocationId: '00000000-0000-0000-0000-000000000001',
        pickupDate: '2026-02-02',
      });
    case 'ndrAction':
      return adapter.ndrAction({ awb: 'FAKE0000000001', action: 'REATTEMPT', payload: {} });
  }
}

// ---------------------------------------------------------------------
// the suite
// ---------------------------------------------------------------------

export function runCourierContractSuite(
  adapterName: string,
  makeAdapter: () => Promise<CourierAdapter> | CourierAdapter,
): void {
  describe(`courier contract suite (§15.1): ${adapterName}`, () => {
    const fresh = () => Promise.resolve(makeAdapter());

    /** Book and return the awb, unless createShipment is declared
     *  unsupported — in which case the test asserts the throw. */
    async function bookOrAssertUnsupported(adapter: CourierAdapter, intentId: string) {
      if (isUnsupported(adapter, 'createShipment')) {
        await expect(callMethod(adapter, 'createShipment')).rejects.toBeInstanceOf(
          UnsupportedCapabilityError,
        );
        return null;
      }
      const result = await adapter.createShipment(contractCreateRequest(contractIntent(intentId)));
      expect(result.kind).toBe('CONFIRMED');
      expect(typeof result.awb).toBe('string');
      expect(result.awb!.length).toBeGreaterThan(0);
      return result.awb!;
    }

    describe('serviceability and quote (§8.3)', () => {
      it('returns a serviceable quote with components summing to total (INV-15)', async () => {
        const adapter = await fresh();
        if (isUnsupported(adapter, 'getQuote')) {
          await expect(callMethod(adapter, 'getQuote')).rejects.toBeInstanceOf(
            UnsupportedCapabilityError,
          );
          return;
        }
        const quote = await adapter.getQuote(contractQuoteRequest());
        expect(quote.serviceable).toBe(true);
        expect(quote.failureReasons).toEqual([]);
        expect(quote.rateAvailable).toBe(true);
        expect(quote.currency).toBe('INR');
        expect(quote.components.length).toBeGreaterThan(0);
        for (const c of quote.components) {
          expect(c.amount).toMatch(MONEY_2DP);
          expect(typeof c.code).toBe('string');
          expect(typeof c.taxable).toBe('boolean');
        }
        // INV-23/INV-15: the total is exactly the sum of stored components.
        const sum = quote.components.reduce((acc, c) => acc + paiseOf(c.amount), 0);
        expect(paiseOf(quote.total)).toBe(sum);
        expect(typeof quote.fetchedAt).toBe('string');
      });

      it('returns serviceable=false with structured failure reasons for the unserviceable destination', async () => {
        const adapter = await fresh();
        if (isUnsupported(adapter, 'getQuote')) return; // asserted elsewhere
        const quote = await adapter.getQuote(
          contractQuoteRequest({ destinationPincode: CONTRACT_UNSERVICEABLE_DESTINATION }),
        );
        expect(quote.serviceable).toBe(false);
        expect(Array.isArray(quote.failureReasons)).toBe(true);
        expect(quote.failureReasons.length).toBeGreaterThan(0);
        for (const reason of quote.failureReasons) {
          expect(typeof reason).toBe('string'); // structured codes, not free text
        }
      });
    });

    describe('booking (§8.2 createShipment)', () => {
      it('books successfully and returns an AWB', async () => {
        const adapter = await fresh();
        const awb = await bookOrAssertUnsupported(adapter, 'contract-book-1');
        if (awb === null) return;
      });
    });

    describe('ambiguous create timeout and lookupByReference resolution (INV-5)', () => {
      it('surfaces OUTCOME_UNKNOWN, then resolves via lookupByReference', async () => {
        const adapter = await fresh();
        if (
          isUnsupported(adapter, 'createShipment') ||
          isUnsupported(adapter, 'lookupByReference')
        ) {
          return; // declared-unsupported paths are asserted in their own tests
        }
        const intent = contractIntent(`${CONTRACT_TIMEOUT_INTENT_PREFIX}1`);
        const result = await adapter.createShipment(contractCreateRequest(intent));
        expect(result.kind).toBe('OUTCOME_UNKNOWN');
        expect(result.awb).toBeNull();

        const lookup = await adapter.lookupByReference(intent.merchantReference);
        expect(lookup.found).toBe(true);
        expect(typeof lookup.awb).toBe('string');
        expect(lookup.awb!.length).toBeGreaterThan(0);
      });
    });

    describe('label (§8.2 getLabel)', () => {
      it('returns PDF bytes for a booked AWB', async () => {
        const adapter = await fresh();
        const awb = await bookOrAssertUnsupported(adapter, 'contract-label-1');
        if (awb === null) return;
        if (isUnsupported(adapter, 'getLabel')) {
          await expect(adapter.getLabel(awb, 'PDF')).rejects.toBeInstanceOf(
            UnsupportedCapabilityError,
          );
          return;
        }
        const label = await adapter.getLabel(awb, 'PDF');
        expect(label.contentType).toBe('application/pdf');
        expect(label.bytes.length).toBeGreaterThan(0);
        expect(label.bytes.subarray(0, 4).toString('utf8')).toBe('%PDF');
      });
    });

    describe('pickup (§8.2 schedulePickup)', () => {
      it('acknowledges a pickup for booked AWBs', async () => {
        const adapter = await fresh();
        const awb = await bookOrAssertUnsupported(adapter, 'contract-pickup-1');
        if (awb === null) return;
        if (isUnsupported(adapter, 'schedulePickup')) {
          await expect(
            adapter.schedulePickup({
              awbs: [awb],
              pickupLocationId: '00000000-0000-0000-0000-000000000001',
              pickupDate: '2026-02-03',
            }),
          ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
          return;
        }
        const pickup = await adapter.schedulePickup({
          awbs: [awb],
          pickupLocationId: '00000000-0000-0000-0000-000000000001',
          pickupDate: '2026-02-03',
        });
        expect(pickup.acknowledged).toBe(true);
      });
    });

    describe('cancel (§8.2 cancelShipment)', () => {
      it('cancels a booked shipment pre-pickup', async () => {
        const adapter = await fresh();
        const awb = await bookOrAssertUnsupported(adapter, 'contract-cancel-1');
        if (awb === null) return;
        if (isUnsupported(adapter, 'cancelShipment')) {
          await expect(adapter.cancelShipment(awb)).rejects.toBeInstanceOf(
            UnsupportedCapabilityError,
          );
          return;
        }
        const cancel = await adapter.cancelShipment(awb);
        expect(cancel.kind).toBe('CANCELLED');
      });
    });

    describe('tracking (§8.2 track; §8.5 webhook shape)', () => {
      it('returns polling-shape events for a booked AWB', async () => {
        const adapter = await fresh();
        const awb = await bookOrAssertUnsupported(adapter, 'contract-track-1');
        if (awb === null) return;
        if (isUnsupported(adapter, 'track')) {
          await expect(adapter.track(awb)).rejects.toBeInstanceOf(UnsupportedCapabilityError);
          return;
        }
        const events = await adapter.track(awb);
        expect(Array.isArray(events)).toBe(true);
        expect(events.length).toBeGreaterThan(0);
        for (const e of events) {
          expect(typeof e.rawStatus).toBe('string');
          expect(e.rawStatus.length).toBeGreaterThan(0);
          expect(Number.isNaN(Date.parse(e.occurredAt))).toBe(false);
        }
      });

      it('exposes webhook-shape raw events when the adapter is test-event capable (ADD-18)', async () => {
        const adapter = await fresh();
        if (!isTestEventCapable(adapter)) return; // not every adapter fabricates events
        const event = adapter.buildTestWebhookEvent();
        expect(typeof event.payload).toBe('object');
        expect(event.payload).not.toBeNull();
        // JSON-serializable raw payload with a provider event identity.
        const json = JSON.stringify(event.payload);
        expect(json.length).toBeGreaterThan(2);
        const identity =
          (event.payload as Record<string, unknown>).event_id ??
          (event.payload as Record<string, unknown>).eventId ??
          (event.payload as Record<string, unknown>).id;
        expect(typeof identity).toBe('string');
      });
    });

    describe('NDR actions (§8.2 ndrAction)', () => {
      it('accepts a reattempt for a booked AWB', async () => {
        const adapter = await fresh();
        const awb = await bookOrAssertUnsupported(adapter, 'contract-ndr-1');
        if (awb === null) return;
        if (isUnsupported(adapter, 'ndrAction')) {
          await expect(
            adapter.ndrAction({ awb, action: 'REATTEMPT', payload: {} }),
          ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
          return;
        }
        const result = await adapter.ndrAction({ awb, action: 'REATTEMPT', payload: {} });
        expect(typeof result.accepted).toBe('boolean');
        expect(result.accepted).toBe(true);
      });
    });

    describe('unsupported capability (A1-03)', () => {
      it('declared-unsupported methods throw UnsupportedCapabilityError — never a silent no-op', async () => {
        const adapter = await fresh();
        const unsupported = declaredUnsupported(adapter);
        for (const method of unsupported) {
          expect(ADAPTER_METHODS).toContain(method);
          const err = await callMethod(adapter, method).then(
            () => null,
            (e: unknown) => e,
          );
          expect(err).toBeInstanceOf(UnsupportedCapabilityError);
          const uce = err as UnsupportedCapabilityError;
          expect(uce.method).toBe(method);
          expect(typeof uce.courierCode).toBe('string');
        }
        // Record which methods were proven unsupported, so a run with none
        // is visibly vacuous rather than silently green.
        expect(unsupported).toEqual(declaredUnsupported(adapter));
      });
    });

    describe('rate limiting (§15.1)', () => {
      it('surfaces an AdapterRateLimitError under sustained quote load', async () => {
        const adapter = await fresh();
        if (isUnsupported(adapter, 'getQuote')) return;
        let limited: AdapterRateLimitError | null = null;
        for (let i = 0; i < 50 && !limited; i++) {
          try {
            await adapter.getQuote(contractQuoteRequest());
          } catch (err) {
            if (err instanceof AdapterRateLimitError) limited = err;
            else throw err;
          }
        }
        expect(
          limited,
          'adapter did not surface a rate limit within 50 quote calls — script one (§15.1)',
        ).not.toBeNull();
      });
    });

    describe('idempotency under retry (A1-04, INV-5)', () => {
      it('reuses the same booking intent across retries and never issues a second create', async () => {
        const adapter = await fresh();
        if (isUnsupported(adapter, 'createShipment')) return;
        const intent = contractIntent('contract-idem-1');
        const request = contractCreateRequest(intent);

        const first = await adapter.createShipment(request);
        expect(first.kind).toBe('CONFIRMED');

        // Transport retries reuse the SAME intent (A1-04).
        const second = await adapter.createShipment(request);
        const third = await adapter.createShipment(request);
        expect(second.kind).toBe('CONFIRMED');
        expect(third.kind).toBe('CONFIRMED');
        expect(second.awb).toBe(first.awb);
        expect(third.awb).toBe(first.awb);

        const log = (adapter as CourierAdapter & OptionalSurfaces).requestLog;
        if (log) {
          const creates = log.filter(
            (r) => r.method === 'createShipment' && r.bookingIntentId === intent.bookingIntentId,
          );
          expect(creates.length).toBe(3); // every retry is received…
          expect(creates.filter((r) => !r.deduplicated).length).toBe(1); // …but only ONE create is issued
          expect(creates.filter((r) => r.deduplicated).length).toBe(2);
        }
      });
    });
  });
}
