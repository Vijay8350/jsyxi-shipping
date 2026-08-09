/**
 * Shiprocket API endpoint & payload map — the SINGLE file that isolates
 * every externally-sourced fact about the Shiprocket API (§8.2 transport).
 * Shiprocket is the launch AGGREGATOR (§9.3.4, A2-02): its nested courier
 * options surface as Jsyxi Services with cost_source = LIVE_QUOTE.
 *
 * Exact Shiprocket endpoint behaviour is externally sourced and the sandbox
 * is an owner-side week-0 item (§14), so EVERY endpoint URL, HTTP method,
 * request mapping and response mapping below carries a TODO(sandbox-verify)
 * marker. A sandbox pass should need to correct this file only.
 *
 * Money boundary (INV-15): provider amounts arrive as JSON numbers/strings
 * and are converted ONCE, here, into exact 2dp text via integer paise. No
 * float arithmetic crosses into the rest of the adapter, and no amount is
 * marked up (INV-23 — aggregator quotes pass through unmarked).
 */

export const SHIPROCKET_COURIER_CODE = 'SHIPROCKET';

// ---------------------------------------------------------------------
// Base URLs & auth
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): Shiprocket exposes a single API host for both
 *  credential sets; the TEST/LIVE distinction is carried by the account's
 *  credentials (RW-20), not by a separate staging host. */
export const SHIPROCKET_BASE_URLS: Record<'TEST' | 'LIVE', string> = {
  TEST: 'https://apiv2.shiprocket.in/v1/external',
  LIVE: 'https://apiv2.shiprocket.in/v1/external',
};

/** KEY_PASTE (§9.3.3): two pasted secret credential fields — the login
 *  e-mail and password that mint the bearer token — plus one NON-secret
 *  JSON config field carrying the nested-courier mapping (see
 *  shiprocket.seed.ts; a config value, never a credential, INV-18). */
export const SHIPROCKET_CREDENTIAL_KEYS = ['email', 'password'] as const;
export const SHIPROCKET_COURIER_MAP_KEY = 'shiprocket_courier_map';

/** TODO(sandbox-verify): the login response carries `expires_in` (seconds;
 *  best-known 864000 = 10 days). When absent the token is cached for
 *  TOKEN_TTL_DEFAULT_SECONDS, always TOKEN_TTL_SKEW_SECONDS early-rotated. */
export const TOKEN_TTL_DEFAULT_SECONDS = 864_000; // 10 days
export const TOKEN_TTL_SKEW_SECONDS = 3_600;

// ---------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------

export interface EndpointSpec {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  /** Per-call AbortSignal timeout; a create timeout → OUTCOME_UNKNOWN (§9.5.4). */
  readonly timeoutMs: number;
  readonly contentType?: string;
}

/** TODO(sandbox-verify): every path, method and timeout below. */
export const SHIPROCKET_ENDPOINTS = {
  /** Credential login → bearer token (cached in Redis with TTL, §9.3.3). */
  login: {
    method: 'POST',
    path: '/auth/login',
    timeoutMs: 10_000,
    contentType: 'application/json',
  },
  /** §8.3 LIVE_QUOTE surface: per-nested-courier rates + EDD for a lane. */
  serviceability: {
    method: 'GET',
    path: '/courier/serviceability',
    timeoutMs: 10_000,
  },
  /** Aggregator booking step 1: create the order (order_id = the §9.5.4
   *  stable merchant reference — Shiprocket-side idempotency key). */
  createOrder: {
    method: 'POST',
    path: '/orders/create/adhoc',
    timeoutMs: 20_000,
    contentType: 'application/json',
  },
  /** Aggregator booking step 2: assign the AWB with the CHOSEN nested
   *  courier_id — the nested-identity selection step (§15.1). */
  assignAwb: {
    method: 'POST',
    path: '/courier/assign/awb',
    timeoutMs: 20_000,
    contentType: 'application/json',
  },
  /** Orders list — the lookupByReference surface (INV-5, RW-12), searched
   *  by the channel order id (= our merchant reference). */
  ordersSearch: {
    method: 'GET',
    path: '/orders',
    timeoutMs: 10_000,
  },
  /** Tracking by AWB (§8.5 polling fallback); the AWB is path-appended. */
  trackByAwb: {
    method: 'GET',
    path: '/courier/track/awb',
    timeoutMs: 10_000,
  },
  /** Pre-pickup cancellation by AWB list. */
  cancelByAwbs: {
    method: 'POST',
    path: '/orders/cancel/shipment/awbs',
    timeoutMs: 15_000,
    contentType: 'application/json',
  },
  /** Pickup generation, keyed by Shiprocket shipment ids. */
  generatePickup: {
    method: 'POST',
    path: '/courier/generate/pickup',
    timeoutMs: 15_000,
    contentType: 'application/json',
  },
  /** Label generation → a label_url the adapter then downloads. */
  generateLabel: {
    method: 'POST',
    path: '/courier/generate/label',
    timeoutMs: 20_000,
    contentType: 'application/json',
  },
  /** The generated-label download (absolute URL from generateLabel). */
  labelDownload: {
    method: 'GET',
    path: '/',
    timeoutMs: 20_000,
  },
} as const satisfies Record<string, EndpointSpec>;

