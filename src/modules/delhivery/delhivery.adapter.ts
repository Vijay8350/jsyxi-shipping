import {
  AdapterFactory,
  AdapterBuildContext,
} from '../courier-framework/adapter-registry';
import type {
  AdapterMethod,
  CancelShipmentResult,
  CourierAdapter,
  CreateShipmentRequest,
  CreateShipmentResult,
  LabelResult,
  LookupByReferenceResult,
  NdrActionRequest,
  NdrActionResult,
  PickupRequest,
  PickupResult,
  QuoteRequest,
  QuoteResponse,
  TrackEvent,
} from '../courier-framework/adapter.types';
import {
  AdapterRateLimitError,
  AdapterTimeoutError,
  CourierAuthError,
  CourierProviderError,
} from '../courier-framework/adapter-errors';
import type { CourierAccountMode } from '../courier-framework/vault.service';
import {
  DELHIVERY_AUTH_SCHEME,
  DELHIVERY_BASE_URLS,
  DELHIVERY_COURIER_CODE,
  DELHIVERY_ENDPOINTS,
  EndpointSpec,
  SERVICEABILITY_FAILURE_CODES,
  buildCancelBody,
  buildCreateShipmentBody,
  buildNdrActionBody,
  buildPackingSlipQuery,
  buildPickupBody,
  buildQuoteChargesQuery,
  buildServiceabilityQuery,
  buildTrackingQueryByReference,
  buildTrackingQueryByWaybill,
  buildWaybillBulkQuery,
  parseCancelResponse,
  parseCreateResponse,
  parseNdrActionResponse,
  parsePickupResponse,
  parseProviderErrorCode,
  parseQuoteChargesResponse,
  parseRetryAfterMs,
  parseServiceabilityResponse,
  parseTrackingResponse,
  parseWaybillBulkResponse,
} from './delhivery-api.map';

/**
 * Delhivery adapter (§8.2, §9.3.4) — a DIRECT courier reached on the
 * merchant's own credentials (BYOC, INV-23): quoted prices pass through
 * unmarked. One instance per courier_account build context
 * (courier_account_id + mode + credentials version, RW-20).
 *
 * Transport policy (§8.2):
 * - 401/403 → CourierAuthError (→ DISCONNECTED, §3.21)
 * - 429 → AdapterRateLimitError (back-pressure, not provider failure)
 * - AbortSignal timeout → AdapterTimeoutError; on createShipment it is
 *   CONVERTED to {kind:'OUTCOME_UNKNOWN'} (§9.5.4, INV-5) and never
 *   retried blindly — lookupByReference resolves it (RW-12).
 * - other non-2xx → CourierProviderError with a structured code parsed
 *   from the provider body (codes/IDs only — never secrets or PII, INV-18).
 *
 * Idempotent create (A1-04, INV-5): Delhivery's CMU create is keyed by the
 * client order reference (`order` = intent.merchantReference); additionally
 * this adapter deduplicates per bookingIntentId in-process, so a transport
 * retry of the same intent NEVER issues a second create and always returns
 * the original outcome (including a cached OUTCOME_UNKNOWN — resolution
 * belongs to lookupByReference, not to a blind retry, §9.5.4).
 *
 * Every endpoint URL, request and response mapping lives in
 * delhivery-api.map.ts with TODO(sandbox-verify) markers; this file should
 * not need to change on a sandbox pass.
 */

export interface DelhiveryAdapterOptions {
  courierAccountId: string;
  /** Merchant's courier-registered pickup/customer code (optional). */
  pickupCode?: string;
  courierCode?: string;
  mode: CourierAccountMode;
  /** Plaintext api_token, confined to this instance (§5.7 control 1,
   *  INV-18): never logged, never re-emitted in errors. */
  apiToken: string;
  now: () => Date;
  /** Test hook: injectable fetch; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Test hook: override the mode-derived base URL. */
  baseUrlOverride?: string;
}

