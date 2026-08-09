/**
 * Amazon Shipping API endpoint & payload map — the SINGLE file that isolates
 * every externally-sourced fact about the Amazon Shipping API (§8.2
 * transport). The adapter file should not need to change on a sandbox pass;
 * this file should.
 *
 * Sandbox access is an owner-side week-0 item (§14), so EVERY endpoint URL,
 * HTTP method, request mapping and response mapping below carries a
 * TODO(sandbox-verify) marker.
 *
 * Auth (§9.3.3, OAUTH): Login with Amazon (LWA). The merchant connects via
 * LWA consent; the stored credentials are the `refresh_token` plus the LWA
 * app's `client_id`/`client_secret`. Access tokens are minted at the LWA
 * token endpoint (grant_type=refresh_token) and cached in Redis with a TTL.
 *
 * Money boundary (INV-15): provider amounts arrive as JSON numbers/strings
 * and are converted ONCE, here, into exact 2dp text via integer paise. No
 * float arithmetic crosses into the rest of the adapter, and no amount is
 * marked up (INV-23 — BYOC, merchant's own credentials).
 */

export const AMAZON_SHIPPING_COURIER_CODE = 'AMAZON_SHIPPING';

// ---------------------------------------------------------------------
// Base URLs & auth
// ---------------------------------------------------------------------

/**
 * TODO(sandbox-verify): Amazon Shipping API v2 is reached on a region base
 * URL that depends on the marketplace — best-known:
 * `https://sellingpartnerapi-eu.amazon.com` (EU program serving IN sellers)
 * or `https://api.amazon.in` for the India marketplace. The region base is a
 * configurable constant so a sandbox pass can correct it without touching
 * the adapter. The TEST value is the SP-API sandbox host, best-known.
 */
export const AMAZON_SHIPPING_BASE_URLS: Record<'TEST' | 'LIVE', string> = {
  TEST: 'https://sandbox.sellingpartnerapi-eu.amazon.com',
  LIVE: 'https://sellingpartnerapi-eu.amazon.com',
};

/**
 * LWA token endpoint (§9.3.3): POST grant_type=refresh_token → access token.
 * TODO(sandbox-verify): single global host, independent of the region base.
 */
export const AMAZON_LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

/** OAUTH (§9.3.3): the credential fields stored in the encrypted blob —
 *  the LWA refresh_token plus the LWA app's client_id/client_secret. */
export const AMAZON_SHIPPING_CREDENTIAL_KEYS = [
  'refresh_token',
  'client_id',
  'client_secret',
] as const;

/** TODO(sandbox-verify): LWA access tokens are best-known 3600 s; when the
 *  response carries expires_in it wins. Always rotated TOKEN_TTL_SKEW_SECONDS
 *  early. */
export const TOKEN_TTL_DEFAULT_SECONDS = 3_600;
export const TOKEN_TTL_SKEW_SECONDS = 300;

/**
 * Header carrying the LWA access token on Shipping API v2 calls.
 * TODO(sandbox-verify): best-known `x-amz-access-token` (LWA-style Shipping
 * API v2 auth, not AWS SigV4).
 */
export const AMAZON_ACCESS_TOKEN_HEADER = 'x-amz-access-token';

// ---------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------

export interface EndpointSpec {
  readonly method: 'GET' | 'POST' | 'PUT';
  /** `:shipmentId` is substituted by the caller (cancel). */
  readonly path: string;
  /** Per-call AbortSignal timeout; a create timeout → OUTCOME_UNKNOWN (§9.5.4). */
  readonly timeoutMs: number;
  readonly contentType?: string;
}

/** TODO(sandbox-verify): every path, method and timeout below. */
export const AMAZON_SHIPPING_ENDPOINTS = {
  /** Shipment create — keyed by clientReferenceId = our merchant_reference
   *  (§9.5.4), which keys Amazon-side idempotency. */
  createShipment: {
    method: 'POST',
    path: '/shipping/v2/shipments',
    timeoutMs: 20_000,
    contentType: 'application/json',
  },
  /** Reference lookup — resolves OUTCOME_UNKNOWN creates (INV-5, RW-12).
   *  TODO(sandbox-verify): best-known, the collection GET filters by
   *  clientReferenceId; if the API exposes no such filter this endpoint is
   *  the one place to correct. */
  lookup: {
    method: 'GET',
    path: '/shipping/v2/shipments',
    timeoutMs: 10_000,
  },
  /** Tracking by tracking id (our awb = the shipment/tracking id). */
  track: {
    method: 'GET',
    path: '/shipping/v2/tracking',
    timeoutMs: 10_000,
  },
  /** Pre-pickup cancellation. TODO(sandbox-verify): best-known
   *  PUT /shipping/v2/shipments/{shipmentId}/cancel; some program docs show
   *  POST /shipping/v2/cancellations — one endpoint to correct. */
  cancel: {
    method: 'PUT',
    path: '/shipping/v2/shipments/:shipmentId/cancel',
    timeoutMs: 15_000,
    contentType: 'application/json',
  },
  /** Courier PDF label (label_mode COURIER_PDF_REQUIRED, §9.9.1) — the
   *  response carries the PDF base64-encoded. */
  label: {
    method: 'GET',
    path: '/shipping/v2/labels',
    timeoutMs: 20_000,
  },
} as const satisfies Record<string, EndpointSpec>;