// ---------------------------------------------------------------------
// Small exact-money helpers (INV-15: never floats past here)
// ---------------------------------------------------------------------

/** Integer paise → exact 2dp text. */
export function paiseToMoney2dp(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Provider amount → exact 2dp text, or null when absent/unparseable.
 * A provider JSON number is admitted ONLY here (INV-15 boundary): rounded
 * half-up to integer paise and re-rendered as text. Strings are parsed
 * exactly (also half-up at the 3rd decimal).
 */
export function providerAmountToMoney2dp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return paiseToMoney2dp(Math.round(value * 100));
  }
  if (typeof value === 'string') {
    const m = value.trim().match(/^(-?)(\d+)(?:\.(\d+))?$/);
    if (!m) return null;
    const [, neg, whole, frac = ''] = m;
    let paise = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
    if (frac.length > 2 && Number(frac[2]) >= 5) paise += 1; // half-up
    return paiseToMoney2dp(neg === '-' ? -paise : paise);
  }
  return null;
}

/** Exact 2dp text → integer paise (for component sums, INV-15). */
export function money2dpToPaise(text: string): number {
  const neg = text.startsWith('-');
  const [whole, frac = ''] = (neg ? text.slice(1) : text).split('.');
  const v = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2) || '0');
  return neg ? -v : v;
}

/**
 * §8.3 rto_rule: Shiprocket exposes a per-courier RTO charge. Mapped
 * conservatively: equal to the forward freight → SAME_AS_FORWARD; otherwise
 * PERCENT_OF_FORWARD with the exact ratio (integer basis-point math, no
 * floats). Null when the API does not expose an RTO charge — F-12 owns the
 * merchant-side expectation then (§4.4).
 */
export function rtoRuleFromCharges(
  rtoCharges: string | null,
  freight: string | null,
): { basis: 'SAME_AS_FORWARD' | 'PERCENT_OF_FORWARD'; pct: string | null } | null {
  if (!rtoCharges || !freight) return null;
  const rto = money2dpToPaise(rtoCharges);
  const fwd = money2dpToPaise(freight);
  if (fwd <= 0) return null;
  if (rto === fwd) return { basis: 'SAME_AS_FORWARD', pct: null };
  const bp = Math.round((rto * 10_000) / fwd); // basis points, exact
  return {
    basis: 'PERCENT_OF_FORWARD',
    pct: `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}`,
  };
}

// ---------------------------------------------------------------------
// Response-shape narrowing helpers
// ---------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 'True' || v === 1 || v === '1';
}

/** Normalize a provider error/message into a structured code (§8.3 requires
 *  structured codes, not free text). Carries no PII and no secrets (INV-18). */
export function providerMessageToCode(message: string, fallback: string): string {
  const code = message
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return code.length > 0 ? code : fallback;
}

