import type { QuoteComponent } from '../courier-framework/adapter.types';

/**
 * Delhivery API endpoint & payload map — the SINGLE file that isolates every
 * externally-sourced fact about the Delhivery API (§8.2 transport).
 *
 * Exact Delhivery endpoint behaviour is externally sourced and the sandbox
 * is an owner-side week-0 item (§14), so EVERY endpoint URL, HTTP method,
 * request mapping and response mapping below carries a TODO(sandbox-verify)
 * marker. A sandbox pass should need to correct this file only.
 *
 * Money boundary (INV-15): provider amounts arrive as JSON numbers/strings
 * and are converted ONCE, here, into exact 2dp text via integer paise. No
 * float arithmetic crosses into the rest of the adapter, and no amount is
 * marked up (INV-23 — BYOC, merchant's own credentials).
 */

export const DELHIVERY_COURIER_CODE = 'DELHIVERY';

// ---------------------------------------------------------------------
// Base URLs & auth
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): staging host name; Delhivery staging is
 *  externally documented as staging-express.delhivery.com. */
export const DELHIVERY_BASE_URLS: Record<'TEST' | 'LIVE', string> = {
  TEST: 'https://staging-express.delhivery.com',
  LIVE: 'https://track.delhivery.com',
};

/** KEY_PASTE (§9.3): one secret credential field. The Authorization header
 *  is `Token <api_token>` — TODO(sandbox-verify). */