/** TODO(sandbox-verify): on cancel these HTTP statuses mean the provider
 *  REFUSED the cancellation (already collected / unknown shipment) rather
 *  than a provider failure — mapped to kind = REJECTED, never to the
 *  circuit-breaker error path. */
export const CANCEL_REJECT_HTTP_STATUSES: readonly number[] = [400, 404, 409];

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

/** 3dp kg text → integer grams text (exact — no floats, INV-15). */
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
    // TODO(sandbox-verify): Shipping API v2 error envelope — best-known
    // `{errors:[{code, message, details}]}` (SP-API style); flat
    // error/message shapes are admitted defensively.
    const errors = asArray(body.errors).filter(isObj);
    const first = errors[0];
    const v =
      (first ? asString(first.code) ?? asString(first.message) : null) ??
      asString(body.error) ??
      asString(body.message) ??
      asString(body.detail);
    if (v) return providerMessageToCode(v, `HTTP_${httpStatus}`);
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
// Auth — POST https://api.amazon.com/auth/o2/token (§9.3.3 OAUTH)
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): the LWA refresh grant body — form-urlencoded
 *  grant_type=refresh_token with the stored refresh_token and the LWA app's
 *  client_id/client_secret. */
export function buildLwaRefreshBody(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): string {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();
}

export interface ParsedLwaToken {
  accessToken: string | null;
  /** Seconds until expiry, when the response carries the hint. */
  expiresInSeconds: number | null;
}

/** TODO(sandbox-verify): LWA response `{access_token, token_type:"bearer",
 *  expires_in}`. An LWA failure is best-known HTTP 400 with
 *  `{error:"invalid_grant"}` (or 401) — the adapter classifies those as
 *  CourierAuthError (refresh failure → DISCONNECTED, §3.21, §9.3.3). */
export function parseLwaTokenResponse(body: unknown): ParsedLwaToken {
  if (!isObj(body)) return { accessToken: null, expiresInSeconds: null };
  const accessToken = asString(body.access_token);
  const expiry = Number(asString(body.expires_in));
  return {
    accessToken,
    expiresInSeconds: Number.isFinite(expiry) && expiry > 0 ? Math.floor(expiry) : null,
  };
}

// ---------------------------------------------------------------------
// §8.2 createShipment — POST /shipping/v2/shipments
// ---------------------------------------------------------------------