/** Best-effort structured code from an error response body. */
export function parseProviderErrorCode(body: unknown, httpStatus: number): string {
  if (isObj(body)) {
    for (const key of ['error', 'Error', 'message', 'errors', 'detail']) {
      const v = asString(body[key]);
      if (v) return providerMessageToCode(v, `HTTP_${httpStatus}`);
      // Shiprocket validation errors sometimes nest under errors.{field}[]
      if (isObj(body[key])) {
        const first = Object.values(body[key] as Record<string, unknown>)
          .flatMap((x) => asArray(x))
          .map(asString)
          .find((s) => s !== null);
        if (first) return providerMessageToCode(first, `HTTP_${httpStatus}`);
      }
    }
    if (body.status === false || body.success === false) return 'REQUEST_REJECTED';
  }
  if (typeof body === 'string' && body.length > 0 && body.length < 200) {
    return providerMessageToCode(body, `HTTP_${httpStatus}`);
  }
  return `HTTP_${httpStatus}`;
}

/** Retry-After header (seconds) → ms, for AdapterRateLimitError. */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

/** TODO(sandbox-verify): provider datetimes — format varies across endpoints
 *  ('2026-02-01 10:00:00', ISO, 'Feb 5, 2026'); best-effort parse to ISO. */
export function parseProviderDateTime(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const direct = Date.parse(s);
  if (!Number.isNaN(direct)) return new Date(direct).toISOString();
  const spaced = Date.parse(s.replace(' ', 'T'));
  if (!Number.isNaN(spaced)) return new Date(spaced).toISOString();
  return null;
}

// ---------------------------------------------------------------------
// Auth — POST /auth/login (§9.3.3 token pattern)
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): login request is JSON {email, password}. */
export function buildLoginBody(email: string, password: string): string {
  return JSON.stringify({ email, password });
}

export interface ParsedLogin {
  token: string | null;
  /** Seconds until expiry, when the response carries a hint. */
  expiresInSeconds: number | null;
}

/** TODO(sandbox-verify): best-known response
 *  `{token, expires_in, ...}`; the token is also sought under
 *  data.token / access_token, defensively. */
export function parseLoginResponse(body: unknown): ParsedLogin {
  if (!isObj(body)) return { token: null, expiresInSeconds: null };
  const data = isObj(body.data) ? body.data : {};
  const token =
    asString(body.token) ??
    asString(body.access_token) ??
    asString(data.token) ??
    asString(data.access_token);
  const expiryRaw =
    body.expires_in ?? body.expiresIn ?? data.expires_in ?? data.expiresIn;
  const expiry = Number(asString(expiryRaw));
  return {
    token,
    expiresInSeconds: Number.isFinite(expiry) && expiry > 0 ? Math.floor(expiry) : null,
  };
}

// ---------------------------------------------------------------------
// §8.2 getQuote — GET /courier/serviceability (LIVE_QUOTE, A2-02)
// ---------------------------------------------------------------------

export interface ServiceabilityQueryInput {
  originPincode: string;
  destinationPincode: string;
  /** 3dp kg text (F-24), sent as exact text — never a float (INV-15). */
  deadWeightKg: string;
  paymentMode: 'PREPAID' | 'COD' | 'UNRESOLVED';
  collectible: string; // 2dp text
}

/**
 * TODO(sandbox-verify): query params pickup_postcode / delivery_postcode /
 * weight (kg) / cod (1|0). The weight is the §8.3 dead weight as exact text;
 * if the API proves to require a JSON-number-style weight, the conversion
 * belongs here at the boundary (still no floats — trim, never arithmetic).
 */
export function buildServiceabilityQuery(
  input: ServiceabilityQueryInput,
): Record<string, string> {
  return {
    pickup_postcode: input.originPincode,
    delivery_postcode: input.destinationPincode,
    weight: input.deadWeightKg,
    cod: input.paymentMode === 'COD' ? '1' : '0',
  };
}

export interface ParsedShiprocketCourier {
  /** Shiprocket's nested courier id — the Jsyxi Service's external identity. */
  courierId: string;
  courierName: string | null;
  /** All amounts 2dp text or null (INV-15). */
  rate: string | null;
  freight: string | null;
  codCharges: string | null;
  otherCharges: string | null;
  rtoCharges: string | null;
  /** Raw etd text; parsed by the caller. */
  etd: string | null;
  codSupported: boolean;
}

