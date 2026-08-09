import type { QuoteComponent } from '../courier-framework/adapter.types';

/**
 * DTDC API endpoint & payload map — the SINGLE file that isolates every
 * externally-sourced fact about the DTDC API (§8.2 transport).
 *
 * Exact DTDC endpoint behaviour is externally sourced and the sandbox is an
 * owner-side week-0 item (§14), so EVERY endpoint URL, HTTP method, request
 * mapping and response mapping below carries a TODO(sandbox-verify) marker.
 * A sandbox pass should need to correct this file only.
 *
 * Money boundary (INV-15): provider amounts arrive as JSON numbers/strings
 * and are converted ONCE, here, into exact 2dp text via integer paise. No
 * float arithmetic crosses into the rest of the adapter, and no amount is
 * marked up (INV-23 — BYOC, merchant's own credentials).
 */

export const DTDC_COURIER_CODE = 'DTDC';

// ---------------------------------------------------------------------
// Base URLs & auth
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): DTDC's public API host is externally documented as
 *  pxapi.dtdc.in with every endpoint under the `/api` base path (carried on
 *  the endpoint paths below — `new URL(path, base)` drops a base path that
 *  lacks a trailing slash); no distinct public staging host is known — a
 *  separate TEST host, if one exists, is a sandbox-pass correction. */
export const DTDC_BASE_URLS: Record<'TEST' | 'LIVE', string> = {
  TEST: 'https://pxapi.dtdc.in',
  LIVE: 'https://pxapi.dtdc.in',
};

/** KEY_PASTE (§9.3): one secret credential field. Best-known auth is the API
 *  key sent in an `X-Access-Token` header — TODO(sandbox-verify): some DTDC
 *  integrations document `api-key` instead. */
export const DTDC_CREDENTIAL_KEYS = ['api_key'] as const;
export const DTDC_AUTH_HEADER = 'X-Access-Token';

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
export const DTDC_ENDPOINTS = {
  /** Pincode-pair serviceability + COD/prepaid flags. */
  serviceability: {
    method: 'POST',
    path: '/api/pincode/serviceable',
    timeoutMs: 10_000,
    contentType: 'application/json',
  },
  /** Rate calculator (weight, origin, destination, COD amount). */
  quoteCharges: {
    method: 'POST',
    path: '/api/calculator',
    timeoutMs: 10_000,
    contentType: 'application/json',
  },
  /** Consignment booking — keyed by the customer reference number. */
  createShipment: {
    method: 'POST',
    path: '/api/customer_awb_consignment_booking',
    timeoutMs: 20_000,
    contentType: 'application/json',
  },
  /** Tracking; also the reference-lookup surface (INV-5, RW-12). */
  tracking: {
    method: 'GET',
    path: '/api/track-json',
    timeoutMs: 10_000,
  },
  /** Consignment cancellation. */
  cancel: {
    method: 'POST',
    path: '/api/operations/consignment/cancel',
    timeoutMs: 15_000,
    contentType: 'application/json',
  },
  /** Pickup request. */
  pickup: {
    method: 'POST',
    path: '/api/pickup/request',
    timeoutMs: 15_000,
    contentType: 'application/json',
  },
  /** Label PDF. */
  label: {
    method: 'GET',
    path: '/api/operations/label',
    timeoutMs: 20_000,
  },
  /**
   * NDR action: DTDC exposes NDR/reattempt endpoints inconsistently across
   * its public surfaces, so no endpoint is wired at v1 — the adapter
   * declares ndrAction supported=false with a manual fallback note (A1-03).
   * TODO(sandbox-verify): if a stable NDR action endpoint exists, add it
   * here and flip the capability row in dtdc.seed.ts.
   */
} as const satisfies Record<string, EndpointSpec>;

// ---------------------------------------------------------------------
// Small exact-money helpers (INV-15: never floats past here)
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

