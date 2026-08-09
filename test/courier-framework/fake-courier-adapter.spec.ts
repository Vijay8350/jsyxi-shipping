import { describe, expect, it } from 'vitest';
import { UnsupportedCapabilityError } from '../../src/modules/courier-framework/adapter.types';
import { AdapterRateLimitError } from '../../src/modules/courier-framework/adapter-errors';
import { FakeCourierAdapter } from '../../src/modules/courier-framework/fake/fake-courier-adapter';
import {
  contractCreateRequest,
  contractIntent,
  contractQuoteRequest,
} from './contract-suite';

/** The fake adapter's determinism and scriptability (§15.1): same inputs →
 *  same outputs, no randomness, no clock dependence beyond injected now(). */
const NOW = new Date('2026-02-01T10:00:00.000Z');
const make = (profile = {}) => new FakeCourierAdapter(profile, () => NOW);

describe('FakeCourierAdapter (§15.1)', () => {
  it('is deterministic: two instances produce byte-identical outputs', async () => {
    const a = make();
    const b = make();
    const qa = await a.getQuote(contractQuoteRequest());
    const qb = await b.getQuote(contractQuoteRequest());
    expect(qa).toEqual(qb);

    const ra = await a.createShipment(contractCreateRequest(contractIntent('det-1')));
    const rb = await b.createShipment(contractCreateRequest(contractIntent('det-1')));
    expect(ra).toEqual(rb);

    const la = await a.getLabel(ra.awb!, 'PDF');
    const lb = await b.getLabel(rb.awb!, 'PDF');
    expect(la.bytes.equals(lb.bytes)).toBe(true);
  });

  it('computes freight exactly in paise (INV-15): 1.000kg same-region → ₹42.00', async () => {
    const quote = await make().getQuote(contractQuoteRequest());
    // 1.000kg ⇒ 2 billable 0.5kg units ⇒ 4000 + 200 paise, no zone bump.
    expect(quote.components[0]).toEqual({
      code: 'F-5',
      label: 'Base freight',
      amount: '42.00',
      taxable: true,
    });
    expect(quote.total).toBe('42.00');
  });

  it('adds a deterministic COD component (₹15 + 1% of collectible)', async () => {
    const quote = await make().getQuote(
      contractQuoteRequest({ paymentMode: 'COD', collectible: '1000.00' }),
    );
    expect(quote.components[1]).toEqual({
      code: 'F-7',
      label: 'COD charge',
      amount: '25.00', // 1500 + 100000/100 paise
      taxable: false,
    });
    expect(quote.total).toBe('67.00');
  });

  it('issues AWBs from a deterministic sequence', async () => {
    const adapter = make();
    const r1 = await adapter.createShipment(contractCreateRequest(contractIntent('seq-1')));
    const r2 = await adapter.createShipment(contractCreateRequest(contractIntent('seq-2')));
    expect(r1.awb).toBe('FAKE0000000001');
    expect(r2.awb).toBe('FAKE0000000002');
  });

  it('records the create on a scripted timeout so lookupByReference resolves it (INV-5)', async () => {
    const adapter = make();
    const intent = contractIntent('contract-timeout-x');
    const result = await adapter.createShipment(contractCreateRequest(intent));
    expect(result.kind).toBe('OUTCOME_UNKNOWN');
    const lookup = await adapter.lookupByReference(intent.merchantReference);
    expect(lookup).toEqual({ found: true, awb: 'FAKE0000000001' });
  });

  it('never issues a second create for a retried intent — proven via the request log (A1-04)', async () => {
    const adapter = make();
    const intent = contractIntent('idem-1');
    const request = contractCreateRequest(intent);
    const first = await adapter.createShipment(request);
    const second = await adapter.createShipment(request);
    expect(second.awb).toBe(first.awb);
    const creates = adapter.requestLog.filter(
      (r) => r.method === 'createShipment' && r.bookingIntentId === 'idem-1',
    );
    expect(creates).toHaveLength(2);
    expect(creates.filter((r) => !r.deduplicated)).toHaveLength(1);
    expect(creates.filter((r) => r.deduplicated)).toHaveLength(1);
  });

  it('declared-unsupported capabilities throw UnsupportedCapabilityError (A1-03)', async () => {
    const adapter = make({ unsupportedMethods: ['ndrAction'] });
    const booking = await adapter.createShipment(contractCreateRequest(contractIntent('u-1')));
    await expect(
      adapter.ndrAction({ awb: booking.awb!, action: 'REATTEMPT', payload: {} }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it('scripts a quote rate limit (§15.1)', async () => {
    const adapter = make({ quoteRateLimit: 2 });
    await adapter.getQuote(contractQuoteRequest());
    await adapter.getQuote(contractQuoteRequest());
    await expect(adapter.getQuote(contractQuoteRequest())).rejects.toBeInstanceOf(
      AdapterRateLimitError,
    );
  });

  it('scripts NDR rejection per action type', async () => {
    const adapter = make({ ndrRejectActions: ['INITIATE_RTO'] });
    const booking = await adapter.createShipment(contractCreateRequest(contractIntent('n-1')));
    const reject = await adapter.ndrAction({
      awb: booking.awb!,
      action: 'INITIATE_RTO',
      payload: {},
    });
    expect(reject.accepted).toBe(false);
    const accept = await adapter.ndrAction({
      awb: booking.awb!,
      action: 'REATTEMPT',
      payload: {},
    });
    expect(accept.accepted).toBe(true);
  });

  it('cancel after pickup is rejected; plain cancel succeeds', async () => {
    const adapter = make();
    const booking = await adapter.createShipment(contractCreateRequest(contractIntent('c-1')));
    await adapter.schedulePickup({
      awbs: [booking.awb!],
      pickupLocationId: 'loc',
      pickupDate: '2026-02-03',
    });
    const rejected = await adapter.cancelShipment(booking.awb!);
    expect(rejected.kind).toBe('REJECTED');

    const other = await adapter.createShipment(contractCreateRequest(contractIntent('c-2')));
    const cancelled = await adapter.cancelShipment(other.awb!);
    expect(cancelled.kind).toBe('CANCELLED');
  });

  it('fabricates a webhook-shape test event (ADD-18)', async () => {
    const adapter = make();
    await adapter.createShipment(contractCreateRequest(contractIntent('w-1')));
    const event = adapter.buildTestWebhookEvent();
    expect(event.payload).toMatchObject({
      awb: 'FAKE0000000001',
      status: 'IN_TRANSIT',
      occurred_at: NOW.toISOString(),
    });
    expect(typeof (event.payload as { event_id: string }).event_id).toBe('string');
  });
});