export interface ParsedServiceability {
  serviceable: boolean;
  failureReasons: string[];
  couriers: ParsedShiprocketCourier[];
}

/**
 * TODO(sandbox-verify): best-known response
 * `{status:200, data:{available_courier_companies:[{courier_company_id,
 * courier_name, rate, freight_charge, cod_charges, other_charges,
 * rto_charges, etd, cod, ...}]}}`. An empty list (or an explicit failure
 * status) maps to serviceable=false with structured reasons.
 */
export function parseServiceabilityResponse(body: unknown): ParsedServiceability {
  if (!isObj(body)) {
    return { serviceable: false, failureReasons: ['INVALID_RESPONSE'], couriers: [] };
  }
  const data = isObj(body.data) ? body.data : {};
  const rows = asArray(data.available_courier_companies).filter(isObj);
  const couriers: ParsedShiprocketCourier[] = rows
    .map((row) => {
      const courierId =
        asString(row.courier_company_id) ?? asString(row.courier_id) ?? asString(row.id);
      if (!courierId) return null;
      return {
        courierId,
        courierName: asString(row.courier_name) ?? asString(row.name),
        rate: providerAmountToMoney2dp(row.rate),
        freight: providerAmountToMoney2dp(row.freight_charge ?? row.freight_charges),
        codCharges: providerAmountToMoney2dp(row.cod_charges),
        otherCharges: providerAmountToMoney2dp(row.other_charges),
        rtoCharges: providerAmountToMoney2dp(row.rto_charges ?? row.rto_charge),
        etd: asString(row.etd) ?? asString(row.estimated_delivery_date),
        codSupported: truthy(row.cod),
      } satisfies ParsedShiprocketCourier;
    })
    .filter((c): c is ParsedShiprocketCourier => c !== null);

  if (couriers.length === 0) {
    const message = asString(body.message) ?? asString(data.message);
    return {
      serviceable: false,
      failureReasons: [
        message
          ? providerMessageToCode(message, 'PINCODE_NOT_SERVICEABLE')
          : 'PINCODE_NOT_SERVICEABLE',
      ],
      couriers: [],
    };
  }
  return { serviceable: true, failureReasons: [], couriers };
}

// ---------------------------------------------------------------------
// §8.2 createShipment — step 1: POST /orders/create/adhoc
// ---------------------------------------------------------------------

export interface CreateOrderInput {
  /** §9.5.4 stable merchant reference → Shiprocket order_id. */
  merchantReference: string;
  /** 'YYYY-MM-DD HH:mm' (Shiprocket's required order_date format). */
  orderDate: string;
  pickupLocationId: string;
  /** The merchant's courier-registered pickup/customer code, from their
   *  credentials. Falls back to pickupLocationId when unset. */
  registeredPickupCode?: string;
  recipient: {
    name: string;
    addressLines: string[];
    city: string;
    state: string;
    pincode: string;
    phone: string;
    email: string | null;
  };
  paymentMode: 'PREPAID' | 'COD' | 'UNRESOLVED';
  collectible: string; // 2dp text
  declaredValue: string; // 2dp text
  deadWeightKg: string; // 3dp text
  lengthCm: string; // 2dp text
  widthCm: string;
  heightCm: string;
}

/**
 * TODO(sandbox-verify): the adhoc order body — best-known shape with
 * billing_* fields (shipping_is_billing = true), one synthetic order line
 * priced at the declared value, weight/dimensions as exact text (INV-15).
 *
 * TODO(sandbox-verify) / integration gap: `pickup_location` must be the
 * merchant's pickup-location nickname AS REGISTERED in the Shiprocket
 * panel; the adapter receives our internal pickup_location_id and passes it
 * through — resolving the registered nickname is an upstream/framework
 * concern (same gap as the direct adapters' warehouse fields).
 *
 * Only fields the §8.2 request actually carries are transmitted (RV-13
 * protected recipient fields go at booking only). UNRESOLVED payment mode is
 * transmitted as Prepaid (the booking flow resolves the mode before create).
 */
