import { vi } from 'vitest';
import type { TokenCache } from '../../src/modules/xpressbees/xpressbees.adapter';

/**
 * Scripted mock Xpressbees server, injected into XpressbeesAdapter as
 * `fetchFn`. Implements the §15.1 contract-suite conventions against the
 * best-known Xpressbees shapes from xpressbees-api.map.ts:
 *
 * - a create whose order_number contains 'contract-timeout-' is RECORDED
 *   server-side (so lookupByReference resolves it) but the create call
 *   itself times out → OUTCOME_UNKNOWN (INV-5);
 * - login (POST /api/users/login) mints bearer tokens; authed endpoints
 *   require `Authorization: Bearer <token>`; with `expireFirstToken` the
 *   first minted token answers 401 so the adapter's refresh-on-401 path is
 *   exercised (§9.3.3);
 * - `rateLimitPaths`: those endpoints answer 429 (Retry-After: 60) so the
 *   AdapterRateLimitError mapping is exercised;
 * - a wrong/missing bearer token gets 401; bad login credentials get 401.
 *
 * Every response shape mirrors xpressbees-api.map.ts; when the sandbox pass
 * corrects the map, correct this harness the same way.
 */

export const MOCK_EMAIL = 'merchant@example.test';
export const MOCK_PASSWORD = 'mock-xpressbees-password';

/** In-memory TokenCache for tests (production uses the Redis cache). */
export class InMemoryTokenCache implements TokenCache {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

interface MockShipment {
  awb: string;
  orderNumber: string;
  cancelled: boolean;
}

export interface MockXpressbeesOptions {
  /** Expected login credentials; any other login body gets 401. */
  expectedEmail?: string;
  expectedPassword?: string;
  /** When true, every login answers 401 (refresh failure → CourierAuthError). */
  failAuth?: boolean;
  /** When true, the first minted token is treated as expired (401), forcing
   *  the adapter's refresh-and-resend-once path. */
  expireFirstToken?: boolean;
  /** Endpoints (exact paths) that answer 429 with Retry-After: 60. */
  rateLimitPaths?: string[];
}

export interface MockXpressbees {
  fetchFn: typeof fetch;
  /** Recorded calls (path + parsed detail) for assertions. */
  calls: Array<{ path: string; url: string; body?: string }>;
  /** Server-side shipments by AWB. */
  shipments: Map<string, MockShipment>;
  awbSeq: { value: number };
  tokenSeq: { value: number };
  loginCalls: { value: number };
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

export function createMockXpressbees(options: MockXpressbeesOptions = {}): MockXpressbees {
  const expectedEmail = options.expectedEmail ?? MOCK_EMAIL;
  const expectedPassword = options.expectedPassword ?? MOCK_PASSWORD;
  const state: MockXpressbees = {
    fetchFn: undefined as unknown as typeof fetch,
    calls: [],
    shipments: new Map(),
    awbSeq: { value: 0 },
    tokenSeq: { value: 0 },
    loginCalls: { value: 0 },
    createCalls: { value: 0 },
  };
  /** Minted-but-expired token values (expireFirstToken simulation). */
  const expiredTokens = new Set<string>();
  /** Token values minted by this mock. */
  const liveTokens = new Set<string>();

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const path = url.pathname;
    const body = typeof init?.body === 'string' ? init.body : undefined;
    state.calls.push({ path, url: url.toString(), body });

    // ---- login ---------------------------------------------------------
    if (path === '/api/users/login') {
      state.loginCalls.value += 1;
      let creds: { email?: string; password?: string } = {};
      try {
        creds = JSON.parse(body ?? '{}') as typeof creds;
      } catch {
        creds = {};
      }
      if (
        options.failAuth ||
        creds.email !== expectedEmail ||
        creds.password !== expectedPassword
      ) {
        return json({ status: false, message: 'invalid credentials' }, 401);
      }
      state.tokenSeq.value += 1;
      const token = `XB-TOKEN-${state.tokenSeq.value}`;
      liveTokens.add(token);
      if (options.expireFirstToken && state.tokenSeq.value === 1) {
        expiredTokens.add(token);
      }
      return json({ status: true, data: { token, expires_in: 86400 } });
    }

    // ---- bearer check ----------------------------------------------------
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization') ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    if (!liveTokens.has(bearer) || expiredTokens.has(bearer)) {
      return json({ status: false, message: 'token expired or invalid' }, 401);
    }

