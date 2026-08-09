import { vi } from 'vitest';

/**
 * Scripted mock DTDC server, injected into DtdcAdapter as `fetchFn`.
 * Implements the §15.1 contract-suite conventions against the best-known
 * DTDC shapes from dtdc-api.map.ts:
 *
 * - destination pincode '999999' is unserviceable (absent from data);
 * - a create whose customer_reference_number contains 'contract-timeout-'
 *   is RECORDED server-side (so lookupByReference resolves it) but the
 *   create call itself times out → OUTCOME_UNKNOWN (INV-5);
 * - `quoteRateLimit`: the calculator endpoint answers 429 (Retry-After: 60)
 *   after N successful calls, so the suite's sustained quote load surfaces
 *   AdapterRateLimitError;
 * - a wrong/missing `X-Access-Token` header gets 401.
 *
 * Every response shape mirrors dtdc-api.map.ts; when the sandbox pass
 * corrects the map, correct this harness the same way.
 */

export const MOCK_API_KEY = 'mock-dtdc-api-key';

interface MockConsignment {
  awb: string;
  reference: string;
  cancelled: boolean;
}

export interface MockDtdcOptions {
  /** Successful calculator calls allowed before 429 responses. */
  quoteRateLimit?: number;
  /** Expected api_key; any other X-Access-Token gets 401. */
  expectedKey?: string;
  /** When true, every endpoint answers 401. */
  failAuth?: boolean;
  /** When false, serviceability reports cod_available: false for every pin. */
  codServiceable?: boolean;
}

export interface MockDtdc {
  fetchFn: typeof fetch;
  /** Recorded calls (path + parsed detail) for assertions. */
  calls: Array<{ path: string; url: string; body?: string }>;
  /** Server-side consignments by AWB. */
  consignments: Map<string, MockConsignment>;
  awbSeq: { value: number };
  quoteCalls: { value: number };
  createCalls: { value: number };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function timeoutRejection(): Promise<never> {
  // What undici rejects with when AbortSignal.timeout fires.
  return Promise.reject(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }));
}

export function createMockDtdc(options: MockDtdcOptions = {}): MockDtdc {
  const expectedKey = options.expectedKey ?? MOCK_API_KEY;
  const state: MockDtdc = {
    fetchFn: undefined as unknown as typeof fetch,
    calls: [],
    consignments: new Map(),
    awbSeq: { value: 0 },
    quoteCalls: { value: 0 },
    createCalls: { value: 0 },
  };

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const path = url.pathname;
    const body = typeof init?.body === 'string' ? init.body : undefined;
    state.calls.push({ path, url: url.toString(), body });

    const headers = new Headers(init?.headers);
    if (options.failAuth || headers.get('x-access-token') !== expectedKey) {
      return json({ error: 'unauthorized' }, 401);
    }

    // ---- serviceability ---------------------------------------------
    if (path === '/api/pincode/serviceable') {
      const req = JSON.parse(body ?? '{}') as {
        origin_pincode?: string;
        destination_pincode?: string;
      };
      const codFlag = options.codServiceable === false ? false : true;
      const data = [req.origin_pincode, req.destination_pincode]
        .filter((pin): pin is string => typeof pin === 'string' && pin.length > 0)
        .filter((pin) => pin !== '999999')
        .map((pin) => ({
          pincode: pin,
          serviceable: true,
          cod_available: codFlag,
          prepaid_available: true,
        }));
      return json({ success: true, data });
    }

    // ---- quote (rate calculator) -------------------------------------
    if (path === '/api/calculator') {
      state.quoteCalls.value += 1;
      if (options.quoteRateLimit !== undefined && state.quoteCalls.value > options.quoteRateLimit) {
        return json({ error: 'rate limit exceeded' }, 429, { 'Retry-After': '60' });
      }
      const req = JSON.parse(body ?? '{}') as { payment_type?: string };
      const isCod = req.payment_type === 'COD';
      return json({
        success: true,
        data: {
          charged_weight: '1.000',
          freight_charge: 52.5,
          fuel_surcharge: 8.25,
          cod_charge: isCod ? 20 : 0,
          rto_charge: 0,
          tax: 10.94,
          total_amount: isCod ? 91.69 : 71.69,
          expected_delivery_date: '2026-02-06',
        },
      });
    }

    // ---- consignment booking ------------------------------------------
    if (path === '/api/customer_awb_consignment_booking') {
      state.createCalls.value += 1;
      const req = JSON.parse(body ?? '{}') as { customer_reference_number?: string };
      const reference = req.customer_reference_number ?? '';
      state.awbSeq.value += 1;
      const awb = `DTDC${String(state.awbSeq.value).padStart(9, '0')}`;
      // §15.1 convention: record server-side, then time out (INV-5).
      state.consignments.set(awb, { awb, reference, cancelled: false });
      if (reference.includes('contract-timeout-')) {
        return timeoutRejection();
      }
      return json({
        success: true,
        data: {
          awb_number: awb,
          reference_number: reference,
          status: 'Success',
          charges: { total_amount: '71.69' },
        },
      });
    }

    // ---- tracking / reference lookup -----------------------------------
    if (path === '/api/track-json') {
      const byAwb = url.searchParams.get('awb');
      const byRef = url.searchParams.get('reference_number');
      let consignment: MockConsignment | undefined;
      if (byAwb) consignment = state.consignments.get(byAwb);
      if (!consignment && byRef) {
        consignment = [...state.consignments.values()].find((c) => c.reference === byRef);
      }
      if (!consignment) return json({ success: true, data: [] });
      return json({
        success: true,
        data: {
          awb_number: consignment.awb,
          reference_number: consignment.reference,
          current_status: consignment.cancelled ? 'Cancelled' : 'In Transit',
          status_date: '2026-02-02T09:00:00.000Z',
          location: 'Delhi Hub',
          scans: [
            {
              status: 'Booked',
              date: '2026-02-01T10:00:00.000Z',
              location: 'Origin Hub',
              remarks: null,
            },
            {
              status: 'Picked Up',
              date: '2026-02-01T18:00:00.000Z',
              location: 'Origin Hub',
              remarks: null,
            },
            {
              status: consignment.cancelled ? 'Cancelled' : 'In Transit',
              date: '2026-02-02T09:00:00.000Z',
              location: 'Delhi Hub',
              remarks: null,
            },
          ],
        },
      });
    }

    // ---- cancel ---------------------------------------------------------
    if (path === '/api/operations/consignment/cancel') {
      const req = JSON.parse(body ?? '{}') as { awb?: string };
      const consignment = req.awb ? state.consignments.get(req.awb) : undefined;
      if (!consignment || consignment.cancelled) {
        return json({
          success: false,
          message: consignment ? 'already cancelled' : 'consignment not found',
        });
      }
      consignment.cancelled = true;
      return json({ success: true });
    }

    // ---- pickup ---------------------------------------------------------
    if (path === '/api/pickup/request') {
      return json({ success: true, pickup_request_id: 'DTDC-PKP-0001' });
    }

    // ---- label ----------------------------------------------------------
    if (path === '/api/operations/label') {
      const awb = url.searchParams.get('awb') ?? 'unknown';
      const pdf = `%PDF-1.4\n% DTDC mock label\n% awb=${awb}\n%%EOF\n`;
      return new Response(Buffer.from(pdf, 'utf8'), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      });
    }

    return json({ error: `unmocked path ${path}` }, 404);
  }) as unknown as typeof fetch;

  state.fetchFn = fetchMock;
  return state;
}