export function buildCreateOrderBody(input: CreateOrderInput): string {
  const [firstName, ...rest] = input.recipient.name.trim().split(/\s+/);
  return JSON.stringify({
    order_id: input.merchantReference, // §9.5.4 stable merchant reference
    order_date: input.orderDate,
    pickup_location: (input.registeredPickupCode || input.pickupLocationId),
    billing_customer_name: firstName || input.recipient.name,
    billing_last_name: rest.join(' '),
    billing_address: input.recipient.addressLines[0] ?? '',
    billing_address_2: input.recipient.addressLines.slice(1).join(', '),
    billing_city: input.recipient.city,
    billing_state: input.recipient.state,
    billing_pincode: input.recipient.pincode,
    billing_country: 'India',
    billing_email: input.recipient.email ?? '',
    billing_phone: input.recipient.phone,
    shipping_is_billing: true,
    order_items: [
      {
        name: 'Shipment',
        sku: input.merchantReference,
        units: 1, // INV-4: fixed 1 at v1
        selling_price: input.declaredValue,
      },
    ],
    payment_method: input.paymentMode === 'COD' ? 'COD' : 'Prepaid',
    sub_total: input.paymentMode === 'COD' ? input.collectible : input.declaredValue,
    weight: input.deadWeightKg,
    length: input.lengthCm,
    breadth: input.widthCm,
    height: input.heightCm,
  });
}

export interface ParsedCreateOrder {
  success: boolean;
  /** Shiprocket's internal order id (needed by cancellation/lookup). */
  orderId: string | null;
  /** Shiprocket's shipment id (needed by AWB assign / pickup / label). */
  shipmentId: string | null;
  failureReasons: string[];
}

/** TODO(sandbox-verify): best-known success `{order_id, shipment_id,
 *  status, status_code}`; rejection `{message, status_code}` or a 422
 *  validation body. */
export function parseCreateOrderResponse(body: unknown): ParsedCreateOrder {
  if (!isObj(body)) {
    return { success: false, orderId: null, shipmentId: null, failureReasons: ['INVALID_RESPONSE'] };
  }
  const orderId = asString(body.order_id) ?? asString(body.orderId);
  const shipmentId = asString(body.shipment_id) ?? asString(body.shipmentId);
  if (orderId && shipmentId) {
    return { success: true, orderId, shipmentId, failureReasons: [] };
  }
  const message = asString(body.message) ?? asString(body.error);
  return {
    success: false,
    orderId: null,
    shipmentId: null,
    failureReasons: [message ? providerMessageToCode(message, 'ORDER_REJECTED') : 'ORDER_REJECTED'],
  };
}

// ---------------------------------------------------------------------
// §8.2 createShipment — step 2: POST /courier/assign/awb
// ---------------------------------------------------------------------

/**
 * TODO(sandbox-verify): `{shipment_id, courier_id}` — courier_id is the
 * CHOSEN nested courier (the Jsyxi Service's Shiprocket identity, §15.1
 * nested service identities).
 */
export function buildAssignAwbBody(shipmentId: string, courierId: string): string {
  return JSON.stringify({ shipment_id: shipmentId, courier_id: courierId });
}

export interface ParsedAssignAwb {
  success: boolean;
  awb: string | null;
  /** §3.25: becomes PROVIDER_CONFIRMED_CHARGE when the provider returns one
   *  (2dp text; best-known assign responses do NOT carry a charge). */
  confirmedCharge: string | null;
  failureReasons: string[];
}

/** TODO(sandbox-verify): best-known success
 *  `{awb_assign_status:1, response:{data:{awb_code, courier_company_id,
 *  ...}}}`; failure `{awb_assign_status:0, response:{data:{message}}}`.
 *  A confirmed charge is surfaced only when the provider returns one. */
export function parseAssignAwbResponse(body: unknown): ParsedAssignAwb {
  if (!isObj(body)) {
    return { success: false, awb: null, confirmedCharge: null, failureReasons: ['INVALID_RESPONSE'] };
  }
  const response = isObj(body.response) ? body.response : {};
  const data = isObj(response.data) ? response.data : isObj(body.data) ? body.data : {};
  const awb = asString(data.awb_code) ?? asString(data.awb) ?? asString(body.awb_code);
  if ((truthy(body.awb_assign_status) || awb) && awb) {
    const charge =
      providerAmountToMoney2dp(data.freight_charges) ??
      providerAmountToMoney2dp(data.charges) ??
      providerAmountToMoney2dp(data.rate);
    return { success: true, awb, confirmedCharge: charge, failureReasons: [] };
  }
  const message = asString(data.message) ?? asString(body.message);
  return {
    success: false,
    awb: null,
    confirmedCharge: null,
    failureReasons: [message ? providerMessageToCode(message, 'AWB_ASSIGN_FAILED') : 'AWB_ASSIGN_FAILED'],
  };
}

