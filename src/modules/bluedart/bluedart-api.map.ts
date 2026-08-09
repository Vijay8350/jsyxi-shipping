import type { QuoteComponent } from '../courier-framework/adapter.types';

/**
 * Blue Dart API endpoint & payload map — the SINGLE file that isolates every
 * externally-sourced fact about the Blue Dart API (§8.2 transport).
 *
 * Exact Blue Dart endpoint behaviour is externally sourced and the sandbox is
 * an owner-side week-0 item (§14), so EVERY endpoint URL, HTTP method,
 * request mapping and response mapping below carries a TODO(sandbox-verify)
 * marker. A sandbox pass should need to correct this file only.
 *
 * Money boundary (INV-15): provider amounts arrive as JSON numbers/strings
 * and are converted ONCE, here, into exact 2dp text via integer paise. No
 * float arithmetic crosses into the rest of the adapter, and no amount is
 * marked up (INV-23 — BYOC, merchant's own credentials).
 */

export const BLUEDART_COURIER_CODE = 'BLUEDART';

// ---------------------------------------------------------------------
// Base URLs & auth
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): Blue Dart's API gateway host; no separate public
 *  staging host is externally documented, so TEST points at the same gateway
 *  until the sandbox pass confirms otherwise. */
export const BLUEDART_BASE_URLS: Record<'TEST' | 'LIVE', string> = {
  TEST: 'https://apigateway.bluedart.com',
  LIVE: 'https://apigateway.bluedart.com',
};

/** KEY_PASTE (§9.3): a client_id + client_secret pair, exchanged for a JWT
 *  at the login endpoint and cached in Redis (see bluedart.adapter.ts). Both
 *  fields are secrets (§5.7). TODO(sandbox-verify): field names on the login
 *  request. */
export const BLUEDART_CREDENTIAL_KEYS = ['client_id', 'client_secret'] as const;

/** TODO(sandbox-verify): best-known Authorization scheme for the gateway
 *  JWT is `Bearer <token>`; some Blue Dart docs pass the raw token in a
 *  `JWTToken` header instead. */
export const BLUEDART_AUTH_SCHEME = 'Bearer';

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
export const BLUEDART_ENDPOINTS = {
  /** client_id + client_secret → JWT (cached in Redis, refreshed on 401). */
  login: {
    method: 'POST',
    path: '/in/transportation/token/v1/login',
    timeoutMs: 10_000,
    contentType: 'application/json',
  },
  /** Pincode serviceability + COD/prepaid flags. */
  serviceability: {
    method: 'GET',
    path: '/in/transportation/serviceability/v1/pincode',
    timeoutMs: 10_000,
  },
  /** Transit-time & price finder (rate quote). */
  quoteCharges: {
    method: 'GET',
    path: '/in/transportation/pricing/v1/transitTimeAndPrice',
    timeoutMs: 10_000,
  },
  /** Waybill generation — keyed by CreditReferenceNo (the client reference). */
  createShipment: {
    method: 'POST',
    path: '/in/transportation/waybill/v1/GenerateWayBill',
    timeoutMs: 20_000,
    contentType: 'application/json',
  },
  /** Shipment tracking; also the reference-lookup surface (INV-5, RW-12). */
  tracking: {
    method: 'GET',
    path: '/in/transportation/tracking/v1/shipment',
    timeoutMs: 10_000,
  },
  /** Waybill cancellation. */
  cancel: {
    method: 'POST',
    path: '/in/transportation/waybill/v1/CancelWaybill',
    timeoutMs: 15_000,
    contentType: 'application/json',
  },
  /** Pickup registration. */
  pickup: {
    method: 'POST',
    path: '/in/transportation/pickup/v1/RegisterPickup',
    timeoutMs: 15_000,
    contentType: 'application/json',
  },
  /** Courier-generated label PDF (label_mode COURIER_PDF_REQUIRED, §9.9.1 —
   *  Blue Dart's own PDF is fetched, never custom-rendered). */
  label: {
    method: 'GET',
    path: '/in/transportation/waybill/v1/GetGeneratedWaybill/forprint',
    timeoutMs: 20_000,
  },
} as const satisfies Record<string, EndpointSpec>;

/**
 * A1-03: Blue Dart's NDR-action APIs are externally inconsistent, so
 * ndrAction is declared supported = false at v1 with this manual fallback —
 * never a silent no-op. The adapter throws UnsupportedCapabilityError.
 */