/** DTDC flags arrive as booleans or 'Y'/'N'-style strings — TODO(sandbox-verify). */
function truthy(v: unknown): boolean {
  return (
    v === true ||
    v === 'true' ||
    v === 'True' ||
    v === 1 ||
    v === '1' ||
    v === 'Y' ||
    v === 'y' ||
    v === 'YES'
  );
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
    for (const key of ['error', 'Error', 'message', 'Message', 'detail', 'errorMessage']) {
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
// §8.2 getQuote — serviceability + rate calculator
// ---------------------------------------------------------------------

export interface ServiceabilityBodyInput {
  originPincode: string;
  destinationPincode: string;
}

/** TODO(sandbox-verify): pincode-pair serviceability request fields. */
export function buildServiceabilityBody(input: ServiceabilityBodyInput): string {
  return JSON.stringify({
    origin_pincode: input.originPincode,
    destination_pincode: input.destinationPincode,
  });
}

export interface PincodeServiceability {
  pincode: string;
  serviceable: boolean;
  cod: boolean;
  prepaid: boolean;
}

/** TODO(sandbox-verify): response `{success, data:[{pincode, serviceable,
 *  cod_available, prepaid_available}]}` — parsed defensively across boolean
 *  and 'Y'/'N' flag spellings. */
export function parseServiceabilityResponse(body: unknown): PincodeServiceability[] {
  if (!isObj(body)) return [];
  return asArray(body.data)
    .filter(isObj)
    .map((row) => ({
      pincode: asString(row.pincode) ?? '',
      serviceable: truthy(row.serviceable),
      cod: truthy(row.cod_available ?? row.cod),
      prepaid: truthy(row.prepaid_available ?? row.prepaid),
    }));
}

/** Structured §8.3 failure codes this adapter emits from serviceability. */
export const SERVICEABILITY_FAILURE_CODES = {
  ORIGIN_NOT_SERVICEABLE: 'ORIGIN_NOT_SERVICEABLE',
  DESTINATION_NOT_SERVICEABLE: 'DESTINATION_NOT_SERVICEABLE',
  COD_NOT_SERVICEABLE: 'COD_NOT_SERVICEABLE',
} as const;

export interface QuoteChargesBodyInput {
  originPincode: string;
  destinationPincode: string;
  deadWeightKg: string; // 3dp text
  paymentMode: 'PREPAID' | 'COD' | 'UNRESOLVED';
  /** 2dp text; '0.00' for prepaid. */
  collectible: string;
}

/**
 * TODO(sandbox-verify): calculator request fields — best-known
 * `origin_pincode`/`destination_pincode`, `weight` in kg (3dp text passed
 * through exactly, INV-15), `payment_type` ('PREPAID'|'COD') and
 * `cod_amount`. UNRESOLVED payment mode is rated as PREPAID (never a guess
 * upstream — the quote is indicative only until S-14 resolves the mode).
 * NOTE: the adapter interface carries a serviceId UUID, not a DTDC product
 * code; resolving the merchant's chosen DTDC service to a product code is
 * an integration follow-up.
 */
export function buildQuoteChargesBody(input: QuoteChargesBodyInput): string {
  return JSON.stringify({
    origin_pincode: input.originPincode,
    destination_pincode: input.destinationPincode,
    weight: input.deadWeightKg,
    payment_type: input.paymentMode === 'COD' ? 'COD' : 'PREPAID',
    cod_amount: input.paymentMode === 'COD' ? input.collectible : '0.00',
  });
}

/** TODO(sandbox-verify): charge field names in the calculator response.
 *  Each known field becomes one §8.3 component, passed through unmarked
 *  (INV-23). */
const CHARGE_COMPONENT_MAP: ReadonlyArray<{
  key: string;
  code: string;
  label: string;
  taxable: boolean;
}> = [
  { key: 'freight_charge', code: 'DTDC_FREIGHT', label: 'Freight charge', taxable: true },
  { key: 'fuel_surcharge', code: 'DTDC_FUEL', label: 'Fuel surcharge', taxable: true },
  { key: 'cod_charge', code: 'DTDC_COD', label: 'COD charge', taxable: true },
  { key: 'handling_charge', code: 'DTDC_HANDLING', label: 'Handling charge', taxable: true },
  { key: 'other_charges', code: 'DTDC_OTHER', label: 'Other charges', taxable: true },
  { key: 'rov_charge', code: 'DTDC_ROV', label: 'ROV / insurance charge', taxable: true },
  { key: 'rto_charge', code: 'DTDC_RTO', label: 'RTO charge', taxable: true },
  { key: 'tax', code: 'DTDC_GST', label: 'GST', taxable: false },
  { key: 'gst', code: 'DTDC_GST', label: 'GST', taxable: false },
];

export interface ParsedQuoteCharges {
  components: QuoteComponent[];
  /** Sum of the stored rounded components (INV-15), 2dp text. */
  total: string;
  /** ISO date, when the provider returns one. */
  expectedDeliveryDate: string | null;
}

/** TODO(sandbox-verify): response `{success, data:{<charge fields>,
 *  expected_delivery_date}}` — the data row may also arrive as a
 *  single-element array. The total is derived as the exact sum of the
 *  stored components (INV-15) rather than trusting a provider
 *  `total_amount` float. */
export function parseQuoteChargesResponse(body: unknown): ParsedQuoteCharges {
  let row: Record<string, unknown> | null = null;
  if (isObj(body)) {
    if (isObj(body.data)) row = body.data;
    else row = asArray(body.data).find(isObj) ?? null;
  }
  const components: QuoteComponent[] = [];
  let totalPaise = 0;
  if (row) {
    for (const m of CHARGE_COMPONENT_MAP) {
      if (!(m.key in row)) continue;
      const amount = providerAmountToMoney2dp(row[m.key]);
      if (amount === null) continue;
      if (components.some((c) => c.code === m.code)) continue; // e.g. tax+gst
      components.push({ code: m.code, label: m.label, amount, taxable: m.taxable });
      totalPaise += parseUnits(amount, 2);
    }
  }
  const eddRaw = row ? asString(row.expected_delivery_date) : null;
  const edd = eddRaw && !Number.isNaN(Date.parse(eddRaw)) ? eddRaw.slice(0, 10) : null;
  return { components, total: paiseToMoney2dp(totalPaise), expectedDeliveryDate: edd };
}

// ---------------------------------------------------------------------
// §8.2 createShipment — consignment booking
// ---------------------------------------------------------------------

export interface CreateBodyInput {
  merchantReference: string;
  pickupLocationId: string;
  originPincode: string;
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
}

/**
 * TODO(sandbox-verify): booking request — best-known fields are
 * `customer_reference_number` (the client reference; this is the
 * merchant_reference of §9.5.4 and keys DTDC-side idempotency), a
 * `consignee` block, `origin_pincode`, `weight`, `payment_type` and
 * `cod_amount`.
 *
 * TODO(sandbox-verify) / integration gap: `customer_code`/`pickup_location`
 * must be the merchant's DTDC-registered customer/location code; the
 * adapter receives our internal pickup_location_id and passes it through —
 * resolving the registered code is an upstream/framework concern.
 *
 * Only fields the §8.2 request actually carries are transmitted — no
 * invented fields (RV-13 protected recipient fields go at booking only).
 */
export function buildCreateShipmentBody(input: CreateBodyInput): string {
  return JSON.stringify({
    customer_reference_number: input.merchantReference, // §9.5.4 stable merchant reference
    customer_code: input.pickupLocationId,
    origin_pincode: input.originPincode,
    consignee: {
      name: input.recipient.name,
      address: input.recipient.addressLines.join(', '),
      city: input.recipient.city,
      state: input.recipient.state,
      pincode: input.recipient.pincode,
      phone: input.recipient.phone,
    },
    weight: input.deadWeightKg,
    payment_type: input.paymentMode === 'COD' ? 'COD' : 'PREPAID',
    cod_amount: input.paymentMode === 'COD' ? input.collectible : '0.00',
    pieces: '1', // INV-4: fixed 1 at v1
  });
}

export interface ParsedCreateResult {
  success: boolean;
  awb: string | null;
  /** §3.25: becomes PROVIDER_CONFIRMED_CHARGE when present (2dp text). */
  confirmedCharge: string | null;
  failureReasons: string[];
}

/** TODO(sandbox-verify): response `{success, data:{awb_number,
 *  reference_number, status, charges:{total_amount}}, error/message}`.
 *  A confirmed charge is surfaced only when the provider returns one. */
export function parseCreateResponse(body: unknown): ParsedCreateResult {
  if (!isObj(body)) {
    return { success: false, awb: null, confirmedCharge: null, failureReasons: ['INVALID_RESPONSE'] };
  }
  const topError =
    asString(body.error) ?? asString(body.message) ?? asString(body.errorMessage);
  const data = isObj(body.data) ? body.data : (asArray(body.data).find(isObj) ?? null);
  const awb = data
    ? asString(data.awb_number) ?? asString(data.awb) ?? asString(data.consignment_number)
    : null;
  if (body.success === false || !data || !awb) {
    return {
      success: false,
      awb: null,
      confirmedCharge: null,
      failureReasons: [
        topError ? providerMessageToCode(topError, 'SHIPMENT_REJECTED') : 'SHIPMENT_REJECTED',
      ],
    };
  }
  const charges = isObj(data.charges) ? data.charges : null;
  const charge =
    (charges ? providerAmountToMoney2dp(charges.total_amount) : null) ??
    providerAmountToMoney2dp(data.total_amount);
  return { success: true, awb, confirmedCharge: charge, failureReasons: [] };
}

// ---------------------------------------------------------------------
// §8.2 lookupByReference (RW-12) + track — the tracking surface
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): the tracking endpoint filters by `awb` and by
 *  `reference_number` (client reference). reference_number is the INV-5
 *  resolution surface. */
export function buildTrackingQueryByWaybill(awb: string): Record<string, string> {
  return { awb };
}

export function buildTrackingQueryByReference(merchantReference: string): Record<string, string> {
  return { reference_number: merchantReference };
}

export interface ParsedTrackingConsignment {
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

/** TODO(sandbox-verify): `{success, data:{awb_number, reference_number,
 *  current_status, status_date, location, scans:[{status, date, location,
 *  remarks}]}}`. */
export function parseTrackingResponse(body: unknown): ParsedTrackingConsignment | null {
  if (!isObj(body)) return null;
  const data = isObj(body.data) ? body.data : asArray(body.data).find(isObj) ?? null;
  if (!data) return null;
  const awb =
    asString(data.awb_number) ?? asString(data.awb) ?? asString(data.consignment_number);
  const scans = asArray(data.scans)
    .filter(isObj)
    .map((s) => ({
      rawStatus: asString(s.status) ?? 'UNKNOWN',
      occurredAt: parseProviderDateTime(s.date ?? s.scan_date ?? s.status_date),
      locationText: asString(s.location),
      reasonText: asString(s.remarks ?? s.reason),
    }));
  // No scans but a current status: synthesize one event from it so a
  // freshly-booked AWB still yields a polling event (§8.5 fallback).
  if (scans.length === 0) {
    const rawStatus = asString(data.current_status);
    if (rawStatus) {
      scans.push({
        rawStatus,
        occurredAt: parseProviderDateTime(data.status_date),
        locationText: asString(data.location),
        reasonText: asString(data.remarks),
      });
    }
  }
  if (!awb && scans.length === 0) return null;
  return { awb, scans };
}

// ---------------------------------------------------------------------
// §8.2 cancelShipment / schedulePickup / getLabel
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): cancellation request fields (`awb`). */
export function buildCancelBody(awb: string): string {
  return JSON.stringify({ awb });
}

export interface ParsedSimpleAck {
  accepted: boolean;
  reason: string | null;
  id: string | null;
}

/** TODO(sandbox-verify): cancel ack shape — best-known `{success:true}`;
 *  an explicit false with a message is a REJECTED. */
export function parseCancelResponse(body: unknown): ParsedSimpleAck {
  if (!isObj(body)) return { accepted: false, reason: 'INVALID_RESPONSE', id: null };
  if (truthy(body.success) || truthy(body.status)) return { accepted: true, reason: null, id: null };
  const reason = asString(body.message) ?? asString(body.error) ?? asString(body.errorMessage);
  return {
    accepted: false,
    reason: reason ? providerMessageToCode(reason, 'CANCEL_REJECTED') : 'CANCEL_REJECTED',
    id: null,
  };
}

export interface PickupBodyInput {
  pickupLocationId: string;
  /** ISO date. */
  pickupDate: string;
  packageCount: number;
}

/** TODO(sandbox-verify): /pickup/request fields — pickup_date,
 *  customer_code/pickup_location (registered code; same integration gap as
 *  create), expected_package_count, and a required time-window field. */
export function buildPickupBody(input: PickupBodyInput): string {
  return JSON.stringify({
    pickup_date: input.pickupDate,
    pickup_time: '10:00:00', // TODO(sandbox-verify): required window field
    customer_code: input.pickupLocationId,
    expected_package_count: input.packageCount,
  });
}

/** TODO(sandbox-verify): pickup ack shape — `pickup_request_id` /
 *  `pickup_id` plus a success flag. */
export function parsePickupResponse(body: unknown): ParsedSimpleAck {
  if (!isObj(body)) return { accepted: false, reason: 'INVALID_RESPONSE', id: null };
  const id = asString(body.pickup_request_id) ?? asString(body.pickup_id);
  if (id || truthy(body.success) || truthy(body.status)) {
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
