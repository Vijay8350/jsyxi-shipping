import { vi } from 'vitest';

/**
 * Scripted mock Blue Dart server, injected into BluedartAdapter as
 * `fetchFn`. Implements the §15.1 contract-suite conventions against the
 * best-known Blue Dart shapes from bluedart-api.map.ts:
 *
 * - destination pincode '999999' is unserviceable (absent from pinCodes);
 * - a create whose CreditReferenceNo contains 'contract-timeout-' is
 *   RECORDED server-side (so lookupByReference resolves it) but the create
 *   call itself times out → OUTCOME_UNKNOWN (INV-5);
 * - `quoteRateLimit`: the pricing endpoint answers 429 (Retry-After: 60)
 *   after N successful calls, so the suite's sustained quote load surfaces
 *   AdapterRateLimitError;
 * - the login endpoint validates client_id/client_secret and issues a JWT;
 *   any other Authorization gets 401. `expireAllTokens()` simulates token
 *   expiry so the adapter's 401 → refresh → retry-once path is exercised.
 *
 * Every response shape mirrors bluedart-api.map.ts; when the sandbox pass
 * corrects the map, correct this harness the same way.
 */

export const MOCK_CLIENT_ID = 'mock-bluedart-client-id';
export const MOCK_CLIENT_SECRET = 'mock-bluedart-client-secret';

interface MockShipment {
  awb: string;
  refno: string;
  cancelled: boolean;
}

export interface MockBluedartOptions {
  /** Successful pricing calls allowed before 429 responses. */
  quoteRateLimit?: number;
  /** Expected credentials; any other login body gets 401. */
  expectedClientId?: string;
  expectedClientSecret?: string;
  /** When true, the login endpoint always answers 401. */
  failLogin?: boolean;
  /** When false, serviceability reports codAvailable: 'N' for every pin. */
  codServiceable?: boolean;
}