export const BLUEDART_NDR_FALLBACK_NOTE =
  'Blue Dart NDR-action APIs are inconsistent at v1; action NDRs in the Blue Dart customer portal or via the Blue Dart account manager';

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
  if (Array.isArray(v)) return v;
  // Blue Dart frequently renders a single child as an object instead of a
  // one-element array — admit both (TODO(sandbox-verify) per shape).
  return isObj(v) ? [v] : [];
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
    for (const key of ['error', 'Error', 'message', 'Message', 'StatusMessage', 'detail']) {
      const v = asString(body[key]);
      if (v) return providerMessageToCode(v, `HTTP_${httpStatus}`);
    }
    if (body.success === false || body.IsError === true) return 'REQUEST_REJECTED';
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
// Auth — token login
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): login body field names. */
export function buildLoginBody(clientId: string, clientSecret: string): string {
  return JSON.stringify({ client_id: clientId, client_secret: clientSecret });
}

export interface ParsedLogin {
  token: string | null;
  /** Seconds until expiry as reported by the provider, null when absent. */
  expiresInSeconds: number | null;
}

/** TODO(sandbox-verify): login response `{ JWTToken, expires_in }` —
 *  defensive over the key spellings seen in Blue Dart docs. */
export function parseLoginResponse(body: unknown): ParsedLogin {
  if (!isObj(body)) return { token: null, expiresInSeconds: null };
  const token =
    asString(body.JWTToken) ??
    asString(body.jwtToken) ??
    asString(body.access_token) ??
    asString(body.token);
  const expRaw = asString(body.expires_in) ?? asString(body.expiresIn);
  const exp = expRaw !== null ? Number(expRaw) : NaN;
  return {
    token,
    expiresInSeconds: Number.isFinite(exp) && exp > 0 ? Math.floor(exp) : null,
  };
}

// ---------------------------------------------------------------------
// §8.2 getQuote — serviceability + transit-time & price
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): serviceability query params. */
export function buildServiceabilityQuery(pincodes: string[]): Record<string, string> {
  return { pinCodes: pincodes.join(',') };
}

export interface PincodeServiceability {
  pincode: string;
  serviceable: boolean;
  cod: boolean;
  prepaid: boolean;
}

/** TODO(sandbox-verify): response `{ pinCodes: [{ pinCode, serviceable,
 *  codAvailable, prepaidAvailable }] }` with 'Y'/'N' flags. */
