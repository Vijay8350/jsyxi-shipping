/**
 * Xpressbees API endpoint & payload map — the SINGLE file that isolates
 * every externally-sourced fact about the Xpressbees API (§8.2 transport).
 *
 * Exact Xpressbees endpoint behaviour is externally sourced and the sandbox
 * is an owner-side week-0 item (§14), so EVERY endpoint URL, HTTP method,
 * request mapping and response mapping below carries a TODO(sandbox-verify)
 * marker. A sandbox pass should need to correct this file only.
 *
 * Money boundary (INV-15): provider amounts arrive as JSON numbers/strings
 * and are converted ONCE, here, into exact 2dp text via integer paise. No
 * float arithmetic crosses into the rest of the adapter, and no amount is
 * marked up (INV-23 — BYOC, merchant's own credentials).
 *
 * getQuote is DECLARED UNSUPPORTED for Xpressbees (A1-03): the Services are
 * cost_source = RATE_CARD (§3.7), so pricing and lane serviceability are
 * synthesized from the merchant's rate card by the §4.5 cost engine, and no
 * Xpressbees rate endpoint is mapped here. The best-known serviceability
 * surface (GET /api/courier/serviceability) is therefore intentionally not
 * implemented at v1.
 */

export const XPRESSBEES_COURIER_CODE = 'XPRESSBEES';

// ---------------------------------------------------------------------
// Base URLs & auth
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): Xpressbees exposes a single shipment host; no
 *  separate staging host is externally documented, so TEST and LIVE share
 *  it until the sandbox pass proves otherwise. */
export const XPRESSBEES_BASE_URLS: Record<'TEST' | 'LIVE', string> = {
  TEST: 'https://shipment.xpressbees.com',
  LIVE: 'https://shipment.xpressbees.com',
};

/** KEY_PASTE (§9.3): two pasted secret credential fields — the login e-mail
 *  and password that mint the bearer token. */
export const XPRESSBEES_CREDENTIAL_KEYS = ['email', 'password'] as const;

/** TODO(sandbox-verify): the login response carries an expiry hint under
 *  one of these keys (seconds); when absent the token is cached for
 *  TOKEN_TTL_DEFAULT_SECONDS, always TOKEN_TTL_SKEW_SECONDS early-rotated. */
export const TOKEN_TTL_DEFAULT_SECONDS = 82_800; // 23 h
export const TOKEN_TTL_SKEW_SECONDS = 300;

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
export const XPRESSBEES_ENDPOINTS = {
  /** Credential login → bearer token (cached in Redis with TTL, §9.3.3). */
  login: {
    method: 'POST',
    path: '/api/users/login',
    timeoutMs: 10_000,
    contentType: 'application/json',
  },
  /** Shipment create — keyed by the client order reference (order_number). */
  createShipment: {
    method: 'POST',
    path: '/api/shipments2',
    timeoutMs: 20_000,
    contentType: 'application/json',
  },
  /** Tracking by AWB; also the reference-lookup surface (INV-5, RW-12). */
  track: {
    method: 'GET',
    path: '/api/shipments2/track/',
    timeoutMs: 10_000,
  },
  /** Pre-pickup cancellation. */
  cancel: {
    method: 'POST',
    path: '/api/shipments2/cancel',
    timeoutMs: 15_000,
    contentType: 'application/json',
  },
  /** Pickup request. */
  pickup: {
    method: 'POST',
    path: '/api/pickups',
    timeoutMs: 15_000,
    contentType: 'application/json',
  },
  /** Courier PDF label. */
  label: {
    method: 'GET',
    path: '/api/shipments2/labels',
    timeoutMs: 20_000,
  },
  /** NDR action (reattempt / address update + reattempt / RTO). */
  ndrAction: {
    method: 'POST',
    path: '/api/ndr/create',
    timeoutMs: 15_000,
    contentType: 'application/json',
  },
} as const satisfies Record<string, EndpointSpec>;

// ---------------------------------------------------------------------
// Small exact-money / weight helpers (INV-15: never floats past here)
// ---------------------------------------------------------------------