export const DELHIVERY_CREDENTIAL_KEYS = ['api_token'] as const;
export const DELHIVERY_AUTH_SCHEME = 'Token'; // Authorization: Token <api_token>

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
export const DELHIVERY_ENDPOINTS = {
  /** Pincode serviceability + COD/prepaid flags. */
  serviceability: {
    method: 'GET',
    path: '/c/api/pin-codes/json/',
    timeoutMs: 10_000,
  },
  /** Invoice/charges rating API (the "kinko" quote). */
  quoteCharges: {
    method: 'GET',
    path: '/api/kinko/v1/invoice/charges/.json',
    timeoutMs: 10_000,
  },
  /** Bulk waybill fetch (count=1) before a create. */
  waybillBulk: {
    method: 'GET',
    path: '/waybill/api/bulk/json/',
    timeoutMs: 10_000,
  },
  /** CMU create (manifest) — keyed by the client order reference. */
  createShipment: {
    method: 'POST',
    path: '/api/cmu/create.json',
    timeoutMs: 20_000,
    contentType: 'application/x-www-form-urlencoded',
  },
  /** Package tracking; also the reference-lookup surface (INV-5, RW-12). */
  tracking: {
    method: 'GET',
    path: '/api/v1/packages/json/',
    timeoutMs: 10_000,
  },
  /** Package edit — used with the cancellation flag. */
  cancel: {
    method: 'POST',
    path: '/api/p/edit',
    timeoutMs: 15_000,
    contentType: 'application/x-www-form-urlencoded',
  },
  /** Pickup request. */
  pickup: {
    method: 'POST',
    path: '/fm/request/new/',
    timeoutMs: 15_000,
    contentType: 'application/json',
  },
  /** Packing slip (courier PDF label). */
  packingSlip: {
    method: 'GET',
    path: '/api/p/packing_slip',
    timeoutMs: 20_000,
  },
  /** NDR action (reattempt / address update / RTO). */
  ndrAction: {
    method: 'POST',
    path: '/api/p/ndr_action/',
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

/** 3dp kg text → integer grams text (Delhivery rates/creates in grams). */
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
    for (const key of ['error', 'Error', 'message', 'rmk', 'detail']) {
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
// §8.2 getQuote — serviceability + invoice charges
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): `filter_codes` accepts a comma-separated pin list. */
export function buildServiceabilityQuery(pincodes: string[]): Record<string, string> {
  return { filter_codes: pincodes.join(',') };
}

export interface PincodeServiceability {
  pincode: string;
  serviceable: boolean;
  cod: boolean;
  prepaid: boolean;
}

/** TODO(sandbox-verify): response `{delivery_codes:[{postal_code:{pin,cod,
 *  pre_paid,...}}]}` with 'Y'/'N' flags. */
export function parseServiceabilityResponse(body: unknown): PincodeServiceability[] {
  if (!isObj(body)) return [];
  return asArray(body.delivery_codes)
    .map((row) => (isObj(row) && isObj(row.postal_code) ? row.postal_code : null))
    .filter((pc): pc is Record<string, unknown> => pc !== null)
    .map((pc) => ({
      pincode: asString(pc.pin) ?? '',
      serviceable: true, // presence in delivery_codes == serviceable (TODO(sandbox-verify))
      cod: pc.cod === 'Y',
      prepaid: pc.pre_paid === 'Y',
    }));
}

/** Structured §8.3 failure codes this adapter emits from serviceability. */
export const SERVICEABILITY_FAILURE_CODES = {
  ORIGIN_NOT_SERVICEABLE: 'ORIGIN_NOT_SERVICEABLE',
  DESTINATION_NOT_SERVICEABLE: 'DESTINATION_NOT_SERVICEABLE',
  COD_NOT_SERVICEABLE: 'COD_NOT_SERVICEABLE',
} as const;

export interface QuoteChargesQueryInput {
  originPincode: string;
  destinationPincode: string;
  deadWeightKg: string; // 3dp text
  paymentMode: 'PREPAID' | 'COD' | 'UNRESOLVED';
  /** 2dp text; '0.00' for prepaid. */
  collectible: string;
}

/**
 * TODO(sandbox-verify): kinko query params — `md` (S=surface/E=express),
 * `cgm` (grams), `o_pin`, `d_pin`, `pt` ('Pre-paid'|'COD'), `cod` amount.
 * NOTE: the adapter interface carries a serviceId UUID, not a service
 * code, so the S/E mode defaults to 'S' here; resolving the merchant's
 * chosen Delhivery service to md is an integration follow-up.
 * UNRESOLVED payment mode is rated as Pre-paid (never a guess upstream —
 * the quote is indicative only until S-14 resolves the mode).
 */
export function buildQuoteChargesQuery(input: QuoteChargesQueryInput): Record<string, string> {
  return {
    md: 'S',
    cgm: kgTextToGramsText(input.deadWeightKg),
    o_pin: input.originPincode,
    d_pin: input.destinationPincode,
    pt: input.paymentMode === 'COD' ? 'COD' : 'Pre-paid',
    cod: input.paymentMode === 'COD' ? input.collectible : '0',
  };
}

/** TODO(sandbox-verify): charge field names in the kinko response. Each
 *  known field becomes one §8.3 component, passed through unmarked (INV-23). */
const CHARGE_COMPONENT_MAP: ReadonlyArray<{
  key: string;
  code: string;
  label: string;
  taxable: boolean;
}> = [
  { key: 'charge_DL', code: 'DL_FREIGHT', label: 'Freight charge', taxable: true },
  { key: 'charge_FSC', code: 'DL_FUEL', label: 'Fuel surcharge', taxable: true },
  { key: 'charge_COD', code: 'DL_COD', label: 'COD charge', taxable: true },
  { key: 'charge_DPH', code: 'DL_HANDLING', label: 'Handling charge', taxable: true },
  { key: 'charge_CUC', code: 'DL_CUC', label: 'Connectivity charge', taxable: true },
  { key: 'charge_ROV', code: 'DL_ROV', label: 'ROV / insurance charge', taxable: true },
  { key: 'charge_RTO', code: 'DL_RTO', label: 'RTO charge', taxable: true },
  { key: 'charge_AIR', code: 'DL_AIR', label: 'Air surcharge', taxable: true },
  { key: 'tax', code: 'DL_GST', label: 'GST', taxable: false },
  { key: 'gst', code: 'DL_GST', label: 'GST', taxable: false },
];

export interface ParsedQuoteCharges {
  components: QuoteComponent[];
  /** Sum of the stored rounded components (INV-15), 2dp text. */
  total: string;
  /** ISO date, when the provider returns one. */
  expectedDeliveryDate: string | null;
}

/** TODO(sandbox-verify): response is a single-element array of charge
 *  fields. The total is derived as the exact sum of the stored components
 *  (INV-15) rather than trusting a provider `total_amount` float. */
export function parseQuoteChargesResponse(body: unknown): ParsedQuoteCharges {
  const row = asArray(body).find(isObj);
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
// §8.2 createShipment — waybill fetch + CMU create
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): bulk waybill params (`count`). */
export function buildWaybillBulkQuery(count: number): Record<string, string> {
  return { count: String(count) };
}

/** TODO(sandbox-verify): response shape — best-known a JSON array of
 *  waybill strings/numbers; parsed defensively. */
export function parseWaybillBulkResponse(body: unknown): string | null {
  if (Array.isArray(body)) {
    for (const v of body) {
      const s = asString(v);
      if (s) return s;
    }
    return null;
  }
  if (isObj(body)) {
    for (const key of ['waybills', 'waybill', 'data']) {
      const nested = parseWaybillBulkResponse(body[key]);
      if (nested) return nested;
    }
  }
  return null;
}

export interface CreatePayloadInput {
  waybill: string;
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
}

/**
 * TODO(sandbox-verify): CMU create is form-encoded
 * `format=json&data=<urlencoded JSON>` with `pickup_location` and a
 * `shipments` array; the client order reference field is `order` — this is
 * the merchant_reference of §9.5.4 and keys Delhivery-side idempotency.
 *
 * TODO(sandbox-verify) / integration gap: `pickup_location.name` must be
 * the merchant's warehouse name AS REGISTERED in the Delhivery panel; the
 * adapter receives our internal pickup_location_id and passes it through —
 * resolving the registered name is an upstream/framework concern.
 *
 * Only fields the §8.2 request actually carries are transmitted — no
 * invented fields (RV-13 protected recipient fields go at booking only).
 */
export function buildCreateShipmentBody(input: CreatePayloadInput): string {
  const data = {
    pickup_location: { name: input.pickupLocationId },
    shipments: [
      {
        waybill: input.waybill,
        order: input.merchantReference, // §9.5.4 stable merchant reference
        name: input.recipient.name,
        add: input.recipient.addressLines.join(', '),
        city: input.recipient.city,
        state: input.recipient.state,
        pin: input.recipient.pincode,
        phone: input.recipient.phone,
        payment_mode: input.paymentMode === 'COD' ? 'COD' : 'Prepaid',
        cod_amount: input.paymentMode === 'COD' ? input.collectible : '0',
        weight: kgTextToGramsText(input.deadWeightKg),
        quantity: '1', // INV-4: fixed 1 at v1
      },
    ],
  };
  return `format=json&data=${encodeURIComponent(JSON.stringify(data))}`;
}

export interface ParsedCreateResult {
  success: boolean;
  awb: string | null;
  /** §3.25: becomes PROVIDER_CONFIRMED_CHARGE when present (2dp text). */
  confirmedCharge: string | null;
  failureReasons: string[];
}

/** TODO(sandbox-verify): response `{success, packages:[{waybill, refnum,
 *  status, ...}], error/rmk}`. A confirmed charge is surfaced only when the
 *  provider returns one (`total_amount`/`charged_amount`). */
export function parseCreateResponse(body: unknown): ParsedCreateResult {
  if (!isObj(body)) {
    return { success: false, awb: null, confirmedCharge: null, failureReasons: ['INVALID_RESPONSE'] };
  }
  const topError = asString(body.error) ?? asString(body.rmk);
  const packages = asArray(body.packages).filter(isObj);
  if (packages.length === 0) {
    return {
      success: false,
      awb: null,
      confirmedCharge: null,
      failureReasons: [
        topError ? providerMessageToCode(topError, 'SHIPMENT_REJECTED') : 'SHIPMENT_REJECTED',
      ],
    };
  }
  const pkg = packages[0];
  const pkgStatus = asString(pkg.status);
  const awb = asString(pkg.waybill);
  if (!awb || (pkgStatus !== null && /fail|error/i.test(pkgStatus))) {
    const reason = asString(pkg.remarks) ?? asString(pkg.error) ?? pkgStatus ?? topError;
    return {
      success: false,
      awb: null,
      confirmedCharge: null,
      failureReasons: [reason ? providerMessageToCode(reason, 'SHIPMENT_REJECTED') : 'SHIPMENT_REJECTED'],
    };
  }
  const charge =
    providerAmountToMoney2dp(pkg.total_amount) ??
    providerAmountToMoney2dp(pkg.charged_amount) ??
    providerAmountToMoney2dp(body.total_amount);
  return { success: true, awb, confirmedCharge: charge, failureReasons: [] };
}

// ---------------------------------------------------------------------
// §8.2 lookupByReference (RW-12) + track — the packages JSON API
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): the packages API filters by `waybill` and by
 *  `ref_ids` (client reference). ref_ids is the INV-5 resolution surface. */
export function buildTrackingQueryByWaybill(awb: string): Record<string, string> {
  return { waybill: awb };
}

export function buildTrackingQueryByReference(merchantReference: string): Record<string, string> {
  return { ref_ids: merchantReference };
}

export interface ParsedTrackingPackage {
  awb: string | null;
  scans: Array<{
    rawStatus: string;
    occurredAt: string | null; // ISO, null when unparseable
    locationText: string | null;
    reasonText: string | null;
  }>;
}

/** TODO(sandbox-verify): provider datetimes (`ScanDateTime`,
 *  `StatusDateTime`) — format varies; best-effort parse to ISO. */
export function parseProviderDateTime(raw: unknown): string | null {
  const s = asString(raw);
  if (!s) return null;
  const direct = Date.parse(s);
  if (!Number.isNaN(direct)) return new Date(direct).toISOString();
  const spaced = Date.parse(s.replace(' ', 'T'));
  if (!Number.isNaN(spaced)) return new Date(spaced).toISOString();
  return null;
}

/** TODO(sandbox-verify): `{ShipmentData:[{Shipment:{AWB, Status:{...},
 *  Scans:[{ScanDetail:{Scan, ScanDateTime, ScannedLocation, Instructions}}]}}]}`. */
export function parseTrackingResponse(body: unknown): ParsedTrackingPackage | null {
  if (!isObj(body)) return null;
  const first = asArray(body.ShipmentData).find(isObj);
  if (!first || !isObj(first.Shipment)) return null;
  const shipment = first.Shipment;
  const scans = asArray(shipment.Scans)
    .map((s) => (isObj(s) && isObj(s.ScanDetail) ? s.ScanDetail : null))
    .filter((d): d is Record<string, unknown> => d !== null)
    .map((d) => ({
      rawStatus: asString(d.Scan) ?? 'UNKNOWN',
      occurredAt: parseProviderDateTime(d.ScanDateTime),
      locationText: asString(d.ScannedLocation),
      reasonText: asString(d.Instructions),
    }));
  // No scans but a current status: synthesize one event from Status so a
  // freshly-booked AWB still yields a polling event (§8.5 fallback).
  if (scans.length === 0 && isObj(shipment.Status)) {
    const status = shipment.Status;
    const rawStatus = asString(status.Status);
    if (rawStatus) {
      scans.push({
        rawStatus,
        occurredAt: parseProviderDateTime(status.StatusDateTime),
        locationText: asString(status.StatusLocation),
        reasonText: asString(status.Instructions),
      });
    }
  }
  return { awb: asString(shipment.AWB), scans };
}

// ---------------------------------------------------------------------
// §8.2 cancelShipment / schedulePickup / getLabel / ndrAction
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): cancellation via /api/p/edit with a cancellation
 *  flag, form-encoded. */