export interface MockBluedart {
  fetchFn: typeof fetch;
  /** Recorded calls (path + parsed detail) for assertions. */
  calls: Array<{ path: string; url: string; body?: string }>;
  /** Server-side shipments by AWB. */
  shipments: Map<string, MockShipment>;
  awbSeq: { value: number };
  loginCalls: { value: number };
  quoteCalls: { value: number };
  createCalls: { value: number };
  /** Invalidate every issued token (simulates JWT expiry server-side). */
  expireAllTokens: () => void;
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

export function createMockBluedart(options: MockBluedartOptions = {}): MockBluedart {
  const expectedClientId = options.expectedClientId ?? MOCK_CLIENT_ID;
  const expectedClientSecret = options.expectedClientSecret ?? MOCK_CLIENT_SECRET;
  const validTokens = new Set<string>();
  let tokenSeq = 0;

  const state: MockBluedart = {
    fetchFn: undefined as unknown as typeof fetch,
    calls: [],
    shipments: new Map(),
    awbSeq: { value: 0 },
    loginCalls: { value: 0 },
    quoteCalls: { value: 0 },
    createCalls: { value: 0 },
    expireAllTokens: () => validTokens.clear(),
  };

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const path = url.pathname;
    const body = typeof init?.body === 'string' ? init.body : undefined;
    state.calls.push({ path, url: url.toString(), body });

    // ---- token login ---------------------------------------------------
    if (path === '/in/transportation/token/v1/login') {
      state.loginCalls.value += 1;
      let creds: { client_id?: string; client_secret?: string } = {};
      try {
        creds = JSON.parse(body ?? '{}') as typeof creds;
      } catch {
        /* malformed login body → 401 below */
      }
      if (
        options.failLogin ||
        creds.client_id !== expectedClientId ||
        creds.client_secret !== expectedClientSecret
      ) {
        return json({ error: 'invalid_client' }, 401);
      }
      tokenSeq += 1;
      const token = `BDT-MOCK-TOKEN-${tokenSeq}`;
      validTokens.add(token);
      return json({ JWTToken: token, expires_in: 3600, token_type: 'Bearer' });
    }

    // ---- auth gate (everything else needs a valid JWT) -----------------
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(auth);
    if (!match || !validTokens.has(match[1])) {
      return json({ error: 'unauthorized' }, 401);
    }

    // ---- serviceability -------------------------------------------------
    if (path === '/in/transportation/serviceability/v1/pincode') {
      const filter = (url.searchParams.get('pinCodes') ?? '').split(',').filter(Boolean);
      const codFlag = options.codServiceable === false ? 'N' : 'Y';
      const pinCodes = filter
        .filter((pin) => pin !== '999999')
        .map((pinCode) => ({
          pinCode,
          serviceable: 'Y',
          codAvailable: codFlag,
          prepaidAvailable: 'Y',
        }));
      return json({ pinCodes });
    }

    // ---- pricing (transit time & price) ---------------------------------
    if (path === '/in/transportation/pricing/v1/transitTimeAndPrice') {
      state.quoteCalls.value += 1;
      if (options.quoteRateLimit !== undefined && state.quoteCalls.value > options.quoteRateLimit) {
        return json({ error: 'rate limit exceeded' }, 429, { 'Retry-After': '60' });
      }
      const isCod = url.searchParams.get('paymentType') === 'COD';
      return json({
        price: {
          freightCharge: 64.4,
          fuelSurcharge: 9.6,
          codCharge: isCod ? 35 : 0,
          gstAmount: 13.32,
          totalAmount: isCod ? 122.32 : 87.32,
          expectedDeliveryDate: '2026-02-06',
        },
      });
    }

    // ---- GenerateWayBill -------------------------------------------------
    if (path === '/in/transportation/waybill/v1/GenerateWayBill') {
      state.createCalls.value += 1;
      const data = JSON.parse(body ?? '{}') as {
        Request: { Services: { CreditReferenceNo: string } };
      };
      const refno = data.Request.Services.CreditReferenceNo;
      state.awbSeq.value += 1;
      const awb = `BD${String(state.awbSeq.value).padStart(9, '0')}`;
      // §15.1 convention: record server-side, then time out (INV-5).
      state.shipments.set(awb, { awb, refno, cancelled: false });
      if (refno.includes('contract-timeout-')) {
        return timeoutRejection();
      }
      return json({
        GenerateWayBillResult: {
          AWBNo: awb,
          CCRCRDREF: refno,
          Status: [{ StatusType: 'Success', StatusInformation: 'Waybill generated' }],
        },
      });
    }

    // ---- tracking / reference lookup -------------------------------------
    if (path === '/in/transportation/tracking/v1/shipment') {
      const byAwb = url.searchParams.get('handl');
      const byRef = url.searchParams.get('refno');
      let shipment: MockShipment | undefined;
      if (byAwb) shipment = state.shipments.get(byAwb);
      if (!shipment && byRef) {
        shipment = [...state.shipments.values()].find((s) => s.refno === byRef);
      }
      if (!shipment) return json({ ShipmentData: {} });
      return json({
        ShipmentData: {
          Shipment: {
            Shipment: {
              AWBNo: shipment.awb,
              Status: shipment.cancelled ? 'Shipment Cancelled' : 'In Transit',
              StatusDate: '2026-02-02',
              StatusTime: '09:00:00',
              StatusLocation: 'Delhi Hub',
              Instructions: null,
            },
            Scans: {
              ScanDetail: [
                {
                  Scan: 'Shipment Booked',
                  ScanCode: 'BKD',
                  ScanDate: '2026-02-01',
                  ScanTime: '10:00:00',
                  ScannedLocation: 'Origin Hub',
                  Instructions: null,
                },
                {
                  Scan: 'Picked Up',
                  ScanCode: 'PKD',
                  ScanDate: '2026-02-01',
                  ScanTime: '18:00:00',
                  ScannedLocation: 'Origin Hub',
                  Instructions: null,
                },
                {
                  Scan: shipment.cancelled ? 'Shipment Cancelled' : 'In Transit',
                  ScanCode: shipment.cancelled ? 'CNL' : 'INT',
                  ScanDate: '2026-02-02',
                  ScanTime: '09:00:00',
                  ScannedLocation: 'Delhi Hub',
                  Instructions: null,
                },
              ],
            },
          },
        },
      });
    }

    // ---- CancelWaybill ----------------------------------------------------
    if (path === '/in/transportation/waybill/v1/CancelWaybill') {
      const data = JSON.parse(body ?? '{}') as { Request: { AWBNo: string } };
      const shipment = state.shipments.get(data.Request.AWBNo);
      if (!shipment || shipment.cancelled) {
        return json({
          CancelWaybillResult: {
            IsError: true,
            Status: [
              {
                StatusType: 'Error',
                StatusInformation: shipment ? 'already cancelled' : 'waybill not found',
              },
            ],
          },
        });
      }
      shipment.cancelled = true;
      return json({
        CancelWaybillResult: {
          IsError: false,
          Status: [{ StatusType: 'Success', StatusInformation: 'Waybill cancelled' }],
        },
      });
    }

    // ---- RegisterPickup ----------------------------------------------------
    if (path === '/in/transportation/pickup/v1/RegisterPickup') {
      return json({
        RegisterPickupResult: {
          ConfirmationNo: 'PKP-BD-MOCK-0001',
          Status: [{ StatusType: 'Success', StatusInformation: 'Pickup registered' }],
        },
      });
    }

    // ---- label PDF ----------------------------------------------------------
    if (path === '/in/transportation/waybill/v1/GetGeneratedWaybill/forprint') {
      const awb = url.searchParams.get('AWBNo') ?? 'unknown';
      const pdf = `%PDF-1.4\n% Blue Dart mock waybill label\n% awb=${awb}\n%%EOF\n`;
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