export interface DelhiveryCallRecord {
  method: AdapterMethod;
  at: string;
  bookingIntentId?: string;
  merchantReference?: string;
  awb?: string;
  /** A1-04: a retry of an already-recorded intent — no second create. */
  deduplicated?: boolean;
}

export class DelhiveryAdapter implements CourierAdapter {
  readonly courierCode: string;
  /** §15.1 optional surface: Delhivery implements all 8 §8.2 methods. */
  readonly unsupportedMethods: AdapterMethod[] = [];
  /** §15.1 optional surface: lets the contract suite assert A1-04. */
  readonly requestLog: DelhiveryCallRecord[] = [];

  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly now: () => Date;
  private readonly pickupCode?: string;
  private readonly fetchFn: typeof fetch;
  /** INV-5: intent → the outcome of the one create issued for it. */
  private readonly createsByIntent = new Map<string, CreateShipmentResult>();

  constructor(options: DelhiveryAdapterOptions) {
    this.courierCode = options.courierCode ?? DELHIVERY_COURIER_CODE;
    this.baseUrl =
      options.baseUrlOverride ?? DELHIVERY_BASE_URLS[options.mode] ?? DELHIVERY_BASE_URLS.LIVE;
    this.apiToken = options.apiToken;
    this.now = options.now;
    this.pickupCode = options.pickupCode;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  // ------------------------------------------------------------------
  // transport core
  // ------------------------------------------------------------------

  private log(rec: DelhiveryCallRecord): void {
    this.requestLog.push(rec);
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `${DELHIVERY_AUTH_SCHEME} ${this.apiToken}` };
  }

