import { vi } from 'vitest';
import type { ShiprocketTokenCache } from '../../src/modules/shiprocket/shiprocket.adapter';

/**
 * Scripted mock Shiprocket server, injected into ShiprocketAdapter as
 * `fetchFn`. Implements the §15.1 contract-suite conventions against the
 * best-known Shiprocket shapes from shiprocket-api.map.ts:
 *
 * - a create whose order_id contains 'contract-timeout-' is RECORDED
 *   server-side — order created AND AWB assigned atomically, so
 *   lookupByReference resolves it — but the create call itself times out
 *   → OUTCOME_UNKNOWN (INV-5);
 * - delivery_postcode '999999' is conventionally unserviceable (empty
 *   available_courier_companies, §8.3);
 * - login (POST /auth/login) mints bearer tokens; authed endpoints require
 *   `Authorization: Bearer <token>`; with `expireFirstToken` the first
 *   minted token answers 401 so the adapter's refresh-on-401 path is
 *   exercised (§9.3.3);
 * - after `quoteRateLimitAfter` serviceability calls (default 40) the
 *   serviceability endpoint answers 429 (Retry-After: 60), so the §15.1
 *   rate-limit row is exercised; `rateLimitPaths` forces 429 on demand;
 * - a wrong/missing bearer token gets 401; bad login credentials get 401.
 *
 * Every response shape mirrors shiprocket-api.map.ts; when the sandbox pass
 * corrects the map, correct this harness the same way.
 */

export const MOCK_EMAIL = 'merchant@example.test';
export const MOCK_PASSWORD = 'mock-shiprocket-password';

/** In-memory ShiprocketTokenCache for tests (production uses Redis). */
export class InMemoryShiprocketTokenCache implements ShiprocketTokenCache {
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

interface MockOrder {
  /** The merchant reference (Shiprocket channel order id). */
  ref: string;
  orderId: string;
  shipmentId: string;
  awb: string;
  cancelled: boolean;
}

export interface MockShiprocketOptions {
  /** Expected login credentials; any other login body gets 401. */
  expectedEmail?: string;
  expectedPassword?: string;
  /** When true, every login answers 401 (refresh failure → CourierAuthError). */
  failAuth?: boolean;
  /** When true, the first minted token is treated as expired (401), forcing
   *  the adapter's refresh-and-resend-once path. */
  expireFirstToken?: boolean;
  /** Serviceability calls allowed before a 429 (default 40, < the §15.1
   *  suite's 50-call hammer). null disables the scripted limit. */
  quoteRateLimitAfter?: number | null;
  /** Endpoint path suffixes that answer 429 with Retry-After: 60. */
  rateLimitPaths?: string[];
}

export interface MockShiprocket {
  fetchFn: typeof fetch;
  /** Recorded calls (path + parsed detail) for assertions. */
  calls: Array<{ path: string; url: string; body?: string }>;
  /** Server-side orders by merchant reference. */
  orders: Map<string, MockOrder>;
  orderSeq: { value: number };
  shipmentSeq: { value: number };
  awbSeq: { value: number };
  tokenSeq: { value: number };
  loginCalls: { value: number };
  createCalls: { value: number };
  assignCalls: { value: number };
  serviceabilityCalls: { value: number };
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

export function createMockShiprocket(options: MockShiprocketOptions = {}): MockShiprocket {
  const expectedEmail = options.expectedEmail ?? MOCK_EMAIL;
  const expectedPassword = options.expectedPassword ?? MOCK_PASSWORD;
  const quoteRateLimitAfter =
    options.quoteRateLimitAfter === undefined ? 40 : options.quoteRateLimitAfter;
  const state: MockShiprocket = {
    fetchFn: undefined as unknown as typeof fetch,
    calls: [],
    orders: new Map(),
    orderSeq: { value: 0 },
    shipmentSeq: { value: 0 },
    awbSeq: { value: 0 },
    tokenSeq: { value: 0 },
    loginCalls: { value: 0 },
    createCalls: { value: 0 },
    assignCalls: { value: 0 },
    serviceabilityCalls: { value: 0 },
  };
  /** Minted-but-expired token values (expireFirstToken simulation). */
  const expiredTokens = new Set<string>();
  /** Token values minted by this mock. */
  const liveTokens = new Set<string>();

  const byAwb = (awb: string): MockOrder | undefined =>
    [...state.orders.values()].find((o) => o.awb === awb);
  const byShipmentId = (id: string): MockOrder | undefined =>
    [...state.orders.values()].find((o) => o.shipmentId === id);

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const path = url.pathname;
    const body = typeof init?.body === 'string' ? init.body : undefined;
    state.calls.push({ path, url: url.toString(), body });

    // ---- generated-label download (pre-signed URL host) -------------------
    if (path.startsWith('/labels/')) {
      const pdf = `%PDF-1.4\n% Shiprocket mock label\n% file=${path}\n%%EOF\n`;
      return new Response(Buffer.from(pdf, 'utf8'), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      });
    }

