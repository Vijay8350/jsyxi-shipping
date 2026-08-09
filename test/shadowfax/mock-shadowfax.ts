import { vi } from 'vitest';

/**
 * Scripted mock Shadowfax server, injected into ShadowfaxAdapter as
 * `fetchFn`. Implements the §15.1 contract-suite conventions against the
 * best-known Shadowfax shapes from shadowfax-api.map.ts:
 *
 * - a create whose `client_order_id` contains 'contract-timeout-' is
 *   RECORDED server-side (so lookupByReference resolves it) but the create
 *   call itself times out → OUTCOME_UNKNOWN (INV-5);
 * - `trackRateLimit`: the tracking endpoint answers 429 (Retry-After: 60)
 *   after N successful calls, so the unit spec can assert the
 *   AdapterRateLimitError mapping (getQuote is declared unsupported, so
 *   the suite's quote-hammer row does not apply — A1-03);
 * - a wrong/missing `Authorization: Token …` header gets 401.
 *
 * Every response shape mirrors shadowfax-api.map.ts; when the sandbox pass
 * corrects the map, correct this harness the same way.
 */

export const MOCK_API_KEY = 'mock-shadowfax-api-key';

interface MockOrder {
  awb: string;
  clientOrderId: string;
  cancelled: boolean;
}

export interface MockShadowfaxOptions {
  /** Successful tracking calls allowed before 429 responses. */
  trackRateLimit?: number;
  /** Expected api_key; any other Authorization gets 401. */
  expectedKey?: string;
  /** When true, every endpoint answers 401. */
  failAuth?: boolean;
}

export interface MockShadowfax {
  fetchFn: typeof fetch;
  /** Recorded calls (path + parsed detail) for assertions. */
  calls: Array<{ path: string; url: string; body?: string }>;
  /** Server-side orders by AWB. */
  orders: Map<string, MockOrder>;
  awbSeq: { value: number };
  createCalls: { value: number };
  trackCalls: { value: number };
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

function trackPayload(order: MockOrder): unknown {
  return {
    message: 'success',
    data: [
      {
        awb_number: order.awb,
        client_order_id: order.clientOrderId,
        current_status: order.cancelled ? 'Cancelled' : 'In Transit',
        scans: [
          {
            status: 'Created',
            scan_date_time: '2026-02-01T10:00:00.000Z',
            location: 'Origin Hub',
            remark: null,
          },
          {
            status: 'Picked Up',
            scan_date_time: '2026-02-01T18:00:00.000Z',
            location: 'Origin Hub',
            remark: null,
          },
          {
            status: order.cancelled ? 'Cancelled' : 'In Transit',
            scan_date_time: '2026-02-02T09:00:00.000Z',
            location: 'Delhi Hub',
            remark: null,
          },
        ],
      },
    ],
  };
}

export function createMockShadowfax(options: MockShadowfaxOptions = {}): MockShadowfax {
  const expectedKey = options.expectedKey ?? MOCK_API_KEY;
  const state: MockShadowfax = {
    fetchFn: undefined as unknown as typeof fetch,
    calls: [],
    orders: new Map(),
    awbSeq: { value: 0 },
    createCalls: { value: 0 },
    trackCalls: { value: 0 },
  };

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const path = url.pathname;
    const body = typeof init?.body === 'string' ? init.body : undefined;
    state.calls.push({ path, url: url.toString(), body });

    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization') ?? '';
    if (options.failAuth || auth !== `Token ${expectedKey}`) {
      return json({ message: 'unauthorized' }, 401);
    }

    // ---- create ---------------------------------------------------------
    if (path === '/api/v4/orders') {
      state.createCalls.value += 1;
      const data = JSON.parse(body ?? '{}') as { client_order_id: string };
      state.awbSeq.value += 1;
      const awb = `SFX${String(state.awbSeq.value).padStart(10, '0')}`;
      // §15.1 convention: record server-side, then time out (INV-5).
      state.orders.set(awb, { awb, clientOrderId: data.client_order_id, cancelled: false });
      if (data.client_order_id.includes('contract-timeout-')) {
        return timeoutRejection();
      }
      return json({
        message: 'success',
        data: { awb_number: awb, client_order_id: data.client_order_id },
      });
    }

    // ---- tracking / reference lookup ------------------------------------
    if (path === '/api/v1/track') {
      state.trackCalls.value += 1;
      if (options.trackRateLimit !== undefined && state.trackCalls.value > options.trackRateLimit) {
        return json({ message: 'rate limit exceeded' }, 429, { 'Retry-After': '60' });
      }
      const byAwb = url.searchParams.get('awb');
      const byRef = url.searchParams.get('client_order_id');
      let order: MockOrder | undefined;
      if (byAwb) order = state.orders.get(byAwb);
      if (!order && byRef) {
        order = [...state.orders.values()].find((o) => o.clientOrderId === byRef);
      }
      if (!order) return json({ message: 'success', data: [] });
      return json(trackPayload(order));
    }

    // ---- cancel -----------------------------------------------------------
    if (path === '/api/v1/orders/cancel') {
      const parsed = JSON.parse(body ?? '{}') as { awb?: string; awb_number?: string };
      const awb = parsed.awb ?? parsed.awb_number ?? '';
      const order = state.orders.get(awb);
      if (!order || order.cancelled) {
        return json({ success: false, message: order ? 'already cancelled' : 'awb not found' });
      }
      order.cancelled = true;
      return json({ success: true, message: 'cancelled' });
    }

    // ---- pickup -----------------------------------------------------------
    if (path === '/api/v1/pickup') {
      return json({ success: true, pickup_id: 'SFX-PKP-MOCK-0001' });
    }

    // ---- label ------------------------------------------------------------
    if (path === '/api/v1/label') {
      const awb = url.searchParams.get('awb') ?? 'unknown';
      const pdf = `%PDF-1.4\n% Shadowfax mock label\n% awb=${awb}\n%%EOF\n`;
      return new Response(Buffer.from(pdf, 'utf8'), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      });
    }

    // ---- NDR action --------------------------------------------------------
    if (path === '/api/v1/ndr/action') {
      return json({ success: true, request_id: 'SFX-NDR-MOCK-0001' });
    }

    return json({ message: `unmocked path ${path}` }, 404);
  }) as unknown as typeof fetch;

  state.fetchFn = fetchMock;
  return state;
}
