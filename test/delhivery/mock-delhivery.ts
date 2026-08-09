import { vi } from 'vitest';

/**
 * Scripted mock Delhivery server, injected into DelhiveryAdapter as
 * `fetchFn`. Implements the §15.1 contract-suite conventions against the
 * best-known Delhivery shapes from delhivery-api.map.ts:
 *
 * - destination pincode '999999' is unserviceable (empty delivery_codes);
 * - a create whose client reference contains 'contract-timeout-' is
 *   RECORDED server-side (so lookupByReference resolves it) but the create
 *   call itself times out → OUTCOME_UNKNOWN (INV-5);
 * - `quoteRateLimit`: the charges endpoint answers 429 (Retry-After: 60)
 *   after N successful calls, so the suite's sustained quote load surfaces
 *   AdapterRateLimitError;
 * - a wrong/missing `Authorization: Token …` header gets 401.
 *
 * Every response shape mirrors delhivery-api.map.ts; when the sandbox pass
 * corrects the map, correct this harness the same way.
 */

export const MOCK_API_TOKEN = 'mock-delhivery-token';

interface MockPackage {
  waybill: string;
  refnum: string;
  cancelled: boolean;
}

export interface MockDelhiveryOptions {
  /** Successful quote-charges calls allowed before 429 responses. */
  quoteRateLimit?: number;
  /** Expected api_token; any other Authorization gets 401. */
  expectedToken?: string;
  /** When true, every endpoint answers 401. */
  failAuth?: boolean;
  /** When false, serviceability reports cod: 'N' for every pin. */
  codServiceable?: boolean;
}