export interface CreatePayloadInput {
  /** §9.5.4 stable merchant reference → clientReferenceId. */
  merchantReference: string;
  pickupLocationId: string;
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
 * TODO(sandbox-verify): the Shipping API v2 create body — best-known shape
 * with `clientReferenceId`, a nested `shipTo` address, and a single
 * `packages` entry (INV-4: fixed 1 at v1). Weight and dimension VALUES are
 * transmitted as exact minor-unit/decimal TEXT (integer grams, 2dp cm), so
 * no float ever crosses the boundary (INV-15); whether the API accepts text
 * where its schema shows numbers — and whether the weight unit GRAM is
 * admitted vs KILOGRAM — is a sandbox item.
 *
 * TODO(sandbox-verify) / integration gap: Shipping API v2 creates require a
 * full ship-from address; the adapter receives our internal
 * pickup_location_id and passes it through under `shipFrom.addressId` —
 * resolving the registered pickup address is an upstream/framework concern.
 *
 * COD is transmitted as a value-added service carrying the exact 2dp
 * collectible text (INV-15); UNRESOLVED never reaches create (the booking
 * flow resolves the mode first), so it is transmitted as prepaid. Only
 * fields the §8.2 request actually carries are transmitted — RV-13
 * protected recipient fields go at booking only.
 */
export function buildCreateShipmentBody(input: CreatePayloadInput): string {
  return JSON.stringify({
    clientReferenceId: input.merchantReference, // §9.5.4
    channelDetails: { channelType: 'EXTERNAL' },
    shipFrom: { addressId: input.pickupLocationId },
    shipTo: {
      name: input.recipient.name,
      addressLine1: input.recipient.addressLines[0] ?? '',
      addressLine2: input.recipient.addressLines.slice(1).join(', ') || undefined,
      city: input.recipient.city,
      stateOrRegion: input.recipient.state,
      postalCode: input.recipient.pincode,
      countryCode: 'IN',
      phoneNumber: input.recipient.phone,
      email: input.recipient.email ?? undefined,
    },
    packages: [
      {
        dimensions: {
          length: input.lengthCm,
          width: input.widthCm,
          height: input.heightCm,
          unit: 'CENTIMETER',
        },
        weight: {
          value: kgTextToGramsText(input.deadWeightKg),
          unit: 'GRAM', // TODO(sandbox-verify): GRAM vs KILOGRAM
        },
        insuredValue: { value: input.declaredValue, unit: 'INR' },
      },
    ],
    valueAddedServices:
      input.paymentMode === 'COD'
        ? [{ id: 'COD', amount: { value: input.collectible, unit: 'INR' } }]
        : [],
  });
}

export interface ParsedCreateResult {
  success: boolean;
  awb: string | null;
  /** §3.25: becomes PROVIDER_CONFIRMED_CHARGE when present (2dp text). */
  confirmedCharge: string | null;
  failureReasons: string[];
}

/** TODO(sandbox-verify): best-known create response
 *  `{payload:{shipmentId, barcode/trackingId, ...}}`; our awb is the
 *  shipment id (which doubles as the tracking id). A confirmed charge is
 *  surfaced only when the provider returns one (totalCharge.value /
 *  charges.total). */
export function parseCreateResponse(body: unknown): ParsedCreateResult {
  if (!isObj(body)) {
    return { success: false, awb: null, confirmedCharge: null, failureReasons: ['INVALID_RESPONSE'] };
  }
  const payload = isObj(body.payload) ? body.payload : body;
  const awb =
    asString(payload.shipmentId) ?? asString(payload.trackingId) ?? asString(payload.barcode);
  if (awb) {
    const charge =
      (isObj(payload.totalCharge)
        ? providerAmountToMoney2dp(payload.totalCharge.value)
        : null) ??
      providerAmountToMoney2dp(payload.totalCharge) ??
      (isObj(payload.charges) ? providerAmountToMoney2dp(payload.charges.total) : null);
    return { success: true, awb, confirmedCharge: charge, failureReasons: [] };
  }
  const code = parseProviderErrorCode(body, 200);
  return {
    success: false,
    awb: null,
    confirmedCharge: null,
    failureReasons: [code === 'HTTP_200' ? 'SHIPMENT_ID_MISSING_IN_RESPONSE' : code],
  };
}

// ---------------------------------------------------------------------
// §8.2 lookupByReference (RW-12) — GET /shipping/v2/shipments
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): the collection filter carrying clientReferenceId. */
export function buildLookupQuery(merchantReference: string): Record<string, string> {
  return { clientReferenceId: merchantReference };
}

export interface ParsedLookupResult {
  found: boolean;
  awb: string | null;
}

/** TODO(sandbox-verify): best-known `{payload:{shipments:[{shipmentId,
 *  clientReferenceId}]}}`; a single-shipment payload is admitted
 *  defensively. */
export function parseLookupResponse(body: unknown): ParsedLookupResult {
  if (!isObj(body)) return { found: false, awb: null };
  const payload = isObj(body.payload) ? body.payload : body;
  const first = asArray(payload.shipments).filter(isObj)[0];
  const node = first ?? payload;
  const awb = asString(node.shipmentId) ?? asString(node.trackingId);
  return awb ? { found: true, awb } : { found: false, awb: null };
}

