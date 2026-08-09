/**
 * Shadowfax API endpoint & payload map — the SINGLE file that isolates every
 * externally-sourced fact about the Shadowfax API (§8.2 transport).
 *
 * Shadowfax's partner API is not publicly documented to the level this
 * adapter needs, and the sandbox is an owner-side week-0 item (§14), so
 * EVERY endpoint URL, HTTP method, request mapping and response mapping
 * below carries a TODO(sandbox-verify) marker. A sandbox pass should need
 * to correct this file only.
 *
 * Money boundary (INV-15): provider amounts arrive as JSON numbers/strings
 * and are converted ONCE, here, into exact 2dp text via integer paise. No
 * float arithmetic crosses into the rest of the adapter, and no amount is
 * marked up (INV-23 — BYOC, merchant's own credentials).
 *
 * Quote (§8.3): Shadowfax rate APIs are contract-specific (per-client rate
 * cards behind account-specific endpoints) with no stable public shape, so
 * getQuote is DECLARED UNSUPPORTED at v1 (A1-03) — the Services are
 * cost_source = RATE_CARD (§3.7) and the §4.5 cost engine synthesizes the
 * quote. The serviceability endpoint below is mapped for a future enablement
 * pass; nothing calls it at v1.
 */

export const SHADOWFAX_COURIER_CODE = 'SHADOWFAX';

// ---------------------------------------------------------------------
// Base URLs & auth
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): Shadowfax is reached on https://dale.shadowfax.in
 *  (api.shadowfax.in is an older alias). No distinct public sandbox host is
 *  documented, so TEST and LIVE share the host until the sandbox pass
 *  confirms one. */
export const SHADOWFAX_BASE_URLS: Record<'TEST' | 'LIVE', string> = {
  TEST: 'https://dale.shadowfax.in',
  LIVE: 'https://dale.shadowfax.in',
};

/** KEY_PASTE (§9.3.3): one secret credential field. The Authorization header
 *  is `Token <api_key>` — TODO(sandbox-verify). */
export const SHADOWFAX_CREDENTIAL_KEYS = ['api_key'] as const;
export const SHADOWFAX_AUTH_SCHEME = 'Token'; // Authorization: Token <api_key>

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

/** TODO(sandbox-verify): every path, method and timeout below. The
 *  /api/v3/clients/* family is an older alias of the /api/v1|v4 shapes. */