// ---------------------------------------------------------------------
// §8.2 lookupByReference (RW-12) — GET /orders searched by the merchant ref
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): the orders list filter param for the channel order
 *  id — best-known `search`; candidates to verify at sandbox: `order_id`,
 *  `filter_order_id`. */
export function buildOrdersSearchQuery(merchantReference: string): Record<string, string> {
  return { search: merchantReference };
}

export interface ParsedOrderLookup {
  found: boolean;
  awb: string | null;
  orderId: string | null;
  shipmentId: string | null;
}

/**
 * TODO(sandbox-verify): best-known response `{data:[{id, channel_order_id,
 * shipments:[{awb, shipment_id?, status, ...}]}], meta:{...}}`. Only an
 * order whose channel order id EXACTLY matches the merchant reference
 * resolves the lookup, and only when an AWB exists — an order without an
 * AWB is an incomplete booking (assign/awb never finished), which the
 * OUTCOME_UNKNOWN path (§3.2) must NOT treat as confirmed.
 */
export function parseOrdersSearchResponse(
  body: unknown,
  merchantReference: string,
): ParsedOrderLookup {
  const none: ParsedOrderLookup = { found: false, awb: null, orderId: null, shipmentId: null };
  if (!isObj(body)) return none;
  const rows = asArray(body.data).filter(isObj);
  for (const row of rows) {
    const channelRef = asString(row.channel_order_id) ?? asString(row.order_id);
    if (channelRef !== merchantReference) continue;
    const shipments = asArray(row.shipments).filter(isObj);
    for (const s of shipments) {
      const awb = asString(s.awb) ?? asString(s.awb_code);
      if (awb) {
        return {
          found: true,
          awb,
          orderId: asString(row.id),
          shipmentId: asString(s.shipment_id) ?? asString(s.id),
        };
      }
    }
    // Order found but no AWB: incomplete booking, not a confirmation (§3.2).
    return none;
  }
  return none;
}

// ---------------------------------------------------------------------
// §8.2 track — GET /courier/track/awb/{awb}
// ---------------------------------------------------------------------

export function buildTrackByAwbPath(awb: string): string {
  return `/courier/track/awb/${encodeURIComponent(awb)}`;
}

export interface ParsedShiprocketTrack {
  /** Shiprocket's shipment id when the payload exposes it (feeds the
   *  awb → shipment_id resolution for pickup/label). */
  shipmentId: string | null;
  events: Array<{
    rawStatus: string;
    occurredAt: string | null; // ISO, null when unparseable
    locationText: string | null;
    reasonText: string | null;
    providerEventId: string | null;
  }>;
}

/**
 * TODO(sandbox-verify): best-known response `{tracking_data:{track_status,
 * shipment_status, shipment_track:[{awb_code, current_status,
 * shipment_id?...}], shipment_track_activities:[{date, status, activity,
 * location, sr-status, sr-status-label}]}}`. Unknown AWB → track_status 0 /
 * no tracking_data → null (the adapter maps that to AWB_NOT_FOUND).
 *
 * Raw statuses pass through unmodified — normalization happens against
 * courier_status_map (§3.6), never in the adapter (A2-06).
 */