  /** One HTTP call with the §8.2 error classification. `responseType`
   *  'bytes' is for the label PDF; everything else is JSON. */
  private async call(
    method: AdapterMethod,
    endpoint: EndpointSpec,
    init: { query?: Record<string, string>; body?: string; accept?: string },
    responseType: 'json' | 'bytes' = 'json',
  ): Promise<unknown> {
    const url = new URL(endpoint.path, this.baseUrl);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      url.searchParams.set(k, v);
    }
    const headers: Record<string, string> = this.authHeaders();
    if (endpoint.contentType) headers['Content-Type'] = endpoint.contentType;
    if (init.accept) headers.Accept = init.accept;

    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), {
        method: endpoint.method,
        headers,
        body: init.body,
        signal: AbortSignal.timeout(endpoint.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new AdapterTimeoutError(this.courierCode, method);
      }
      // DNS/TLS/connection failures: provider-side from our perspective.
      throw new CourierProviderError(this.courierCode, 'TRANSPORT_ERROR');
    }

    if (res.status === 401 || res.status === 403) {
      throw new CourierAuthError(this.courierCode);
    }
    if (res.status === 429) {
      throw new AdapterRateLimitError(
        this.courierCode,
        parseRetryAfterMs(res.headers.get('retry-after')),
      );
    }
    if (!res.ok) {
      const body = await this.safeParseBody(res);
      throw new CourierProviderError(
        this.courierCode,
        parseProviderErrorCode(body, res.status),
      );
    }
    if (responseType === 'bytes') {
      return Buffer.from(await res.arrayBuffer());
    }
    return this.safeParseBody(res);
  }

  private async safeParseBody(res: Response): Promise<unknown> {
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  // ------------------------------------------------------------------
  // §8.2 getQuote (§8.3)
  // ------------------------------------------------------------------

  async getQuote(request: QuoteRequest): Promise<QuoteResponse> {
    this.log({ method: 'getQuote', at: this.now().toISOString() });
    const fetchedAt = this.now().toISOString();

    // Serviceability first (origin + destination + COD flag).
    const svcBody = await this.call('getQuote', DELHIVERY_ENDPOINTS.serviceability, {
      query: buildServiceabilityQuery([request.originPincode, request.destinationPincode]),
    });
    const pins = parseServiceabilityResponse(svcBody);
    const failureReasons: string[] = [];
    const origin = pins.find((p) => p.pincode === request.originPincode);
    const destination = pins.find((p) => p.pincode === request.destinationPincode);
    if (!origin?.serviceable) failureReasons.push(SERVICEABILITY_FAILURE_CODES.ORIGIN_NOT_SERVICEABLE);
    if (!destination?.serviceable) {
      failureReasons.push(SERVICEABILITY_FAILURE_CODES.DESTINATION_NOT_SERVICEABLE);
    } else if (request.paymentMode === 'COD' && !destination.cod) {
      failureReasons.push(SERVICEABILITY_FAILURE_CODES.COD_NOT_SERVICEABLE);
    }

    const capabilityFlags: string[] = [];
    if (destination?.prepaid) capabilityFlags.push('PREPAID');
    if (destination?.cod) capabilityFlags.push('COD');

    if (failureReasons.length > 0) {
      return {
        serviceable: false,
        failureReasons,
        rateAvailable: false,
        components: [],
        total: '0.00',
        currency: 'INR',
        rtoRule: null,
        eddFrom: null,
        eddTo: null,
        eddSource: null,
        fetchedAt,
        providerQuoteRef: null,
        capabilityFlags,
      };
    }

    const quoteBody = await this.call('getQuote', DELHIVERY_ENDPOINTS.quoteCharges, {
      query: buildQuoteChargesQuery({
        originPincode: request.originPincode,
        destinationPincode: request.destinationPincode,
        deadWeightKg: request.deadWeightKg,
        paymentMode: request.paymentMode,
        collectible: request.collectible,
      }),
    });
    const charges = parseQuoteChargesResponse(quoteBody);
    const rateAvailable = charges.components.length > 0;
    return {
      serviceable: true,
      failureReasons: [],
      rateAvailable,
      components: charges.components,
      total: charges.total,
      currency: 'INR',
      // Delhivery rates RTO as a charge component, not a return-charge
      // term — null = no provider RTO expectation; F-12 owns the rest (§4.4).
      rtoRule: null,
      eddFrom: null,
      eddTo: charges.expectedDeliveryDate,
      eddSource: charges.expectedDeliveryDate ? 'PROVIDER' : null,
      fetchedAt,
      providerQuoteRef: null, // kinko returns no quote reference (TODO(sandbox-verify))
      capabilityFlags,
    };
  }

  // ------------------------------------------------------------------
  // §8.2 createShipment — exactly-once (A1-04, INV-5, §9.5.4)
  // ------------------------------------------------------------------

  async createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResult> {
    const { intent } = request;

    // A1-04 / INV-5: a retry of an already-recorded intent returns the SAME
    // outcome; no second create is issued. A cached OUTCOME_UNKNOWN is
    // returned as-is — §9.5.4 resolves it via lookupByReference, never via
    // a blind second create.
    const existing = this.createsByIntent.get(intent.bookingIntentId);
    if (existing) {
      this.log({
        method: 'createShipment',
        at: this.now().toISOString(),
        bookingIntentId: intent.bookingIntentId,
        merchantReference: intent.merchantReference,
        awb: existing.awb ?? undefined,
        deduplicated: true,
      });
      return existing;
    }

    this.log({
      method: 'createShipment',
      at: this.now().toISOString(),
      bookingIntentId: intent.bookingIntentId,
      merchantReference: intent.merchantReference,
    });

    let outcome: CreateShipmentResult;
    try {
      // 1) fetch a waybill, 2) create keyed by the client reference.
      const waybillBody = await this.call(
        'createShipment',
        DELHIVERY_ENDPOINTS.waybillBulk,
        { query: buildWaybillBulkQuery(1) },
      );
      const waybill = parseWaybillBulkResponse(waybillBody);
      if (!waybill) {
        outcome = { kind: 'FAILED', awb: null, confirmedCharge: null, failureReasons: ['NO_WAYBILL_AVAILABLE'] };
        this.createsByIntent.set(intent.bookingIntentId, outcome);
        return outcome;
      }

      const createBody = await this.call('createShipment', DELHIVERY_ENDPOINTS.createShipment, {
        query: { format: 'json' },
        body: buildCreateShipmentBody({
          waybill,
          merchantReference: intent.merchantReference,
          pickupLocationId: request.pickupLocationId,
          registeredPickupCode: this.pickupCode,
          recipient: request.recipient,
          paymentMode: request.paymentMode,
          collectible: request.collectible,
          deadWeightKg: request.deadWeightKg,
        }),
      });
      const parsed = parseCreateResponse(createBody);
      outcome = parsed.success
        ? {
            kind: 'CONFIRMED',
            awb: parsed.awb,
            // §3.25: PROVIDER_CONFIRMED_CHARGE when the provider returns one.
            confirmedCharge: parsed.confirmedCharge,
            failureReasons: [],
          }
        : { kind: 'FAILED', awb: null, confirmedCharge: null, failureReasons: parsed.failureReasons };
    } catch (err) {
      if (err instanceof AdapterTimeoutError) {
        // §9.5.4 / INV-5: a create timeout is OUTCOME_UNKNOWN and is NEVER
        // retried — lookupByReference resolves it.
        outcome = { kind: 'OUTCOME_UNKNOWN', awb: null, confirmedCharge: null, failureReasons: [] };
      } else if (err instanceof CourierProviderError) {
        outcome = { kind: 'FAILED', awb: null, confirmedCharge: null, failureReasons: [err.code] };
      } else {
        // Auth/rate-limit propagate to the transport policy unchanged.
        throw err;
      }
    }
    this.createsByIntent.set(intent.bookingIntentId, outcome);
    return outcome;
  }

  // ------------------------------------------------------------------
  // §8.2 lookupByReference (RW-12) — resolves OUTCOME_UNKNOWN creates
  // ------------------------------------------------------------------

  async lookupByReference(merchantReference: string): Promise<LookupByReferenceResult> {
    this.log({
      method: 'lookupByReference',
      at: this.now().toISOString(),
      merchantReference,
    });
    const body = await this.call('lookupByReference', DELHIVERY_ENDPOINTS.tracking, {
      query: buildTrackingQueryByReference(merchantReference),
    });
    const parsed = parseTrackingResponse(body);
    return parsed?.awb ? { found: true, awb: parsed.awb } : { found: false, awb: null };
  }

  // ------------------------------------------------------------------
  // §8.2 cancelShipment
  // ------------------------------------------------------------------

  async cancelShipment(awb: string): Promise<CancelShipmentResult> {
    this.log({ method: 'cancelShipment', at: this.now().toISOString(), awb });
    try {
      const body = await this.call('cancelShipment', DELHIVERY_ENDPOINTS.cancel, {
        body: buildCancelBody(awb),
      });
      const parsed = parseCancelResponse(body);
      return parsed.accepted
        ? { kind: 'CANCELLED', reason: null }
        : { kind: 'REJECTED', reason: parsed.reason ?? 'CANCEL_REJECTED' };
    } catch (err) {
      if (err instanceof AdapterTimeoutError) {
        // Same exactly-once discipline as create (§9.5.4): no blind retry.
        return { kind: 'OUTCOME_UNKNOWN', reason: null };
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------
  // §8.2 track (§8.5 polling fallback)
  // ------------------------------------------------------------------

  async track(awb: string): Promise<TrackEvent[]> {
    this.log({ method: 'track', at: this.now().toISOString(), awb });
    const body = await this.call('track', DELHIVERY_ENDPOINTS.tracking, {
      query: buildTrackingQueryByWaybill(awb),
    });
    const parsed = parseTrackingResponse(body);
    if (!parsed) {
      throw new CourierProviderError(this.courierCode, 'AWB_NOT_FOUND');
    }
    // Raw status text passes through; normalization happens against
    // courier_status_map (§3.6), not in the adapter (A2-06).
    return parsed.scans.map((scan) => ({
      rawStatus: scan.rawStatus,
      occurredAt: scan.occurredAt ?? this.now().toISOString(),
      locationText: scan.locationText,
      reasonText: scan.reasonText,
      // Delhivery scans carry no provider event ID (TODO(sandbox-verify));
      // §8.5 dedupe falls back to the canonical fingerprint.
      providerEventId: null,
    }));
  }

  // ------------------------------------------------------------------
  // §8.2 getLabel — courier PDF (label_mode CUSTOM_ALLOWED, §9.9.1:
  // Delhivery allows custom labels; the courier PDF is still offered here)
  // ------------------------------------------------------------------

  async getLabel(awb: string, format: 'PDF'): Promise<LabelResult> {
    this.log({ method: 'getLabel', at: this.now().toISOString(), awb });
    if (format !== 'PDF') {
      throw new CourierProviderError(this.courierCode, 'FORMAT_UNSUPPORTED');
    }
    const bytes = (await this.call(
      'getLabel',
      DELHIVERY_ENDPOINTS.packingSlip,
      { query: buildPackingSlipQuery(awb), accept: 'application/pdf' },
      'bytes',
    )) as Buffer;
    return { contentType: 'application/pdf', bytes };
  }

  // ------------------------------------------------------------------
  // §8.2 schedulePickup
  // ------------------------------------------------------------------

  async schedulePickup(request: PickupRequest): Promise<PickupResult> {
    this.log({ method: 'schedulePickup', at: this.now().toISOString() });
    if (request.awbs.length === 0) {
      throw new CourierProviderError(this.courierCode, 'NO_AWBS');
    }
    const body = await this.call('schedulePickup', DELHIVERY_ENDPOINTS.pickup, {
      body: buildPickupBody({
        pickupLocationId: request.pickupLocationId,
          registeredPickupCode: this.pickupCode,
        pickupDate: request.pickupDate,
        packageCount: request.awbs.length,
      }),
    });
    const parsed = parsePickupResponse(body);
    if (!parsed.accepted) {
      throw new CourierProviderError(this.courierCode, parsed.reason ?? 'PICKUP_REJECTED');
    }
    return { acknowledged: true, providerPickupId: parsed.id };
  }

  // ------------------------------------------------------------------
  // §8.2 ndrAction
  // ------------------------------------------------------------------

  async ndrAction(request: NdrActionRequest): Promise<NdrActionResult> {
    this.log({ method: 'ndrAction', at: this.now().toISOString(), awb: request.awb });
    const body = await this.call('ndrAction', DELHIVERY_ENDPOINTS.ndrAction, {
      body: buildNdrActionBody(request),
    });
    const parsed = parseNdrActionResponse(body);
    return { accepted: parsed.accepted, providerAck: parsed.id ?? parsed.reason };
  }
}

/**
 * AdapterFactory for the registry (§9.3.4). Reads the KEY_PASTE credential
 * (`api_token`), picks the base URL by mode (TEST → staging, LIVE →
 * production). The plaintext token is captured inside the instance and
 * never logged or re-emitted (§5.7 control 1, INV-18).
 */
export const delhiveryAdapterFactory: AdapterFactory = (ctx: AdapterBuildContext) => {
  const apiToken = ctx.credentials.api_token;
  if (typeof apiToken !== 'string' || apiToken.length === 0) {
    // Names the missing field, never a value (INV-18).
    throw new CourierAuthError(ctx.courierCode, `${ctx.courierCode}: missing credential api_token`);
  }
  return new DelhiveryAdapter({
    courierAccountId: ctx.courierAccountId,
      pickupCode:
        typeof ctx.credentials.pickup_code === 'string' && ctx.credentials.pickup_code
          ? ctx.credentials.pickup_code
          : undefined,
    courierCode: ctx.courierCode,
    mode: ctx.mode,
    apiToken,
    now: ctx.now,
  });
};