export const SHADOWFAX_ENDPOINTS = {
  /** Pincode serviceability. Mapped but UNUSED at v1 — getQuote is declared
   *  unsupported (A1-03, RATE_CARD pricing); kept here so a future
   *  enablement pass touches only this file. */
  serviceability: {
    method: 'POST',
    path: '/api/v1/serviceability',
    timeoutMs: 10_000,
    contentType: 'application/json',
  },
  /** Order create — keyed by client_order_id (the §9.5.4 merchant reference). */
  createShipment: {
    method: 'POST',
    path: '/api/v4/orders',
    timeoutMs: 20_000,
    contentType: 'application/json',
  },
  /** Tracking; also the reference-lookup surface (INV-5, RW-12) via the
   *  client_order_id query parameter. */
  tracking: {
    method: 'GET',
    path: '/api/v1/track',
    timeoutMs: 10_000,
  },
  /** Pre-pickup cancellation. */
  cancel: {
    method: 'POST',
    path: '/api/v1/orders/cancel',
    timeoutMs: 15_000,
    contentType: 'application/json',
  },
  /** Pickup request. */
  pickup: {
    method: 'POST',
    path: '/api/v1/pickup',
    timeoutMs: 15_000,
    contentType: 'application/json',
  },
  /** Courier PDF label. */
  label: {
    method: 'GET',
    path: '/api/v1/label',
    timeoutMs: 20_000,
  },
  /** NDR action (reattempt / address update / RTO). */
  ndrAction: {
    method: 'POST',
    path: '/api/v1/ndr/action',
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

/** 3dp kg text → integer grams text (TODO(sandbox-verify): Shadowfax
 *  weight unit — grams assumed, matching the other launch adapters). */
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
    for (const key of ['error', 'Error', 'message', 'detail', 'error_message']) {
      const v = asString(body[key]);
      if (v) return providerMessageToCode(v, `HTTP_${httpStatus}`);
    }
    if (body.success === false) return 'REQUEST_REJECTED';
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
// §8.2 createShipment
// ---------------------------------------------------------------------

export interface CreatePayloadInput {
  merchantReference: string;
  pickupLocationId: string;
  recipient: {
    name: string;
    addressLines: string[];
    city: string;
    state: string;
    pincode: string;
    phone: string;
  };
  paymentMode: 'PREPAID' | 'COD' | 'UNRESOLVED';
  collectible: string; // 2dp text
  deadWeightKg: string; // 3dp text
  lengthCm: string; // 2dp text
  widthCm: string;
  heightCm: string;
  declaredValue: string; // 2dp text
}

/**
 * TODO(sandbox-verify): the /api/v4/orders create body. Best-known shape:
 * `client_order_id` is the client-supplied reference — this is the
 * merchant_reference of §9.5.4 and keys Shadowfax-side idempotency;
 * `address_details` carries the recipient block; weight/dimensions ride in
 * `parcel_details` in grams/cm.
 *
 * TODO(sandbox-verify) / integration gap: `pickup_location_code` must be
 * the merchant's pickup/store code AS REGISTERED in the Shadowfax panel;
 * the adapter receives our internal pickup_location_id and passes it
 * through — resolving the registered code is an upstream/framework concern.
 *
 * Only fields the §8.2 request actually carries are transmitted — no
 * invented fields (RV-13 protected recipient fields go at booking only).
 */
export function buildCreateShipmentBody(input: CreatePayloadInput): string {
  return JSON.stringify({
    client_order_id: input.merchantReference, // §9.5.4 stable merchant reference
    pickup_location_code: input.pickupLocationId,
    address_details: {
      name: input.recipient.name,
      address_line_1: input.recipient.addressLines[0] ?? '',
      address_line_2: input.recipient.addressLines.slice(1).join(', '),
      city: input.recipient.city,
      state: input.recipient.state,
      pincode: input.recipient.pincode,
      phone: input.recipient.phone,
    },
    parcel_details: {
      weight: kgTextToGramsText(input.deadWeightKg), // TODO(sandbox-verify): unit
      length: input.lengthCm,
      width: input.widthCm,
      height: input.heightCm,
      declared_value: input.declaredValue,
    },
    payment_mode: input.paymentMode === 'COD' ? 'COD' : 'Prepaid',
    cod_amount: input.paymentMode === 'COD' ? input.collectible : '0',
    quantity: '1', // INV-4: fixed 1 at v1
  });
}

export interface ParsedCreateResult {
  success: boolean;
  awb: string | null;
  /** §3.25: becomes PROVIDER_CONFIRMED_CHARGE when present (2dp text). */
  confirmedCharge: string | null;
  failureReasons: string[];
}

/** TODO(sandbox-verify): create response — best-known
 *  `{message, data: {awb_number, client_order_id, ...}}`, parsed
 *  defensively across the documented aliases. A confirmed charge is
 *  surfaced only when the provider returns one. */
export function parseCreateResponse(body: unknown): ParsedCreateResult {
  if (!isObj(body)) {
    return { success: false, awb: null, confirmedCharge: null, failureReasons: ['INVALID_RESPONSE'] };
  }
  const topError =
    asString(body.error) ?? (body.success === false ? asString(body.message) : null);
  const data = isObj(body.data) ? body.data : body;
  const awb =
    asString(data.awb_number) ?? asString(data.awb) ?? asString(data.awbNumber);
  if (!awb) {
    const reason = topError ?? asString(data.error) ?? asString(data.message);
    return {
      success: false,
      awb: null,
      confirmedCharge: null,
      failureReasons: [reason ? providerMessageToCode(reason, 'SHIPMENT_REJECTED') : 'SHIPMENT_REJECTED'],
    };
  }
  const charge =
    providerAmountToMoney2dp(data.total_amount) ??
    providerAmountToMoney2dp(data.charged_amount) ??
    providerAmountToMoney2dp(data.shipping_charge);
  return { success: true, awb, confirmedCharge: charge, failureReasons: [] };
}

// ---------------------------------------------------------------------
// §8.2 lookupByReference (RW-12) + track — the tracking API
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): /api/v1/track filters by `awb` and by
 *  `client_order_id`; the latter is the INV-5 resolution surface. */
export function buildTrackingQueryByAwb(awb: string): Record<string, string> {
  return { awb };
}

export function buildTrackingQueryByReference(merchantReference: string): Record<string, string> {
  return { client_order_id: merchantReference };
}

export interface ParsedTrackingOrder {
  awb: string | null;
  scans: Array<{
    rawStatus: string;
    occurredAt: string | null; // ISO, null when unparseable
    locationText: string | null;
    reasonText: string | null;
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

/** TODO(sandbox-verify): best-known
 *  `{data: [{awb_number, current_status, scans: [{status, scan_date_time,
 *  location, remark}]}]}` — data accepted as an array or a single object. */
export function parseTrackingResponse(body: unknown): ParsedTrackingOrder | null {
  if (!isObj(body)) return null;
  const container = 'data' in body ? body.data : body;
  const first = Array.isArray(container) ? container.find(isObj) : isObj(container) ? container : null;
  if (!first) return null;
  const scanRows = ['scans', 'events', 'track_details', 'history']
    .map((key) => asArray(first[key]))
    .find((rows) => rows.length > 0) ?? [];
  const scans = scanRows
    .filter(isObj)
    .map((row) => ({
      rawStatus: asString(row.status) ?? asString(row.scan_status) ?? 'UNKNOWN',
      occurredAt: parseProviderDateTime(
        row.scan_date_time ?? row.timestamp ?? row.event_date_time ?? row.date,
      ),
      locationText: asString(row.location) ?? asString(row.scan_location),
      reasonText: asString(row.remark) ?? asString(row.reason) ?? asString(row.instructions),
    }));
  // No scans but a current status: synthesize one event from it so a
  // freshly-booked AWB still yields a polling event (§8.5 fallback).
  if (scans.length === 0) {
    const rawStatus = asString(first.current_status) ?? asString(first.status);
    if (rawStatus) {
      scans.push({
        rawStatus,
        occurredAt: parseProviderDateTime(first.status_date_time ?? first.updated_at),
        locationText: asString(first.location),
        reasonText: asString(first.remark) ?? asString(first.reason),
      });
    }
  }
  return { awb: asString(first.awb_number) ?? asString(first.awb), scans };
}

// ---------------------------------------------------------------------
// §8.2 cancelShipment / schedulePickup / getLabel / ndrAction
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): cancel body — best-known `{awb}` /
 *  `{awb_number}`; both fields are sent, aliases are cheap. */
export function buildCancelBody(awb: string): string {
  return JSON.stringify({ awb, awb_number: awb });
}

export interface ParsedSimpleAck {
  accepted: boolean;
  reason: string | null;
  id: string | null;
}

function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 'True' || v === 1 || v === '1';
}

/** TODO(sandbox-verify): Shadowfax ack shape — best-known
 *  `{success: true|false, message}`; an explicit false with a message is a
 *  REJECTED. Shared by cancel / pickup / ndr acks. */
export function parseSimpleAckResponse(body: unknown, rejectedFallback: string): ParsedSimpleAck {
  if (!isObj(body)) return { accepted: false, reason: 'INVALID_RESPONSE', id: null };
  if (truthy(body.success) || truthy(body.status)) {
    return {
      accepted: true,
      reason: null,
      id: asString(body.id) ?? asString(body.request_id) ?? asString(body.pickup_id),
    };
  }
  const reason = asString(body.message) ?? asString(body.error);
  return {
    accepted: false,
    reason: reason ? providerMessageToCode(reason, rejectedFallback) : rejectedFallback,
    id: null,
  };
}

export interface PickupBodyInput {
  awbs: string[];
  pickupLocationId: string;
  /** ISO date. */
  pickupDate: string;
}

/** TODO(sandbox-verify): /api/v1/pickup fields — best-known awbs +
 *  pickup_location_code + pickup_date. */
export function buildPickupBody(input: PickupBodyInput): string {
  return JSON.stringify({
    awbs: input.awbs,
    pickup_location_code: input.pickupLocationId,
    pickup_date: input.pickupDate,
  });
}

/** TODO(sandbox-verify): label query — best-known `awb` (PDF). */
export function buildLabelQuery(awb: string): Record<string, string> {
  return { awb };
}

/**
 * TODO(sandbox-verify): NDR action endpoint, verb field and action values.
 * Best-known mapping of the §8.2 NdrActionType vocabulary:
 * - REATTEMPT → reattempt (optional deferred date in payload.deferredDate)
 * - UPDATE_ADDRESS_AND_REATTEMPT → reattempt with payload.address
 * - INITIATE_RTO → rto
 */
export function buildNdrActionBody(input: {
  awb: string;
  action: 'REATTEMPT' | 'UPDATE_ADDRESS_AND_REATTEMPT' | 'INITIATE_RTO';
  payload: Record<string, unknown>;
}): string {
  const body: Record<string, unknown> = { awb: input.awb };
  if (input.action === 'INITIATE_RTO') {
    body.action = 'rto';
  } else {
    body.action = 'reattempt';
    if (input.action === 'UPDATE_ADDRESS_AND_REATTEMPT' && input.payload.address !== undefined) {
      body.address = input.payload.address;
    }
    if (input.payload.deferredDate !== undefined) {
      body.deferred_date = input.payload.deferredDate;
    }
  }
  return JSON.stringify(body);
}