export function buildCancelBody(awb: string): string {
  return `waybill=${encodeURIComponent(awb)}&cancellation=true`;
}

export interface ParsedSimpleAck {
  accepted: boolean;
  reason: string | null;
  id: string | null;
}

function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 'True' || v === 1 || v === '1';
}

/** TODO(sandbox-verify): cancel ack shape — best-known `{status:true}` /
 *  `{success:true}`; an explicit false with a message is a REJECTED. */
export function parseCancelResponse(body: unknown): ParsedSimpleAck {
  if (!isObj(body)) return { accepted: false, reason: 'INVALID_RESPONSE', id: null };
  if (truthy(body.status) || truthy(body.success)) return { accepted: true, reason: null, id: null };
  const reason = asString(body.message) ?? asString(body.error) ?? asString(body.rmk);
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

/** TODO(sandbox-verify): /fm/request/new/ fields — pickup_date,
 *  pickup_time, pickup_location (registered warehouse name; same
 *  integration gap as create), expected_package_count. */
export function buildPickupBody(input: PickupBodyInput): string {
  return JSON.stringify({
    pickup_date: input.pickupDate,
    pickup_time: '10:00:00', // TODO(sandbox-verify): required window field
    pickup_location: input.pickupLocationId,
    expected_package_count: input.packageCount,
  });
}

/** TODO(sandbox-verify): pickup ack shape — `pickup_id` /
 *  `pickup_request_id` plus a success/status flag. */
export function parsePickupResponse(body: unknown): ParsedSimpleAck {
  if (!isObj(body)) return { accepted: false, reason: 'INVALID_RESPONSE', id: null };
  const id = asString(body.pickup_id) ?? asString(body.pickup_request_id);
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

/** TODO(sandbox-verify): packing slip params (`waybill`, `pdf=true`). */
export function buildPackingSlipQuery(awb: string): Record<string, string> {
  return { waybill: awb, pdf: 'true' };
}

/**
 * TODO(sandbox-verify): NDR action endpoint, verb field and action values.
 * Best-known mapping of the §8.2 NdrActionType vocabulary:
 * - REATTEMPT → reattempt (optional deferred date in payload.deferredDate)
 * - UPDATE_ADDRESS_AND_REATTEMPT → reattempt with payload.address
 * - INITIATE_RTO → RTO
 */
export function buildNdrActionBody(input: {
  awb: string;
  action: 'REATTEMPT' | 'UPDATE_ADDRESS_AND_REATTEMPT' | 'INITIATE_RTO';
  payload: Record<string, unknown>;
}): string {
  const body: Record<string, unknown> = { waybill: input.awb };
  if (input.action === 'INITIATE_RTO') {
    body.action = 'RTO';
  } else {
    body.action = 'REATTEMPT';
    if (input.action === 'UPDATE_ADDRESS_AND_REATTEMPT' && input.payload.address !== undefined) {
      body.address = input.payload.address;
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
  if (truthy(body.status) || truthy(body.success)) {
    return { accepted: true, reason: null, id: asString(body.request_id) ?? asString(body.id) };
  }
  const reason = asString(body.message) ?? asString(body.error);
  return {
    accepted: false,
    reason: reason ? providerMessageToCode(reason, 'NDR_REJECTED') : 'NDR_REJECTED',
    id: null,
  };
}