export function parseTrackResponse(body: unknown): ParsedShiprocketTrack | null {
  if (!isObj(body)) return null;
  const data = isObj(body.tracking_data) ? body.tracking_data : null;
  if (!data) return null;
  if (data.track_status !== undefined && !truthy(data.track_status)) return null;

  const trackRows = asArray(data.shipment_track).filter(isObj);
  const shipmentId =
    asString(data.shipment_id) ??
    asString(trackRows[0]?.shipment_id) ??
    asString(trackRows[0]?.id);

  const events = asArray(data.shipment_track_activities)
    .filter(isObj)
    .map((row) => ({
      rawStatus:
        asString(row.activity) ?? asString(row.status) ?? asString(row['sr-status-label']) ?? 'UNKNOWN',
      occurredAt: parseProviderDateTime(row.date) ?? parseProviderDateTime(row.date_time),
      locationText: asString(row.location),
      reasonText: asString(row.reason) ?? asString(row.remark),
      providerEventId: asString(row.id) ?? asString(row.event_id),
    }));

  if (events.length === 0) {
    // No activity list: synthesize one event from the current status so a
    // freshly booked AWB still yields a polling event (§8.5 fallback).
    const current = asString(trackRows[0]?.current_status);
    if (current) {
      events.push({
        rawStatus: current,
        occurredAt: parseProviderDateTime(trackRows[0]?.updated_date),
        locationText: asString(trackRows[0]?.current_location),
        reasonText: null,
        providerEventId: null,
      });
    }
  }
  return { shipmentId, events };
}

// ---------------------------------------------------------------------
// §8.2 cancelShipment — POST /orders/cancel/shipment/awbs
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): cancellation by AWB list. The alternative surface
 *  is POST /orders/cancel {ids:[internal order ids]} — verify at sandbox
 *  which one ships in this API version. */
export function buildCancelByAwbsBody(awbs: string[]): string {
  return JSON.stringify({ awbs });
}

export interface ParsedSimpleAck {
  accepted: boolean;
  reason: string | null;
  id: string | null;
}

/** TODO(sandbox-verify): cancel ack shape — best-known `{status:...,
 *  message}`; an explicit false / error message is a REJECTED. */
export function parseCancelResponse(body: unknown): ParsedSimpleAck {
  if (!isObj(body)) return { accepted: false, reason: 'INVALID_RESPONSE', id: null };
  if (truthy(body.status) || truthy(body.success)) return { accepted: true, reason: null, id: null };
  const reason = asString(body.message) ?? asString(body.error);
  return {
    accepted: false,
    reason: reason ? providerMessageToCode(reason, 'CANCEL_REJECTED') : 'CANCEL_REJECTED',
    id: null,
  };
}

// ---------------------------------------------------------------------
// §8.2 schedulePickup — POST /courier/generate/pickup
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): pickup generation is keyed by Shiprocket shipment
 *  ids (the adapter resolves awb → shipment_id from its booking registry /
 *  the track payload). */
export function buildPickupBody(shipmentIds: string[]): string {
  return JSON.stringify({ shipment_id: shipmentIds });
}

/** TODO(sandbox-verify): pickup ack shape — best-known `{pickup_status:1,
 *  response:{pickup_id?...}}` or a message-only rejection. */
export function parsePickupResponse(body: unknown): ParsedSimpleAck {
  if (!isObj(body)) return { accepted: false, reason: 'INVALID_RESPONSE', id: null };
  const response = isObj(body.response) ? body.response : {};
  const id =
    asString(response.pickup_id) ?? asString(body.pickup_id) ?? asString(body.pickup_request_id);
  if (id || truthy(body.pickup_status) || truthy(body.status) || truthy(body.success)) {
    return { accepted: true, reason: null, id };
  }
  const reason = asString(body.message) ?? asString(body.error);
  return {
    accepted: false,
    reason: reason ? providerMessageToCode(reason, 'PICKUP_REJECTED') : 'PICKUP_REJECTED',
    id: null,
  };
}

// ---------------------------------------------------------------------
// §8.2 getLabel — POST /courier/generate/label → download label_url
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): label generation is keyed by Shiprocket shipment
 *  ids. */
export function buildGenerateLabelBody(shipmentIds: string[]): string {
  return JSON.stringify({ shipment_id: shipmentIds });
}

/** TODO(sandbox-verify): best-known response `{label_created:1,
 *  label_url, response?}` — the PDF is downloaded from label_url. */
export function parseGenerateLabelResponse(body: unknown): { labelUrl: string | null } {
  if (!isObj(body)) return { labelUrl: null };
  return { labelUrl: asString(body.label_url) ?? asString(body.labelUrl) };
}
