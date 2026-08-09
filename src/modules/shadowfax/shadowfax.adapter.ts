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
import { UnsupportedCapabilityError } from '../courier-framework/adapter.types';
import {
  AdapterRateLimitError,
  AdapterTimeoutError,
  CourierAuthError,
  CourierProviderError,
} from '../courier-framework/adapter-errors';
import type { CourierAccountMode } from '../courier-framework/vault.service';
import {
  EndpointSpec,
  SHADOWFAX_AUTH_SCHEME,
  SHADOWFAX_BASE_URLS,
  SHADOWFAX_COURIER_CODE,
  SHADOWFAX_ENDPOINTS,
  buildCancelBody,
  buildCreateShipmentBody,
  buildLabelQuery,
  buildNdrActionBody,
  buildPickupBody,
  buildTrackingQueryByAwb,
  buildTrackingQueryByReference,
  parseCreateResponse,
  parseProviderErrorCode,
  parseRetryAfterMs,
  parseSimpleAckResponse,
  parseTrackingResponse,
} from './shadowfax-api.map';

/**
 * Shadowfax adapter (§8.2, §9.3.4) — a DIRECT courier reached on the
 * merchant's own credentials (BYOC, INV-23). One instance per
 * courier_account build context (courier_account_id + mode + credentials
 * version, RW-20).
 *
 * Auth is KEY_PASTE (§9.3.3): one static secret (`api_key`) sent as
 * `Authorization: Token <api_key>` on every call. There is no token
 * exchange and no refresh path; a 401/403 means the pasted key is invalid
 * and surfaces CourierAuthError → the §3.21 health transition
 * (DISCONNECTED) and the courier-disconnected alert (§9.21).
 *
 * Transport policy (§8.2):
 * - 401/403 → CourierAuthError
 * - 429 → AdapterRateLimitError (back-pressure, not provider failure)
 * - AbortSignal timeout → AdapterTimeoutError; on createShipment it is
 *   CONVERTED to {kind:'OUTCOME_UNKNOWN'} (§9.5.4, INV-5) and never
 *   retried blindly — lookupByReference resolves it (RW-12).
 * - other non-2xx → CourierProviderError with a structured code parsed
 *   from the provider body (codes/IDs only — never secrets or PII, INV-18).
 *
 * Idempotent create (A1-04, INV-5): Shadowfax's create is keyed by the
 * client order reference (`client_order_id` = intent.merchantReference);
 * additionally this adapter deduplicates per bookingIntentId in-process,
 * so a transport retry of the same intent NEVER issues a second create and
 * always returns the original outcome (including a cached OUTCOME_UNKNOWN —
 * resolution belongs to lookupByReference, not to a blind retry, §9.5.4).
 *
 * getQuote is DECLARED UNSUPPORTED (A1-03): Shadowfax rate APIs are
 * contract-specific with no stable public shape, and Shadowfax Services
 * are cost_source = RATE_CARD (§3.7) — the §4.5 cost engine synthesizes
 * the §8.3 quote from the merchant's rate card, including lane
 * serviceability. Never a silent no-op.
 *
 * Every endpoint URL, request and response mapping lives in
 * shadowfax-api.map.ts with TODO(sandbox-verify) markers; this file should
 * not need to change on a sandbox pass.
 */

/** A1-03: the manual fallback shown wherever getQuote is disabled (mirrors
 *  SHADOWFAX_GETQUOTE_FALLBACK_NOTE in the seed). */
const GETQUOTE_FALLBACK_NOTE =
  'Shadowfax rate APIs are contract-specific and not mapped at v1; priced from the merchant rate card (RATE_CARD, §3.7) — the cost engine synthesizes the quote and lane serviceability (§4.5).';

export interface ShadowfaxAdapterOptions {
  courierAccountId: string;
  /** Merchant's courier-registered pickup/customer code (optional). */
  pickupCode?: string;
  courierCode?: string;
  mode: CourierAccountMode;
  /** Plaintext api_key, confined to this instance (§5.7 control 1,
   *  INV-18): never logged, never re-emitted in errors. */
  apiKey: string;
  now: () => Date;
  /** Test hook: injectable fetch; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Test hook: override the mode-derived base URL. */
  baseUrlOverride?: string;
}

export interface ShadowfaxCallRecord {
  method: AdapterMethod;
  at: string;
  bookingIntentId?: string;
  merchantReference?: string;
  awb?: string;
  /** A1-04: a retry of an already-recorded intent — no second create. */
  deduplicated?: boolean;
}

export class ShadowfaxAdapter implements CourierAdapter {
  readonly courierCode: string;
  /** §15.1 optional surface: getQuote is declared unsupported (A1-03) —
   *  RATE_CARD Services are priced by the §4.5 cost engine. */
  readonly unsupportedMethods: AdapterMethod[] = ['getQuote'];
  /** §15.1 optional surface: lets the contract suite assert A1-04. */
  readonly requestLog: ShadowfaxCallRecord[] = [];

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly now: () => Date;
  private readonly pickupCode?: string;
  private readonly fetchFn: typeof fetch;
  /** INV-5: intent → the outcome of the one create issued for it. */
  private readonly createsByIntent = new Map<string, CreateShipmentResult>();