export function parseServiceabilityResponse(body: unknown): PincodeServiceability[] {
  if (!isObj(body)) return [];
  return asArray(body.pinCodes ?? body.pincodes ?? body.Serviceability)
    .filter(isObj)
    .map((pc) => {
      const serviceableRaw = asString(pc.serviceable) ?? asString(pc.serviceability) ?? '';
      return {
        pincode: asString(pc.pinCode) ?? asString(pc.pincode) ?? '',
        serviceable: serviceableRaw.toUpperCase() === 'Y' || pc.serviceable === true,
        cod: asString(pc.codAvailable)?.toUpperCase() === 'Y' || pc.codAvailable === true,
        prepaid:
          asString(pc.prepaidAvailable)?.toUpperCase() === 'Y' || pc.prepaidAvailable === true,
      };
    });
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
 * TODO(sandbox-verify): pricing query params — origin/destination pincodes,
 * `weightKg`, `paymentType` ('Prepaid'|'COD') and the collectable amount.
 * NOTE: the adapter interface carries a serviceId UUID, not a Blue Dart
 * product code, so the product defaults to the standard domestic product
 * here; resolving the merchant's chosen Blue Dart service to a product code
 * is an integration follow-up. UNRESOLVED payment mode is rated as Prepaid
 * (never a guess upstream — the quote is indicative only until S-14 resolves
 * the mode).
 */
export function buildQuoteChargesQuery(input: QuoteChargesQueryInput): Record<string, string> {
  return {
    originPincode: input.originPincode,
    destinationPincode: input.destinationPincode,
    weightKg: input.deadWeightKg,
    paymentType: input.paymentMode === 'COD' ? 'COD' : 'Prepaid',
    collectableAmount: input.paymentMode === 'COD' ? input.collectible : '0.00',
  };
}

/** TODO(sandbox-verify): charge field names in the pricing response. Each
 *  known field becomes one §8.3 component, passed through unmarked (INV-23). */
const CHARGE_COMPONENT_MAP: ReadonlyArray<{
  key: string;
  code: string;
  label: string;
  taxable: boolean;
}> = [
  { key: 'freightCharge', code: 'BD_FREIGHT', label: 'Freight charge', taxable: true },
  { key: 'fuelSurcharge', code: 'BD_FUEL', label: 'Fuel surcharge', taxable: true },
  { key: 'codCharge', code: 'BD_COD', label: 'COD charge', taxable: true },
  { key: 'serviceTax', code: 'BD_GST', label: 'GST', taxable: false },
  { key: 'gstAmount', code: 'BD_GST', label: 'GST', taxable: false },
];

export interface ParsedQuoteCharges {
  components: QuoteComponent[];
  /** Sum of the stored rounded components (INV-15), 2dp text. */
  total: string;
  /** ISO date, when the provider returns one. */
  expectedDeliveryDate: string | null;
}

/** TODO(sandbox-verify): response `{ price: { freightCharge, fuelSurcharge,
 *  codCharge, gstAmount, totalAmount, expectedDeliveryDate } }`. The total is
 *  derived as the exact sum of the stored components (INV-15) rather than
 *  trusting a provider `totalAmount` float. */
export function parseQuoteChargesResponse(body: unknown): ParsedQuoteCharges {
  const row = isObj(body) && isObj(body.price) ? body.price : isObj(body) ? body : null;
  const components: QuoteComponent[] = [];
  let totalPaise = 0;
  if (row) {
    for (const m of CHARGE_COMPONENT_MAP) {
      if (!(m.key in row)) continue;
      const amount = providerAmountToMoney2dp(row[m.key]);
      if (amount === null) continue;
      if (components.some((c) => c.code === m.code)) continue; // e.g. serviceTax+gstAmount
      components.push({ code: m.code, label: m.label, amount, taxable: m.taxable });
      totalPaise += parseUnits(amount, 2);
    }
  }
  const eddRaw = row ? (asString(row.expectedDeliveryDate) ?? asString(row.expectedDelivery)) : null;
  const edd = eddRaw && !Number.isNaN(Date.parse(eddRaw)) ? eddRaw.slice(0, 10) : null;
  return { components, total: paiseToMoney2dp(totalPaise), expectedDeliveryDate: edd };
}

// ---------------------------------------------------------------------
// §8.2 createShipment — GenerateWayBill
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
}

/**
 * TODO(sandbox-verify): GenerateWayBill body — a `Request` block with
 * `Consignee`, `Shipper` and `Services` sub-blocks; the client reference is
 * `Services.CreditReferenceNo` (the merchant_reference of §9.5.4, keying
 * Blue Dart-side idempotency), COD cash is `Services.CollectableAmount`.
 *
 * TODO(sandbox-verify) / integration gap: `Shipper.CustomerCode` /
 * `Shipper.OriginArea` must be the merchant's registered Blue Dart pickup
 * code; the adapter receives our internal pickup_location_id and passes it
 * through — resolving the registered code is an upstream/framework concern.
 *
 * Only fields the §8.2 request actually carries are transmitted — no
 * invented fields (RV-13 protected recipient fields go at booking only).
 */