    // ---- scripted rate limiting ------------------------------------------
    if (options.rateLimitPaths?.includes(path)) {
      return json({ status: false, message: 'rate limit exceeded' }, 429, { 'Retry-After': '60' });
    }

    // ---- create -----------------------------------------------------------
    if (path === '/api/shipments2') {
      state.createCalls.value += 1;
      const payload = JSON.parse(body ?? '{}') as { order_number: string };
      state.awbSeq.value += 1;
      const awb = `XB${String(state.awbSeq.value).padStart(11, '0')}`;
      // §15.1 convention: record server-side, then time out (INV-5).
      state.shipments.set(awb, { awb, orderNumber: payload.order_number, cancelled: false });
      if (payload.order_number.includes('contract-timeout-')) {
        return timeoutRejection();
      }
      return json({
        status: true,
        data: {
          awb_number: awb,
          order_number: payload.order_number,
          courier_name: 'Xpressbees Surface',
        },
      });
    }

    // ---- tracking / reference lookup --------------------------------------
    if (path === '/api/shipments2/track/') {
      const byAwb = url.searchParams.get('awb');
      const byRef = url.searchParams.get('order_number');
      let shipment: MockShipment | undefined;
      if (byAwb) shipment = state.shipments.get(byAwb);
      if (!shipment && byRef) {
        shipment = [...state.shipments.values()].find((s) => s.orderNumber === byRef);
      }
      if (!shipment) return json({ status: true, data: [] });
      return json({
        status: true,
        data: {
          awb_number: shipment.awb,
          order_number: shipment.orderNumber,
          status: shipment.cancelled ? 'cancelled' : 'in transit',
          status_date: '2026-02-02 09:00:00',
          history: [
            {
              status: 'pending',
              status_date: '2026-02-01 10:00:00',
              location: 'Origin Hub',
              remarks: null,
            },
            {
              status: 'picked',
              status_date: '2026-02-01 18:00:00',
              location: 'Origin Hub',
              remarks: null,
            },
            {
              status: shipment.cancelled ? 'cancelled' : 'in transit',
              status_date: '2026-02-02 09:00:00',
              location: 'Delhi Hub',
              remarks: null,
            },
          ],
        },
      });
    }

    // ---- cancel -------------------------------------------------------------
    if (path === '/api/shipments2/cancel') {
      const payload = JSON.parse(body ?? '{}') as { awb_number?: string };
      const shipment = payload.awb_number ? state.shipments.get(payload.awb_number) : undefined;
      if (!shipment || shipment.cancelled) {
        return json({ status: false, message: shipment ? 'already cancelled' : 'awb not found' });
      }
      shipment.cancelled = true;
      return json({ status: true });
    }

    // ---- pickup --------------------------------------------------------------
    if (path === '/api/pickups') {
      return json({ status: true, data: { pickup_id: 'PKP-XB-0001' } });
    }

    // ---- label -----------------------------------------------------------------
    if (path === '/api/shipments2/labels') {
      const awb = url.searchParams.get('awb') ?? 'unknown';
      const pdf = `%PDF-1.4\n% Xpressbees mock label\n% awb=${awb}\n%%EOF\n`;
      return new Response(Buffer.from(pdf, 'utf8'), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      });
    }

    // ---- NDR action --------------------------------------------------------------
    if (path === '/api/ndr/create') {
      return json({ status: true, data: { ndr_id: 'NDR-XB-0001' } });
    }

    return json({ error: `unmocked path ${path}` }, 404);
  }) as unknown as typeof fetch;

  state.fetchFn = fetchMock;
  return state;
}