  constructor(options: ShadowfaxAdapterOptions) {
    this.courierCode = options.courierCode ?? SHADOWFAX_COURIER_CODE;
    this.baseUrl =
      options.baseUrlOverride ?? SHADOWFAX_BASE_URLS[options.mode] ?? SHADOWFAX_BASE_URLS.LIVE;
    this.apiKey = options.apiKey;
    this.now = options.now;
    this.pickupCode = options.pickupCode;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  // ------------------------------------------------------------------
  // transport core
  // ------------------------------------------------------------------

  private log(rec: ShadowfaxCallRecord): void {
    this.requestLog.push(rec);
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `${SHADOWFAX_AUTH_SCHEME} ${this.apiKey}` };
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
  // §8.2 getQuote — DECLARED UNSUPPORTED (A1-03). Shadowfax rate APIs are
  // contract-specific; the Services are cost_source = RATE_CARD (§3.7) and
  // the §4.5 cost engine synthesizes the §8.3 quote from the merchant's
  // rate card, including lane serviceability. Never a silent no-op.
  // ------------------------------------------------------------------

  async getQuote(_request: QuoteRequest): Promise<QuoteResponse> {
    this.log({ method: 'getQuote', at: this.now().toISOString() });
    throw new UnsupportedCapabilityError(this.courierCode, 'getQuote', GETQUOTE_FALLBACK_NOTE);
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
      const createBody = await this.call('createShipment', SHADOWFAX_ENDPOINTS.createShipment, {
        body: buildCreateShipmentBody({
          merchantReference: intent.merchantReference,
          pickupLocationId: request.pickupLocationId,
          registeredPickupCode: this.pickupCode,
          recipient: request.recipient,
          paymentMode: request.paymentMode,
          collectible: request.collectible,
          deadWeightKg: request.deadWeightKg,
          lengthCm: request.lengthCm,
          widthCm: request.widthCm,
          heightCm: request.heightCm,
          declaredValue: request.declaredValue,
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
    const body = await this.call('lookupByReference', SHADOWFAX_ENDPOINTS.tracking, {
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
      const body = await this.call('cancelShipment', SHADOWFAX_ENDPOINTS.cancel, {
        body: buildCancelBody(awb),
      });
      const parsed = parseSimpleAckResponse(body, 'CANCEL_REJECTED');
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
    const body = await this.call('track', SHADOWFAX_ENDPOINTS.tracking, {
      query: buildTrackingQueryByAwb(awb),
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
      // TODO(sandbox-verify): Shadowfax scans carry no documented provider
      // event ID; §8.5 dedupe falls back to the canonical fingerprint.
      providerEventId: null,
    }));
  }

  // ------------------------------------------------------------------
  // §8.2 getLabel — courier PDF (label_mode CUSTOM_ALLOWED, §9.9.1:
  // Shadowfax allows custom labels; the courier PDF is still offered here)
  // ------------------------------------------------------------------

  async getLabel(awb: string, format: 'PDF'): Promise<LabelResult> {
    this.log({ method: 'getLabel', at: this.now().toISOString(), awb });
    if (format !== 'PDF') {
      throw new CourierProviderError(this.courierCode, 'FORMAT_UNSUPPORTED');
    }
    const bytes = (await this.call(
      'getLabel',
      SHADOWFAX_ENDPOINTS.label,
      { query: buildLabelQuery(awb), accept: 'application/pdf' },
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
    const body = await this.call('schedulePickup', SHADOWFAX_ENDPOINTS.pickup, {
      body: buildPickupBody({
        awbs: request.awbs,
        pickupLocationId: request.pickupLocationId,
          registeredPickupCode: this.pickupCode,
        pickupDate: request.pickupDate,
      }),
    });
    const parsed = parseSimpleAckResponse(body, 'PICKUP_REJECTED');
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
    const body = await this.call('ndrAction', SHADOWFAX_ENDPOINTS.ndrAction, {
      body: buildNdrActionBody(request),
    });
    const parsed = parseSimpleAckResponse(body, 'NDR_REJECTED');
    return { accepted: parsed.accepted, providerAck: parsed.id ?? parsed.reason };
  }
}

/**
 * AdapterFactory for the registry (§9.3.4). Reads the KEY_PASTE credential
 * (`api_key`) and picks the base URL by mode. The plaintext key is captured
 * inside the instance and never logged or re-emitted (§5.7 control 1,
 * INV-18).
 */
export const shadowfaxAdapterFactory: AdapterFactory = (ctx: AdapterBuildContext) => {
  const apiKey = ctx.credentials.api_key;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    // Names the missing field, never a value (INV-18).
    throw new CourierAuthError(ctx.courierCode, `${ctx.courierCode}: missing credential api_key`);
  }
  return new ShadowfaxAdapter({
    courierAccountId: ctx.courierAccountId,
      pickupCode:
        typeof ctx.credentials.pickup_code === 'string' && ctx.credentials.pickup_code
          ? ctx.credentials.pickup_code
          : undefined,
    courierCode: ctx.courierCode,
    mode: ctx.mode,
    apiKey,
    now: ctx.now,
  });
};