export interface MockDelhivery {
  fetchFn: typeof fetch;
  /** Recorded calls (path + parsed detail) for assertions. */
  calls: Array<{ path: string; url: string; body?: string }>;
  /** Server-side packages by waybill. */
  packages: Map<string, MockPackage>;
  waybillSeq: { value: number };
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

export function createMockDelhivery(options: MockDelhiveryOptions = {}): MockDelhivery {
  const expectedToken = options.expectedToken ?? MOCK_API_TOKEN;
  const state: MockDelhivery = {
    fetchFn: undefined as unknown as typeof fetch,
    calls: [],
    packages: new Map(),
    waybillSeq: { value: 0 },
    quoteCalls: { value: 0 },
    createCalls: { value: 0 },
  };

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const path = url.pathname;
    const body = typeof init?.body === 'string' ? init.body : undefined;
    state.calls.push({ path, url: url.toString(), body });

    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization') ?? '';
    if (options.failAuth || auth !== `Token ${expectedToken}`) {
      return json({ error: 'unauthorized' }, 401);
    }

    // ---- serviceability ---------------------------------------------
    if (path === '/c/api/pin-codes/json/') {
      const filter = (url.searchParams.get('filter_codes') ?? '').split(',').filter(Boolean);
      const codFlag = options.codServiceable === false ? 'N' : 'Y';
      const delivery_codes = filter
        .filter((pin) => pin !== '999999')
        .map((pin) => ({ postal_code: { pin, cod: codFlag, pre_paid: 'Y', is_oda: 'N' } }));
      return json({ delivery_codes });
    }

    // ---- quote (kinko invoice charges) -------------------------------
    if (path === '/api/kinko/v1/invoice/charges/.json') {
      state.quoteCalls.value += 1;
      if (options.quoteRateLimit !== undefined && state.quoteCalls.value > options.quoteRateLimit) {
        return json({ error: 'rate limit exceeded' }, 429, { 'Retry-After': '60' });
      }
      const isCod = url.searchParams.get('pt') === 'COD';
      return json([
        {
          charged_weight: '1.000',
          charge_DL: 52.5,
          charge_FSC: 8.25,
          charge_COD: isCod ? 20 : 0,
          charge_RTO: 0,
          tax: 10.94,
          total_amount: isCod ? 91.69 : 71.69,
          expected_delivery_date: '2026-02-06',
        },
      ]);
    }

    // ---- bulk waybill -------------------------------------------------
    if (path === '/waybill/api/bulk/json/') {
      state.waybillSeq.value += 1;
      return json([`DLV${String(state.waybillSeq.value).padStart(11, '0')}`]);
    }

    // ---- CMU create ----------------------------------------------------
    if (path === '/api/cmu/create.json') {
      state.createCalls.value += 1;
      const data = JSON.parse(
        decodeURIComponent((body ?? '').replace(/^format=json&data=/, '')),
      ) as { shipments: Array<{ waybill: string; order: string }> };
      const shipment = data.shipments[0];
      // §15.1 convention: record server-side, then time out (INV-5).
      state.packages.set(shipment.waybill, {
        waybill: shipment.waybill,
        refnum: shipment.order,
        cancelled: false,
      });
      if (shipment.order.includes('contract-timeout-')) {
        return timeoutRejection();
      }
      return json({
        success: true,
        packages: [
          {
            waybill: shipment.waybill,
            refnum: shipment.order,
            status: 'Success',
            sort_code: 'DEL/ABC',
          },
        ],
      });
    }

    // ---- tracking / reference lookup -----------------------------------
    if (path === '/api/v1/packages/json/') {
      const byWaybill = url.searchParams.get('waybill');
      const byRef = url.searchParams.get('ref_ids');
      let pkg: MockPackage | undefined;
      if (byWaybill) pkg = state.packages.get(byWaybill);
      if (!pkg && byRef) {
        pkg = [...state.packages.values()].find((p) => p.refnum === byRef);
      }
      if (!pkg) return json({ ShipmentData: [] });
      return json({
        ShipmentData: [
          {
            Shipment: {
              AWB: pkg.waybill,
              Status: {
                Status: pkg.cancelled ? 'Cancelled' : 'In Transit',
                StatusDateTime: '2026-02-02T09:00:00.000Z',
                StatusLocation: 'Delhi Hub',
                Instructions: null,
              },
              Scans: [
                {
                  ScanDetail: {
                    Scan: 'Manifested',
                    ScanDateTime: '2026-02-01T10:00:00.000Z',
                    ScannedLocation: 'Origin Hub',
                    Instructions: null,
                  },
                },
                {
                  ScanDetail: {
                    Scan: 'Picked Up',
                    ScanDateTime: '2026-02-01T18:00:00.000Z',
                    ScannedLocation: 'Origin Hub',
                    Instructions: null,
                  },
                },
                {
                  ScanDetail: {
                    Scan: pkg.cancelled ? 'Cancelled' : 'In Transit',
                    ScanDateTime: '2026-02-02T09:00:00.000Z',
                    ScannedLocation: 'Delhi Hub',
                    Instructions: null,
                  },
                },
              ],
            },
          },
        ],
      });
    }

    // ---- cancel ---------------------------------------------------------
    if (path === '/api/p/edit') {
      const waybill = new URLSearchParams(body ?? '').get('waybill') ?? '';
      const pkg = state.packages.get(waybill);
      if (!pkg || pkg.cancelled) {
        return json({ status: false, message: pkg ? 'already cancelled' : 'waybill not found' });
      }
      pkg.cancelled = true;
      return json({ status: true });
    }

    // ---- pickup ---------------------------------------------------------
    if (path === '/fm/request/new/') {
      return json({ success: true, pickup_id: 'PKP-MOCK-0001' });
    }

    // ---- packing slip ---------------------------------------------------
    if (path === '/api/p/packing_slip') {
      const waybill = url.searchParams.get('waybill') ?? 'unknown';
      const pdf = `%PDF-1.4\n% Delhivery mock packing slip\n% waybill=${waybill}\n%%EOF\n`;
      return new Response(Buffer.from(pdf, 'utf8'), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      });
    }

    // ---- NDR action -----------------------------------------------------
    if (path === '/api/p/ndr_action/') {
      return json({ status: true, request_id: 'NDR-MOCK-0001' });
    }

    return json({ error: `unmocked path ${path}` }, 404);
  }) as unknown as typeof fetch;

  state.fetchFn = fetchMock;
  return state;
}