// ---------------------------------------------------------------------
// §8.2 track — GET /shipping/v2/tracking
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): the tracking query parameter (trackingId). */
export function buildTrackQuery(awb: string): Record<string, string> {
  return { trackingId: awb };
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

/** TODO(sandbox-verify): provider datetimes are ISO-8601; best-effort parse. */
export function parseProviderDateTime(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const direct = Date.parse(s);
  if (!Number.isNaN(direct)) return new Date(direct).toISOString();
  const spaced = Date.parse(s.replace(' ', 'T'));
  if (!Number.isNaN(spaced)) return new Date(spaced).toISOString();
  return null;
}

/** TODO(sandbox-verify): best-known response `{payload:{trackingId,
 *  summary:{status,...}, eventHistory:[{eventCode, eventTime, location,
 *  shipmentType}]}}`. Parsed defensively: the event list is sought under
 *  eventHistory / events; with no list, one event is synthesized from the
 *  summary status so a freshly booked shipment still yields a polling event
 *  (§8.5 fallback). Raw statuses pass through unmapped — normalization
 *  happens against courier_status_map (§3.6, A2-06), not in the adapter. */
export function parseTrackingResponse(body: unknown): ParsedTrackingPackage | null {
  if (!isObj(body)) return null;
  const payload = isObj(body.payload) ? body.payload : body;
  if (asArray(body.errors).length > 0 && !payload.trackingId) return null;

  const eventRows =
    asArray(payload.eventHistory).length > 0
      ? asArray(payload.eventHistory)
      : asArray(payload.events);
  const scans = eventRows.filter(isObj).map((row) => {
    const location = isObj(row.location) ? row.location : {};
    const locationText =
      [asString(location.city), asString(location.stateOrRegion), asString(location.countryCode)]
        .filter((s): s is string => s !== null)
        .join(', ') || null;
    return {
      rawStatus:
        asString(row.eventCode) ?? asString(row.status) ?? asString(row.eventType) ?? 'UNKNOWN',
      occurredAt:
        parseProviderDateTime(row.eventTime) ??
        parseProviderDateTime(row.eventDate) ??
        parseProviderDateTime(row.timestamp),
      locationText,
      reasonText: asString(row.reason) ?? asString(row.exceptionReason),
      providerEventId: asString(row.eventId) ?? asString(row.id),
    };
  });

  if (scans.length === 0) {
    const summary = isObj(payload.summary) ? payload.summary : {};
    const rawStatus = asString(summary.status) ?? asString(payload.status);
    if (rawStatus) {
      scans.push({
        rawStatus,
        occurredAt:
          parseProviderDateTime(summary.lastUpdatedTime) ?? parseProviderDateTime(summary.eventTime),
        locationText: null,
        reasonText: null,
        providerEventId: null,
      });
    }
  }

  const awb = asString(payload.trackingId) ?? asString(payload.shipmentId);
  if (!awb && scans.length === 0) return null;
  return { awb, scans };
}

// ---------------------------------------------------------------------
// §8.2 cancelShipment / getLabel
// ---------------------------------------------------------------------

/** Substitutes the shipment id into the cancel path template. */
export function buildCancelPath(shipmentId: string): string {
  return AMAZON_SHIPPING_ENDPOINTS.cancel.path.replace(':shipmentId', encodeURIComponent(shipmentId));
}

export interface ParsedCancelAck {
  accepted: boolean;
  reason: string | null;
}

/** TODO(sandbox-verify): best-known cancel ack `{payload:{shipmentId,
 *  status:"CANCELLED"}}` (or bare 204). Any 2xx reaching here is accepted;
 *  refusal statuses are classified by HTTP status
 *  (CANCEL_REJECT_HTTP_STATUSES) before this parser runs. */
export function parseCancelResponse(body: unknown): ParsedCancelAck {
  if (body === null || body === '') return { accepted: true, reason: null }; // 204
  if (!isObj(body)) return { accepted: true, reason: null };
  const payload = isObj(body.payload) ? body.payload : body;
  const status = asString(payload.status);
  if (status && status.toUpperCase() === 'CANCELLED') return { accepted: true, reason: null };
  if (asString(payload.shipmentId)) return { accepted: true, reason: null };
  const reason = asString(payload.reason) ?? asString(payload.message);
  return {
    accepted: false,
    reason: reason ? providerMessageToCode(reason, 'CANCEL_REJECTED') : 'CANCEL_REJECTED',
  };
}

/** TODO(sandbox-verify): the label query (shipmentId + page/format hints). */
export function buildLabelQuery(awb: string): Record<string, string> {
  return { shipmentId: awb, pageType: 'THERMAL_4X6', format: 'PDF' };
}

/** TODO(sandbox-verify): best-known label response carries the PDF
 *  base64-encoded — `{payload:{documents:[{format:"PDF", data:"<base64>"}]}}`;
 *  `{payload:{label:{data}}}` and a flat `{data}` are admitted defensively.
 *  Returns the base64 payload or null. */
export function parseLabelBase64(body: unknown): string | null {
  if (!isObj(body)) return null;
  const payload = isObj(body.payload) ? body.payload : body;
  const firstDoc = asArray(payload.documents).filter(isObj)[0];
  const candidates: unknown[] = [
    firstDoc?.data,
    firstDoc?.contents,
    isObj(payload.label) ? payload.label.data : undefined,
    payload.data,
  ];
  for (const c of candidates) {
    const s = asString(c);
    if (s) return s;
  }
  return null;
}