export function buildCreateShipmentBody(input: CreatePayloadInput): string {
  const address = input.recipient.addressLines;
  return JSON.stringify({
    Request: {
      Consignee: {
        ConsigneeName: input.recipient.name,
        ConsigneeAddress1: address[0] ?? '',
        ConsigneeAddress2: address[1] ?? '',
        ConsigneeAddress3: address.slice(2).join(', '),
        ConsigneeCity: input.recipient.city,
        ConsigneeState: input.recipient.state,
        ConsigneePincode: input.recipient.pincode,
        ConsigneeMobile: input.recipient.phone,
        ConsigneeEmailID: input.recipient.email ?? '',
      },
      Shipper: {
        CustomerCode: (input.registeredPickupCode || input.pickupLocationId),
        OriginArea: (input.registeredPickupCode || input.pickupLocationId),
      },
      Services: {
        CreditReferenceNo: input.merchantReference, // §9.5.4 stable merchant reference
        ProductCode: 'D', // TODO(sandbox-verify): domestic product default
        ProductType: input.paymentMode === 'COD' ? '2' : '1', // TODO(sandbox-verify)
        SubProductCode: input.paymentMode === 'COD' ? 'C' : 'P', // TODO(sandbox-verify)
        ActualWeight: input.deadWeightKg, // kg, 3dp text — exact, INV-15
        CollectableAmount: input.paymentMode === 'COD' ? input.collectible : '0.00',
        DeclaredValue: input.declaredValue,
        PieceCount: '1', // INV-4: fixed 1 at v1
      },
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

/** TODO(sandbox-verify): response
 *  `{ GenerateWayBillResult: { AWBNo, CCRCRDREF, Status: [{ StatusType,
 *  StatusInformation }] } }` — StatusType 'Error' entries are failures. */
export function parseCreateResponse(body: unknown): ParsedCreateResult {
  if (!isObj(body)) {
    return { success: false, awb: null, confirmedCharge: null, failureReasons: ['INVALID_RESPONSE'] };
  }
  const result = isObj(body.GenerateWayBillResult) ? body.GenerateWayBillResult : body;
  const statuses = asArray(result.Status).filter(isObj);
  const errors = statuses
    .filter((s) => /error/i.test(asString(s.StatusType) ?? ''))
    .map((s) => asString(s.StatusInformation) ?? asString(s.StatusMessage))
    .filter((m): m is string => m !== null);
  const awb = asString(result.AWBNo) ?? asString(result.AwbNo) ?? asString(result.awbNo);
  if (!awb || errors.length > 0) {
    return {
      success: false,
      awb: null,
      confirmedCharge: null,
      failureReasons:
        errors.length > 0
          ? errors.map((m) => providerMessageToCode(m, 'SHIPMENT_REJECTED'))
          : ['SHIPMENT_REJECTED'],
    };
  }
  const charge =
    providerAmountToMoney2dp(result.TotalAmount) ??
    providerAmountToMoney2dp(result.ChargedAmount) ??
    providerAmountToMoney2dp(result.FreightCharge);
  return { success: true, awb, confirmedCharge: charge, failureReasons: [] };
}

// ---------------------------------------------------------------------
// §8.2 lookupByReference (RW-12) + track — the tracking API
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): the tracking endpoint filters by `handl` (AWB) and
 *  by `refno` (CreditReferenceNo — the INV-5 resolution surface). */
export function buildTrackingQueryByWaybill(awb: string): Record<string, string> {
  return { handl: awb, action: 'custpublic', verno: '1', scan: '1' };
}

export function buildTrackingQueryByReference(merchantReference: string): Record<string, string> {
  return { refno: merchantReference, action: 'custpublic', verno: '1', scan: '1' };
}

export interface ParsedTrackingShipment {
  awb: string | null;
  scans: Array<{
    rawStatus: string;
    occurredAt: string | null; // ISO, null when unparseable
    locationText: string | null;
    reasonText: string | null;
  }>;
}

/** TODO(sandbox-verify): provider datetimes come as separate `ScanDate` /
 *  `ScanTime` fields ('01-Feb-2026', '1830'); best-effort parse to ISO. */
export function parseProviderDateTime(dateRaw: unknown, timeRaw?: unknown): string | null {
  const d = asString(dateRaw);
  if (!d) return null;
  const t = asString(timeRaw);
  const candidates = [t ? `${d}T${t}` : null, `${d} ${t ?? ''}`.trim(), d];
  for (const c of candidates) {
    if (!c) continue;
    const parsed = Date.parse(c);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

/** TODO(sandbox-verify):
 *  `{ ShipmentData: { Shipment: { Shipment: { AWBNo, Status, StatusDate,
 *  StatusTime, StatusLocation, Instructions }, Scans: { ScanDetail: [{
 *  Scan, ScanCode, ScanDate, ScanTime, ScannedLocation, Instructions }] } } } }`. */
export function parseTrackingResponse(body: unknown): ParsedTrackingShipment | null {
  if (!isObj(body) || !isObj(body.ShipmentData) || !isObj(body.ShipmentData.Shipment)) return null;
  const wrapper = body.ShipmentData.Shipment;
  const summary = isObj(wrapper.Shipment) ? wrapper.Shipment : wrapper;
  const scans = asArray(isObj(wrapper.Scans) ? wrapper.Scans.ScanDetail : wrapper.Scans)
    .filter(isObj)
    .map((d) => ({
      rawStatus: asString(d.Scan) ?? 'UNKNOWN',
      occurredAt: parseProviderDateTime(d.ScanDate, d.ScanTime) ?? parseProviderDateTime(d.ScanDateTime),
      locationText: asString(d.ScannedLocation),
      reasonText: asString(d.Instructions),
    }));
  // No scans but a current status: synthesize one event from Status so a
  // freshly-booked AWB still yields a polling event (§8.5 fallback).
  if (scans.length === 0) {
    const rawStatus = asString(summary.Status);
    if (rawStatus) {
      scans.push({
        rawStatus,
        occurredAt:
          parseProviderDateTime(summary.StatusDate, summary.StatusTime) ??
          parseProviderDateTime(summary.StatusDateTime),
        locationText: asString(summary.StatusLocation),
        reasonText: asString(summary.Instructions),
      });
    }
  }
  return { awb: asString(summary.AWBNo) ?? asString(summary.AWB) ?? asString(summary.AwbNo), scans };
}

// ---------------------------------------------------------------------
// §8.2 cancelShipment / schedulePickup / getLabel
// ---------------------------------------------------------------------

/** TODO(sandbox-verify): CancelWaybill body — `{ Request: { AWBNo } }`. */
export function buildCancelBody(awb: string): string {
  return JSON.stringify({ Request: { AWBNo: awb } });
}

export interface ParsedSimpleAck {
  accepted: boolean;
  reason: string | null;
  id: string | null;
}

function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 'True' || v === 1 || v === '1';
}

/** Collect 'Error'-typed Status entries out of a Blue Dart result block. */
function statusErrors(result: Record<string, unknown>): string[] {
  return asArray(result.Status)
    .filter(isObj)
    .filter((s) => /error/i.test(asString(s.StatusType) ?? ''))
    .map((s) => asString(s.StatusInformation) ?? asString(s.StatusMessage))
    .filter((m): m is string => m !== null);
}

/** TODO(sandbox-verify): cancel ack shape — best-known
 *  `{ CancelWaybillResult: { Status: [...], IsError } }`. */
export function parseCancelResponse(body: unknown): ParsedSimpleAck {
  if (!isObj(body)) return { accepted: false, reason: 'INVALID_RESPONSE', id: null };
  const result = isObj(body.CancelWaybillResult) ? body.CancelWaybillResult : body;
  const errors = statusErrors(result);
  if (errors.length === 0 && (truthy(result.success) || result.IsError === false || asArray(result.Status).length > 0)) {
    return { accepted: true, reason: null, id: null };
  }
  const reason = errors[0] ?? asString(result.message) ?? asString(result.error);
  return {
    accepted: false,
    reason: reason ? providerMessageToCode(reason, 'CANCEL_REJECTED') : 'CANCEL_REJECTED',
    id: null,
  };
}

export interface PickupBodyInput {
  pickupLocationId: string;
  /** The merchant's courier-registered pickup/customer code, from their
   *  credentials. Falls back to pickupLocationId when unset. */
  registeredPickupCode?: string;
  awbs: string[];
  /** ISO date. */
  pickupDate: string;
}

/** TODO(sandbox-verify): RegisterPickup fields — AreaCode/CustomerCode are
 *  the registered pickup code (same integration gap as create),
 *  PickupDate/PickupTime window fields, AWBNo list. */
export function buildPickupBody(input: PickupBodyInput): string {
  return JSON.stringify({
    Request: {
      CustomerCode: (input.registeredPickupCode || input.pickupLocationId),
      AreaCode: (input.registeredPickupCode || input.pickupLocationId),
      PickupDate: input.pickupDate,
      PickupTime: '1000', // TODO(sandbox-verify): required window field (HHmm)
      AWBNo: input.awbs,
      NoOfPieces: input.awbs.length,
    },
  });
}

/** TODO(sandbox-verify): pickup ack shape —
 *  `{ RegisterPickupResult: { ConfirmationNo, TokenNumber, Status: [...] } }`. */
export function parsePickupResponse(body: unknown): ParsedSimpleAck {
  if (!isObj(body)) return { accepted: false, reason: 'INVALID_RESPONSE', id: null };
  const result = isObj(body.RegisterPickupResult) ? body.RegisterPickupResult : body;
  const id = asString(result.ConfirmationNo) ?? asString(result.TokenNumber) ?? asString(result.PickupId);
  const errors = statusErrors(result);
  if (id || (errors.length === 0 && truthy(result.success))) {
    return { accepted: true, reason: null, id };
  }
  const reason = errors[0] ?? asString(result.message) ?? asString(result.error);
  return {
    accepted: false,
    reason: reason ? providerMessageToCode(reason, 'PICKUP_REJECTED') : 'PICKUP_REJECTED',
    id: null,
  };
}

/** TODO(sandbox-verify): label print params (`AWBNo`). Response is raw PDF
 *  bytes; some Blue Dart print endpoints return base64 JSON instead — the
 *  sandbox pass must confirm. */
export function buildLabelQuery(awb: string): Record<string, string> {
  return { AWBNo: awb };
}