    // ---- login -------------------------------------------------------------
    if (path.endsWith('/auth/login')) {
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
        return json({ message: 'invalid credentials' }, 401);
      }
      state.tokenSeq.value += 1;
      const token = `SR-TOKEN-${state.tokenSeq.value}`;
      liveTokens.add(token);
      if (options.expireFirstToken && state.tokenSeq.value === 1) {
        expiredTokens.add(token);
      }
      return json({ token, expires_in: 864000 });
    }

    // ---- bearer check --------------------------------------------------------
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization') ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    if (!liveTokens.has(bearer) || expiredTokens.has(bearer)) {
      return json({ message: 'token expired or invalid' }, 401);
    }

    // ---- scripted rate limiting ------------------------------------------------
    if (options.rateLimitPaths?.some((p) => path.includes(p))) {
      return json({ message: 'rate limit exceeded' }, 429, { 'Retry-After': '60' });
    }

    // ---- serviceability (the §8.3 LIVE_QUOTE surface) -------------------------
    if (path.endsWith('/courier/serviceability')) {
      state.serviceabilityCalls.value += 1;
      if (quoteRateLimitAfter !== null && state.serviceabilityCalls.value > quoteRateLimitAfter) {
        return json({ message: 'rate limit exceeded' }, 429, { 'Retry-After': '60' });
      }
      const delivery = url.searchParams.get('delivery_postcode') ?? '';
      const cod = url.searchParams.get('cod') === '1';
      if (delivery === '999999') {
        return json({ status: 200, data: { available_courier_companies: [] } });
      }
      const courier = (
        id: number,
        name: string,
        freight: number,
        codCharges: number,
        other: number,
        rto: number,
      ) => ({
        courier_company_id: id,
        courier_name: name,
        freight_charge: freight,
        cod_charges: cod ? codCharges : 0,
        other_charges: other,
        rate: freight + (cod ? codCharges : 0) + other,
        rto_charges: rto,
        etd: '2026-02-05',
        estimated_delivery_days: '4',
        cod: 1,
      });
      return json({
        status: 200,
        data: {
          available_courier_companies: [
            courier(39, 'Mock Courier L039', 42.5, 15, 0, 42.5),
            courier(14, 'Mock Courier L014', 50, 18, 0, 25),
          ],
          recommended_courier_company_id: 39,
        },
      });
    }

    // ---- order create (booking step 1) ----------------------------------------
    if (path.endsWith('/orders/create/adhoc')) {
      state.createCalls.value += 1;
      const payload = JSON.parse(body ?? '{}') as { order_id: string };
      const existing = state.orders.get(payload.order_id);
      if (existing) {
        // Shiprocket-side idempotency: the merchant reference is unique.
        return json({ message: 'Duplicate Order ID', status_code: 26 });
      }
      state.orderSeq.value += 1;
      state.shipmentSeq.value += 1;
      state.awbSeq.value += 1;
      const order: MockOrder = {
        ref: payload.order_id,
        orderId: String(7_000_000 + state.orderSeq.value),
        shipmentId: String(9_000_000 + state.shipmentSeq.value),
        awb: `SR${String(state.awbSeq.value).padStart(12, '0')}`,
        cancelled: false,
      };
      // §15.1 convention: record server-side, then time out (INV-5).
      state.orders.set(order.ref, order);
      if (payload.order_id.includes('contract-timeout-')) {
        return timeoutRejection();
      }
      return json({
        order_id: order.orderId,
        shipment_id: order.shipmentId,
        status: 'NEW',
        status_code: 1,
      });
    }

    // ---- AWB assign (booking step 2 — the nested-identity selection) -----------
    if (path.endsWith('/courier/assign/awb')) {
      state.assignCalls.value += 1;
      const payload = JSON.parse(body ?? '{}') as { shipment_id?: string; courier_id?: string };
      const order = payload.shipment_id ? byShipmentId(payload.shipment_id) : undefined;
      if (!order) {
        return json({ awb_assign_status: 0, response: { data: { message: 'Shipment not found' } } });
      }
      return json({
        awb_assign_status: 1,
        response: {
          data: {
            awb_code: order.awb,
            courier_company_id: payload.courier_id,
            shipment_id: order.shipmentId,
          },
        },
      });
    }

    // ---- orders search (lookupByReference, RW-12) -------------------------------
    if (path.endsWith('/orders')) {
      const search = url.searchParams.get('search') ?? '';
      const order = search ? state.orders.get(search) : undefined;
      if (!order) return json({ data: [], meta: { pagination: { total: 0 } } });
      return json({
        data: [
          {
            id: order.orderId,
            channel_order_id: order.ref,
            shipments: [
              {
                awb: order.awb,
                shipment_id: order.shipmentId,
                status: order.cancelled ? 'CANCELED' : 'NEW',
              },
            ],
          },
        ],
        meta: { pagination: { total: 1 } },
      });
    }

    // ---- tracking by AWB ---------------------------------------------------------
    const trackMatch = path.match(/\/courier\/track\/awb\/(.+)$/);
    if (trackMatch) {
      const order = byAwb(decodeURIComponent(trackMatch[1]));
      if (!order) {
        return json({ tracking_data: { track_status: 0, error: 'AWB not found' } });
      }
      return json({
        tracking_data: {
          track_status: 1,
          shipment_status: order.cancelled ? 8 : 6,
          shipment_id: order.shipmentId,
          shipment_track: [
            {
              id: order.orderId,
              awb_code: order.awb,
              courier_company_id: '39',
              shipment_id: order.shipmentId,
              current_status: order.cancelled ? 'Canceled' : 'Shipped',
            },
          ],
          shipment_track_activities: [
            {
              date: '2026-02-01 10:00:00',
              status: 'PICKUP SCHEDULED',
              activity: 'Pickup Scheduled',
              location: 'Delhi',
              'sr-status': '2',
            },
            {
              date: '2026-02-01 18:00:00',
              status: 'PICKED UP',
              activity: 'Picked Up',
              location: 'Delhi',
              'sr-status': '3',
            },
            {
              date: '2026-02-02 09:00:00',
              status: order.cancelled ? 'CANCELED' : 'SHIPPED',
              activity: order.cancelled ? 'Canceled' : 'Shipped',
              location: 'Delhi Hub',
              'sr-status': order.cancelled ? '8' : '6',
            },
          ],
        },
      });
    }

    // ---- cancel by AWBs -------------------------------------------------------------
    if (path.endsWith('/orders/cancel/shipment/awbs')) {
      const payload = JSON.parse(body ?? '{}') as { awbs?: string[] };
      const order = payload.awbs?.[0] ? byAwb(payload.awbs[0]) : undefined;
      if (!order) return json({ status: false, message: 'AWB not found' });
      if (order.cancelled) return json({ status: false, message: 'Already cancelled' });
      order.cancelled = true;
      return json({ status: true, message: 'Shipment cancelled' });
    }

    // ---- pickup generation --------------------------------------------------------------
    if (path.endsWith('/courier/generate/pickup')) {
      const payload = JSON.parse(body ?? '{}') as { shipment_id?: string[] };
      const known = (payload.shipment_id ?? []).every((id) => byShipmentId(id));
      if (!known || (payload.shipment_id ?? []).length === 0) {
        return json({ pickup_status: 0, message: 'Shipment not found' });
      }
      return json({ pickup_status: 1, response: { pickup_id: 'SRPK-000001' } });
    }

    // ---- label generation -----------------------------------------------------------------
    if (path.endsWith('/courier/generate/label')) {
      const payload = JSON.parse(body ?? '{}') as { shipment_id?: string[] };
      const first = payload.shipment_id?.[0];
      if (!first || !byShipmentId(first)) {
        return json({ label_created: 0, message: 'Shipment not found' });
      }
      return json({
        label_created: 1,
        label_url: `https://labels.mock.shiprocket.test/labels/${first}.pdf`,
      });
    }

    return json({ error: `unmocked path ${path}` }, 404);
  }) as unknown as typeof fetch;

  state.fetchFn = fetchMock;
  return state;
}
