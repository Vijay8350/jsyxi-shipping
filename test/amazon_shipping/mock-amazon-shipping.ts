import { vi } from 'vitest';
import type { AmazonShippingTokenCache } from '../../src/modules/amazon_shipping/amazon_shipping.adapter';
import { AMAZON_ACCESS_TOKEN_HEADER } from '../../src/modules/amazon_shipping/amazon_shipping-api.map';

/**
 * Scripted mock Amazon Shipping server, injected into AmazonShippingAdapter
 * as `fetchFn`. Implements the §15.1 contract-suite conventions against the
 * best-known Amazon Shipping API v2 shapes from amazon_shipping-api.map.ts:
 *
 * - a create whose clientReferenceId contains 'contract-timeout-' is
 *   RECORDED server-side (so lookupByReference resolves it) but the create
 *   call itself times out → OUTCOME_UNKNOWN (INV-5);
 * - the LWA token endpoint (POST /auth/o2/token) mints access tokens;
 *   authed endpoints require the access-token header; with
 *   `expireFirstToken` the first minted token answers 401 so the adapter's
 *   refresh-on-401 path is exercised (§9.3.3);
 * - `rateLimitPaths`: those endpoints answer 429 (Retry-After: 60) so the
 *   AdapterRateLimitError mapping is exercised;
 * - a wrong/missing access token gets 401; a bad/revoked refresh_token gets
 *   400 invalid_grant (refresh failure → CourierAuthError → DISCONNECTED).
 *
 * Every response shape mirrors amazon_shipping-api.map.ts; when the sandbox
 * pass corrects the map, correct this harness the same way.
 */

export const MOCK_REFRESH_TOKEN = 'mock-lwa-refresh-token';
export const MOCK_CLIENT_ID = 'amzn1.application-oa2-client.mock';
export const MOCK_CLIENT_SECRET = 'mock-lwa-client-secret';

/** In-memory TokenCache for tests (production uses the Redis cache). */
export class InMemoryTokenCache implements AmazonShippingTokenCache {
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
  shipmentId: string;
  clientReferenceId: string;
  cancelled: boolean;
}

export interface MockAmazonShippingOptions {
  /** Expected LWA credentials; any other refresh grant gets 400 invalid_grant. */
  expectedRefreshToken?: string;
  expectedClientId?: string;
  expectedClientSecret?: string;
  /** When true, every refresh grant answers 400 invalid_grant (refresh
   *  failure → CourierAuthError → DISCONNECTED, §9.3.3). */
  failAuth?: boolean;
  /** When true, the first minted access token is treated as expired (401),
   *  forcing the adapter's refresh-and-resend-once path. */
  expireFirstToken?: boolean;
  /** Endpoints (exact paths) that answer 429 with Retry-After: 60. */
  rateLimitPaths?: string[];
}