/** Exact decimal text → integer minor units (never floats). */
function parseUnits(text: string, scale: number): number {
  const neg = text.startsWith('-');
  const [whole, frac = ''] = (neg ? text.slice(1) : text).split('.');
  const padded = (frac + '0'.repeat(scale)).slice(0, scale);
  const v = Number(whole || '0') * 10 ** scale + Number(padded || '0');
  return neg ? -v : v;
}

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

/** 3dp kg text → integer grams text (Xpressbees rates/creates in grams). */
export function kgTextToGramsText(kgText: string): string {
  return String(parseUnits(kgText, 3)); // 3dp kg == exact integer grams
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
    for (const key of ['error', 'Error', 'message', 'rmk', 'detail']) {
      const v = asString(body[key]);
      if (v) return providerMessageToCode(v, `HTTP_${httpStatus}`);
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

// ---------------------------------------------------------------------
// Auth — POST /api/users/login (§9.3.3 token pattern)
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
 *  `{status:true, data:{token, expires_in?}}`; the token is also sought at
 *  the top level and under access_token, defensively. */
export function parseLoginResponse(body: unknown): ParsedLogin {
  if (!isObj(body)) return { token: null, expiresInSeconds: null };
  const data = isObj(body.data) ? body.data : {};
  const token =
    asString(data.token) ??
    asString(data.access_token) ??
    asString(body.token) ??
    asString(body.access_token);
  const expiryRaw =
    data.expires_in ?? data.expiresIn ?? body.expires_in ?? body.expiresIn;
  const expiry = Number(asString(expiryRaw));
  return {
    token,
    expiresInSeconds: Number.isFinite(expiry) && expiry > 0 ? Math.floor(expiry) : null,
  };
}

// ---------------------------------------------------------------------
// §8.2 createShipment — POST /api/shipments2
// ---------------------------------------------------------------------

export interface CreatePayloadInput {
  merchantReference: string;
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
 * TODO(sandbox-verify): the shipments2 create body — best-known shape with
 * a nested `consignee`, flat `package_*` fields (grams / cm as exact text,
 * never floats, INV-15) and `order_number` as the client reference — this
 * is the merchant_reference of §9.5.4 and keys Xpressbees-side idempotency.
 *
 * TODO(sandbox-verify) / integration gap: `pickup.warehouse_name` must be
 * the merchant's warehouse name AS REGISTERED in the Xpressbees panel; the
 * adapter receives our internal pickup_location_id and passes it through —
 * resolving the registered name is an upstream/framework concern.
 *
 * Only fields the §8.2 request actually carries are transmitted — no
 * invented fields (RV-13 protected recipient fields go at booking only).
 * UNRESOLVED payment mode is transmitted as prepaid (never a guess upstream
 * — the booking flow resolves the mode before create).
 */
export function buildCreateShipmentBody(input: CreatePayloadInput): string {
  return JSON.stringify({
    order_number: input.merchantReference, // §9.5.4 stable merchant reference
    payment_type: input.paymentMode === 'COD' ? 'cod' : 'prepaid',
    cod_amount: input.paymentMode === 'COD' ? input.collectible : '0.00',
    order_amount: input.declaredValue, // declared value ≈ order amount (TODO(sandbox-verify))
    package_weight: kgTextToGramsText(input.deadWeightKg),
    package_length: input.lengthCm,
    package_breadth: input.widthCm,
    package_height: input.heightCm,
    quantity: '1', // INV-4: fixed 1 at v1
    pickup: { warehouse_name: (input.registeredPickupCode || input.pickupLocationId) },
    consignee: {
      name: input.recipient.name,
      address: input.recipient.addressLines[0] ?? '',
      address_2: input.recipient.addressLines.slice(1).join(', '),
      city: input.recipient.city,
      state: input.recipient.state,
      pincode: input.recipient.pincode,
      phone: input.recipient.phone,
      email: input.recipient.email ?? '',
    },
  });
}

export interface ParsedCreateResult {
  success: boolean;
  awb: string | null;
  /** §3.25: becomes PROVIDER_CONFIRMED_CHARGE when present (2dp text). */
  confirmedCharge: string | null;
  failureReasons: string[];
}

/** TODO(sandbox-verify): response `{status:true, data:{awb_number,
 *  order_number, ...}}`; rejection `{status:false, message}` (often still
 *  HTTP 200). A confirmed charge is surfaced only when the provider returns
 *  one (total_charges / freight_charges / charges). */
export function parseCreateResponse(body: unknown): ParsedCreateResult {
  if (!isObj(body)) {
    return { success: false, awb: null, confirmedCharge: null, failureReasons: ['INVALID_RESPONSE'] };
  }
  const data = isObj(body.data) ? body.data : {};
  const awb =
    asString(data.awb_number) ??
    asString(data.awb) ??
    asString(body.awb_number) ??
    asString(body.awb);
  if (truthy(body.status) && awb) {
    const charge =
      providerAmountToMoney2dp(data.total_charges) ??
      providerAmountToMoney2dp(data.freight_charges) ??
      providerAmountToMoney2dp(data.charges);
    return { success: true, awb, confirmedCharge: charge, failureReasons: [] };
  }
  const message = asString(body.message) ?? asString(body.error);
  return {
    success: false,
    awb: null,
    confirmedCharge: null,
    failureReasons: [
      message
        ? providerMessageToCode(message, 'SHIPMENT_REJECTED')
        : truthy(body.status)
          ? 'AWB_MISSING_IN_RESPONSE'
          : 'SHIPMENT_REJECTED',
    ],
  };
}

// ---------------------------------------------------------------------
// §8.2 lookupByReference (RW-12) + track — the track endpoint
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): the track endpoint filters by `awb` and by
 *  `order_number` (client reference). order_number is the INV-5 resolution
 *  surface. */
export function buildTrackQueryByAwb(awb: string): Record<string, string> {
  return { awb };
}

export function buildTrackQueryByReference(merchantReference: string): Record<string, string> {
  return { order_number: merchantReference };
}

export interface ParsedTrackingPackage {
  awb: string | null;
  scans: Array<{
    rawStatus: string;
    occurredAt: string | null; // ISO, null when unparseable
    locationText: string | null;
    reasonText: string | null;
    providerEventId: string | null;
  }>;
}

/** TODO(sandbox-verify): provider datetimes — format varies; best-effort
 *  parse to ISO. */
export function parseProviderDateTime(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const direct = Date.parse(s);
  if (!Number.isNaN(direct)) return new Date(direct).toISOString();
  const spaced = Date.parse(s.replace(' ', 'T'));
  if (!Number.isNaN(spaced)) return new Date(spaced).toISOString();
  return null;
}

/** TODO(sandbox-verify): best-known response `{status:true, data:{awb_number,
 *  order_number, status, status_date, history:[{status, status_date,
 *  location, remarks}]}}` (data sometimes an array). Parsed defensively:
 *  the event list is sought under history / status_history / scans; with no
 *  list, one event is synthesized from the current status so a freshly
 *  booked AWB still yields a polling event (§8.5 fallback). */
export function parseTrackingResponse(body: unknown): ParsedTrackingPackage | null {
  if (!isObj(body)) return null;
  if (body.status === false) return null;
  const raw = body.data;
  const node = isObj(raw) ? raw : asArray(raw).find(isObj);
  if (!node) return null;

  const eventRows =
    asArray(node.history).length > 0
      ? asArray(node.history)
      : asArray(node.status_history).length > 0
        ? asArray(node.status_history)
        : asArray(node.scans);
  const scans = eventRows
    .filter(isObj)
    .map((row) => ({
      rawStatus: asString(row.status) ?? asString(row.message) ?? 'UNKNOWN',
      occurredAt:
        parseProviderDateTime(row.status_date) ??
        parseProviderDateTime(row.status_datetime) ??
        parseProviderDateTime(row.date) ??
        parseProviderDateTime(row.time),
      locationText: asString(row.location),
      reasonText: asString(row.remarks) ?? asString(row.reason),
      providerEventId: asString(row.id) ?? asString(row.event_id),
    }));

  if (scans.length === 0) {
    const rawStatus = asString(node.status);
    if (rawStatus) {
      scans.push({
        rawStatus,
        occurredAt:
          parseProviderDateTime(node.status_date) ?? parseProviderDateTime(node.status_datetime),
        locationText: asString(node.location),
        reasonText: asString(node.remarks) ?? asString(node.reason),
        providerEventId: null,
      });
    }
  }
  return {
    awb: asString(node.awb_number) ?? asString(node.awb),
    scans,
  };
}

// ---------------------------------------------------------------------
// §8.2 cancelShipment / schedulePickup / getLabel / ndrAction
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): cancellation posts the AWB as `awb_number`. */
export function buildCancelBody(awb: string): string {
  return JSON.stringify({ awb_number: awb });
}

export interface ParsedSimpleAck {
  accepted: boolean;
  reason: string | null;
  id: string | null;
}

/** TODO(sandbox-verify): cancel ack shape — best-known `{status:true}` /
 *  `{status:false, message}`; an explicit false is a REJECTED. */
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

export interface PickupBodyInput {
  awbs: string[];
  pickupLocationId: string;
  /** The merchant's courier-registered pickup/customer code, from their
   *  credentials. Falls back to pickupLocationId when unset. */
  registeredPickupCode?: string;
  /** ISO date. */
  pickupDate: string;
}

/** TODO(sandbox-verify): /api/pickups fields — pickup_date, pickup_time,
 *  awb_numbers, warehouse (registered warehouse name; same integration gap
 *  as create). */
export function buildPickupBody(input: PickupBodyInput): string {
  return JSON.stringify({
    pickup_date: input.pickupDate,
    pickup_time: '10:00:00', // TODO(sandbox-verify): required window field
    awb_numbers: input.awbs,
    warehouse_name: (input.registeredPickupCode || input.pickupLocationId),
  });
}

/** TODO(sandbox-verify): pickup ack shape — a pickup id under
 *  data.pickup_id / pickup_id plus a status flag. */
export function parsePickupResponse(body: unknown): ParsedSimpleAck {
  if (!isObj(body)) return { accepted: false, reason: 'INVALID_RESPONSE', id: null };
  const data = isObj(body.data) ? body.data : {};
  const id = asString(data.pickup_id) ?? asString(body.pickup_id) ?? asString(body.pickup_request_id);
  if (id || truthy(body.status) || truthy(body.success)) {
    return { accepted: true, reason: null, id };
  }
  const reason = asString(body.message) ?? asString(body.error);
  return {
    accepted: false,
    reason: reason ? providerMessageToCode(reason, 'PICKUP_REJECTED') : 'PICKUP_REJECTED',
    id: null,
  };
}

/** TODO(sandbox-verify): label params (`awb`). */
export function buildLabelQuery(awb: string): Record<string, string> {
  return { awb };
}

/**
 * TODO(sandbox-verify): NDR action endpoint, verb field and action values.
 * Best-known mapping of the §8.2 NdrActionType vocabulary:
 * - REATTEMPT → reattempt (optional deferred date in payload.deferredDate)
 * - UPDATE_ADDRESS_AND_REATTEMPT → reattempt with payload.address / payload.phone
 * - INITIATE_RTO → rto
 */
export function buildNdrActionBody(input: {
  awb: string;
  action: 'REATTEMPT' | 'UPDATE_ADDRESS_AND_REATTEMPT' | 'INITIATE_RTO';
  payload: Record<string, unknown>;
}): string {
  const body: Record<string, unknown> = { awb_number: input.awb };
  if (input.action === 'INITIATE_RTO') {
    body.action = 'rto';
  } else {
    body.action = 'reattempt';
    if (input.action === 'UPDATE_ADDRESS_AND_REATTEMPT') {
      if (input.payload.address !== undefined) body.address = input.payload.address;
      if (input.payload.phone !== undefined) body.phone = input.payload.phone;
    }
    if (input.payload.deferredDate !== undefined) {
      body.deferred_date = input.payload.deferredDate;
    }
  }
  return JSON.stringify(body);
}

/** TODO(sandbox-verify): NDR ack shape. */
export function parseNdrActionResponse(body: unknown): ParsedSimpleAck {
  if (!isObj(body)) return { accepted: false, reason: 'INVALID_RESPONSE', id: null };
  const data = isObj(body.data) ? body.data : {};
  if (truthy(body.status) || truthy(body.success)) {
    return {
      accepted: true,
      reason: null,
      id: asString(data.ndr_id) ?? asString(body.request_id) ?? asString(body.id),
    };
  }
  const reason = asString(body.message) ?? asString(body.error);
  return {
    accepted: false,
    reason: reason ? providerMessageToCode(reason, 'NDR_REJECTED') : 'NDR_REJECTED',
    id: null,
  };
}