export interface MockAmazonShipping {
  fetchFn: typeof fetch;
  /** Recorded calls (path + parsed detail) for assertions. */
  calls: Array<{ path: string; url: string; body?: string }>;
  /** Server-side shipments by shipment id. */
  shipments: Map<string, MockShipment>;
  shipmentSeq: { value: number };
  tokenSeq: { value: number };
  refreshCalls: { value: number };
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

export function createMockAmazonShipping(options: MockAmazonShippingOptions = {}): MockAmazonShipping {
  const expectedRefreshToken = options.expectedRefreshToken ?? MOCK_REFRESH_TOKEN;
  const expectedClientId = options.expectedClientId ?? MOCK_CLIENT_ID;
  const expectedClientSecret = options.expectedClientSecret ?? MOCK_CLIENT_SECRET;
  const state: MockAmazonShipping = {
    fetchFn: undefined as unknown as typeof fetch,
    calls: [],
    shipments: new Map(),
    shipmentSeq: { value: 0 },
    tokenSeq: { value: 0 },
    refreshCalls: { value: 0 },
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

    // ---- LWA token endpoint (§9.3.3 OAUTH) -------------------------------
    if (path === '/auth/o2/token') {
      state.refreshCalls.value += 1;
      const params = new URLSearchParams(body ?? '');
      if (
        options.failAuth ||
        params.get('grant_type') !== 'refresh_token' ||
        params.get('refresh_token') !== expectedRefreshToken ||
        params.get('client_id') !== expectedClientId ||
        params.get('client_secret') !== expectedClientSecret
      ) {
        return json({ error: 'invalid_grant', error_description: 'invalid refresh token' }, 400);
      }
      state.tokenSeq.value += 1;
      const token = `LWA-TOKEN-${state.tokenSeq.value}`;
      liveTokens.add(token);
      if (options.expireFirstToken && state.tokenSeq.value === 1) {
        expiredTokens.add(token);
      }
      return json({ access_token: token, token_type: 'bearer', expires_in: 3600 });
    }

    // ---- access-token check ------------------------------------------------
    const headers = new Headers(init?.headers);
    const bearer = headers.get(AMAZON_ACCESS_TOKEN_HEADER) ?? '';
    if (!liveTokens.has(bearer) || expiredTokens.has(bearer)) {
      return json({ errors: [{ code: 'Unauthorized', message: 'invalid or expired access token' }] }, 401);
    }

    // ---- scripted rate limiting ------------------------------------------
    if (options.rateLimitPaths?.includes(path)) {
      return json({ errors: [{ code: 'TooManyRequests', message: 'rate limit exceeded' }] }, 429, {
        'Retry-After': '60',
      });
    }

    const httpMethod = (init?.method ?? 'GET').toUpperCase();

    // ---- create -------------------------------------------------------------
    if (path === '/shipping/v2/shipments' && httpMethod === 'POST') {
      state.createCalls.value += 1;
      const payload = JSON.parse(body ?? '{}') as { clientReferenceId: string };
      state.shipmentSeq.value += 1;
      const shipmentId = `AMZN${String(state.shipmentSeq.value).padStart(12, '0')}`;
      // §15.1 convention: record server-side, then time out (INV-5).
      state.shipments.set(shipmentId, {
        shipmentId,
        clientReferenceId: payload.clientReferenceId,
        cancelled: false,
      });
      if (payload.clientReferenceId.includes('contract-timeout-')) {
        return timeoutRejection();
      }
      return json({
        payload: {
          shipmentId,
          clientReferenceId: payload.clientReferenceId,
          status: 'READY',
        },
      });
    }

    // ---- reference lookup (INV-5, RW-12) --------------------------------------
    if (path === '/shipping/v2/shipments' && httpMethod === 'GET') {
      const byRef = url.searchParams.get('clientReferenceId');
      const shipment = [...state.shipments.values()].find((s) => s.clientReferenceId === byRef);
      if (!shipment) return json({ payload: { shipments: [] } });
      return json({
        payload: {
          shipments: [
            { shipmentId: shipment.shipmentId, clientReferenceId: shipment.clientReferenceId },
          ],
        },
      });
    }

    // ---- tracking -------------------------------------------------------------
    if (path === '/shipping/v2/tracking') {
      const trackingId = url.searchParams.get('trackingId');
      const shipment = trackingId ? state.shipments.get(trackingId) : undefined;
      if (!shipment) return json({ payload: {} });
      return json({
        payload: {
          trackingId: shipment.shipmentId,
          summary: { status: shipment.cancelled ? 'Cancelled' : 'InTransit' },
          eventHistory: [
            {
              eventCode: 'ReadyForReceive',
              eventTime: '2026-02-01T10:00:00Z',
              location: { city: 'Origin Hub', stateOrRegion: 'DL', countryCode: 'IN' },
            },
            {
              eventCode: 'PickupDone',
              eventTime: '2026-02-01T18:00:00Z',
              location: { city: 'Origin Hub', stateOrRegion: 'DL', countryCode: 'IN' },
            },
            {
              eventCode: shipment.cancelled ? 'Cancelled' : 'OutForDelivery',
              eventTime: '2026-02-02T09:00:00Z',
              location: { city: 'Delhi Hub', stateOrRegion: 'DL', countryCode: 'IN' },
            },
          ],
        },
      });
    }

    // ---- cancel -------------------------------------------------------------
    const cancelMatch = path.match(/^\/shipping\/v2\/shipments\/([^/]+)\/cancel$/);
    if (cancelMatch && httpMethod === 'PUT') {
      const shipment = state.shipments.get(decodeURIComponent(cancelMatch[1]));
      if (!shipment) {
        return json({ errors: [{ code: 'ResourceNotFound', message: 'shipment not found' }] }, 404);
      }
      if (shipment.cancelled) {
        return json({ errors: [{ code: 'InvalidInput', message: 'already cancelled' }] }, 400);
      }
      shipment.cancelled = true;
      return json({ payload: { shipmentId: shipment.shipmentId, status: 'CANCELLED' } });
    }

    // ---- label -----------------------------------------------------------------
    if (path === '/shipping/v2/labels') {
      const shipmentId = url.searchParams.get('shipmentId') ?? 'unknown';
      const pdf = `%PDF-1.4\n% Amazon Shipping mock label\n% shipment=${shipmentId}\n%%EOF\n`;
      return json({
        payload: {
          documents: [{ format: 'PDF', data: Buffer.from(pdf, 'utf8').toString('base64') }],
        },
      });
    }

    return json({ errors: [{ code: 'NotMocked', message: `unmocked path ${path}` }] }, 404);
  }) as unknown as typeof fetch;

  state.fetchFn = fetchMock;
  return state;
}
