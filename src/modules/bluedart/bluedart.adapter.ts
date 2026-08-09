import {
  AdapterFactory,
  AdapterBuildContext,
} from '../courier-framework/adapter-registry';
import {
  UnsupportedCapabilityError,
  type AdapterMethod,
  type CancelShipmentResult,
  type CourierAdapter,
  type CreateShipmentRequest,
  type CreateShipmentResult,
  type LabelResult,
  type LookupByReferenceResult,
  type NdrActionRequest,
  type NdrActionResult,
  type PickupRequest,
  type PickupResult,
  type QuoteRequest,
  type QuoteResponse,
  type TrackEvent,
} from '../courier-framework/adapter.types';
import {
  AdapterRateLimitError,
  AdapterTimeoutError,
  CourierAuthError,
  CourierProviderError,
} from '../courier-framework/adapter-errors';
import type { CourierAccountMode } from '../courier-framework/vault.service';
import {
  BLUEDART_AUTH_SCHEME,
  BLUEDART_BASE_URLS,
  BLUEDART_COURIER_CODE,
  BLUEDART_ENDPOINTS,
  BLUEDART_NDR_FALLBACK_NOTE,
  EndpointSpec,
  SERVICEABILITY_FAILURE_CODES,
  buildCancelBody,
  buildCreateShipmentBody,
  buildLabelQuery,
  buildLoginBody,
  buildPickupBody,
  buildQuoteChargesQuery,
  buildServiceabilityQuery,
  buildTrackingQueryByReference,
  buildTrackingQueryByWaybill,
  parseCancelResponse,
  parseCreateResponse,
  parseLoginResponse,
  parsePickupResponse,
  parseProviderErrorCode,
  parseQuoteChargesResponse,
  parseRetryAfterMs,
  parseServiceabilityResponse,
  parseTrackingResponse,
} from './bluedart-api.map';

/**
 * Blue Dart adapter (§8.2, §9.3.4) — a DIRECT courier reached on the
 * merchant's own credentials (BYOC, INV-23): quoted prices pass through
 * unmarked. One instance per courier_account build context
 * (courier_account_id + mode + credentials version, RW-20).
 *
 * Auth: KEY_PASTE client_id + client_secret are exchanged for a JWT at the
 * login endpoint. The token is cached in Redis (via BluedartTokenCache)
 * keyed per courier account + mode, with a TTL derived from the provider's
 * expires_in minus a safety skew; a 401 invalidates the cache, re-logs in
 * and retries the call once — a login failure throws CourierAuthError
 * (→ DISCONNECTED, §3.21).
 *
 * Transport policy (§8.2):
 * - 401/403 (after the single refresh-retry) → CourierAuthError
 * - 429 → AdapterRateLimitError (back-pressure, not provider failure)
 * - AbortSignal timeout → AdapterTimeoutError; on createShipment it is
 *   CONVERTED to {kind:'OUTCOME_UNKNOWN'} (§9.5.4, INV-5) and never
 *   retried blindly — lookupByReference resolves it (RW-12).
 * - other non-2xx → CourierProviderError with a structured code parsed
 *   from the provider body (codes/IDs only — never secrets or PII, INV-18).
 *
 * Idempotent create (A1-04, INV-5): Blue Dart's GenerateWayBill carries the
 * client reference (Services.CreditReferenceNo = intent.merchantReference);
 * additionally this adapter deduplicates per bookingIntentId in-process, so
 * a transport retry of the same intent NEVER issues a second create and
 * always returns the original outcome (including a cached OUTCOME_UNKNOWN —
 * resolution belongs to lookupByReference, not to a blind retry, §9.5.4).
 *
 * Every endpoint URL, request and response mapping lives in
 * bluedart-api.map.ts with TODO(sandbox-verify) markers; this file should
 * not need to change on a sandbox pass.
 */

/** Token cache abstraction over Redis (kept minimal so tests can inject an
 *  in-memory store). Values are JWTs, keyed per account+mode by the adapter. */
export interface BluedartTokenCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** An in-memory cache for tests; production wiring is Redis (module file). */
export function createInMemoryTokenCache(): BluedartTokenCache {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key) {
      const row = store.get(key);
      if (!row) return null;
      if (row.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return row.value;
    },
    async set(key, value, ttlSeconds) {
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async del(key) {
      store.delete(key);
    },
  };
}

export interface BluedartAdapterOptions {
  courierAccountId: string;
  courierCode?: string;
  mode: CourierAccountMode;
  /** Plaintext client_id/client_secret, confined to this instance (§5.7
   *  control 1, INV-18): never logged, never re-emitted in errors. */
  clientId: string;
  clientSecret: string;
  /** Redis-backed token cache (production) or an in-memory one (tests). */
  tokenCache: BluedartTokenCache;
  now: () => Date;
  /** Test hook: injectable fetch; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Test hook: override the mode-derived base URL. */
  baseUrlOverride?: string;
}

export interface BluedartCallRecord {
  method: AdapterMethod;
  at: string;
  bookingIntentId?: string;
  merchantReference?: string;
  awb?: string;
  /** A1-04: a retry of an already-recorded intent — no second create. */
  deduplicated?: boolean;
}

/** Safety skew subtracted from the provider's expires_in so a token is never
 *  used in its last minute (TODO(sandbox-verify): real token lifetime). */
const TOKEN_EXPIRY_SKEW_SECONDS = 60;
/** Fallback TTL when the login response carries no expires_in. */
const TOKEN_DEFAULT_TTL_SECONDS = 3_300;

export class BluedartAdapter implements CourierAdapter {
  readonly courierCode: string;
  /** §15.1 optional surface: A1-03 — Blue Dart's NDR APIs are inconsistent,
   *  so ndrAction is declared unsupported with a manual fallback. */
  readonly unsupportedMethods: AdapterMethod[] = ['ndrAction'];
  /** §15.1 optional surface: lets the contract suite assert A1-04. */
  readonly requestLog: BluedartCallRecord[] = [];

  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tokenCache: BluedartTokenCache;
  private readonly tokenCacheKey: string;
  private readonly now: () => Date;
  private readonly fetchFn: typeof fetch;
  /** INV-5: intent → the outcome of the one create issued for it. */
  private readonly createsByIntent = new Map<string, CreateShipmentResult>();
  /** Serializes concurrent token refreshes within this instance. */
  private refreshing: Promise<string> | null = null;

  constructor(options: BluedartAdapterOptions) {
    this.courierCode = options.courierCode ?? BLUEDART_COURIER_CODE;
    this.baseUrl =
      options.baseUrlOverride ?? BLUEDART_BASE_URLS[options.mode] ?? BLUEDART_BASE_URLS.LIVE;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.tokenCache = options.tokenCache;
    this.tokenCacheKey = `bluedart:token:${options.courierAccountId}:${options.mode}`;
    this.now = options.now;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  // ------------------------------------------------------------------
  // auth — JWT login, Redis-cached, refreshed on 401
  // ------------------------------------------------------------------

  /**
   * Returns a usable JWT: the cached one, else a fresh login. A login
   * failure throws CourierAuthError (→ DISCONNECTED, §3.21); the error names
   * no credential values (INV-18).
   */
  private async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      const cached = await this.tokenCache.get(this.tokenCacheKey);
      if (cached) return cached;
    }
    // Coalesce concurrent refreshes so a burst of expired calls logs in once.
    this.refreshing ??= this.login().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async login(): Promise<string> {
    const endpoint = BLUEDART_ENDPOINTS.login;
    const url = new URL(endpoint.path, this.baseUrl);
    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), {
        method: endpoint.method,
        headers: { 'Content-Type': endpoint.contentType ?? 'application/json' },
        body: buildLoginBody(this.clientId, this.clientSecret),
        signal: AbortSignal.timeout(endpoint.timeoutMs),
      });
    } catch {
      // Timeout or transport failure on login: we cannot authenticate.
      throw new CourierAuthError(this.courierCode, `${this.courierCode}: token login failed`);
    }
    if (!res.ok) {
      throw new CourierAuthError(this.courierCode, `${this.courierCode}: token login rejected`);
    }
    const parsed = parseLoginResponse(await this.safeParseBody(res));
    if (!parsed.token) {
      throw new CourierAuthError(this.courierCode, `${this.courierCode}: token login returned no token`);
    }
    const ttl =
      parsed.expiresInSeconds !== null
        ? Math.max(TOKEN_EXPIRY_SKEW_SECONDS, parsed.expiresInSeconds - TOKEN_EXPIRY_SKEW_SECONDS)
        : TOKEN_DEFAULT_TTL_SECONDS;
    await this.tokenCache.set(this.tokenCacheKey, parsed.token, ttl);
    return parsed.token;
  }

  // ------------------------------------------------------------------
  // transport core
  // ------------------------------------------------------------------

  private log(rec: BluedartCallRecord): void {
    this.requestLog.push(rec);
  }

  /** One HTTP call with the §8.2 error classification. `responseType`
   *  'bytes' is for the label PDF; everything else is JSON. On a 401 the
   *  cached token is dropped, a fresh login is attempted and the call is
   *  retried exactly once (a 401 means the request was rejected before
   *  processing, so the retry cannot double-book). */
  private async call(
    method: AdapterMethod,
    endpoint: EndpointSpec,
    init: { query?: Record<string, string>; body?: string; accept?: string },
    responseType: 'json' | 'bytes' = 'json',
    retriedAfter401 = false,
  ): Promise<unknown> {
    const token = await this.getToken(retriedAfter401);
    const url = new URL(endpoint.path, this.baseUrl);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      url.searchParams.set(k, v);
    }
    const headers: Record<string, string> = {
      Authorization: `${BLUEDART_AUTH_SCHEME} ${token}`,
    };
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

    if (res.status === 401 && !retriedAfter401) {
      // Expired/revoked token: invalidate, re-login, retry once.
      await this.tokenCache.del(this.tokenCacheKey);
      return this.call(method, endpoint, init, responseType, true);
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
    const svcBody = await this.call('getQuote', BLUEDART_ENDPOINTS.serviceability, {
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

    const quoteBody = await this.call('getQuote', BLUEDART_ENDPOINTS.quoteCharges, {
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
      // Blue Dart's return-leg pricing is not part of the quote surface —
      // null = no provider RTO expectation; F-12 owns the rest (§4.4).
      rtoRule: null,
      eddFrom: null,
      eddTo: charges.expectedDeliveryDate,
      eddSource: charges.expectedDeliveryDate ? 'PROVIDER' : null,
      fetchedAt,
      providerQuoteRef: null, // TODO(sandbox-verify): no quote reference is known
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
      const createBody = await this.call('createShipment', BLUEDART_ENDPOINTS.createShipment, {
        body: buildCreateShipmentBody({
          merchantReference: intent.merchantReference,
          pickupLocationId: request.pickupLocationId,
          recipient: request.recipient,
          paymentMode: request.paymentMode,
          collectible: request.collectible,
          declaredValue: request.declaredValue,
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
    const body = await this.call('lookupByReference', BLUEDART_ENDPOINTS.tracking, {
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
      const body = await this.call('cancelShipment', BLUEDART_ENDPOINTS.cancel, {
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
    const body = await this.call('track', BLUEDART_ENDPOINTS.tracking, {
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
      // TODO(sandbox-verify): whether Blue Dart scans carry a provider event
      // ID; until confirmed, §8.5 dedupe falls back to the canonical
      // fingerprint.
      providerEventId: null,
    }));
  }

  // ------------------------------------------------------------------
  // §8.2 getLabel — courier PDF (label_mode COURIER_PDF_REQUIRED, §9.9.1:
  // the courier's own PDF is fetched, never custom-rendered)
  // ------------------------------------------------------------------

  async getLabel(awb: string, format: 'PDF'): Promise<LabelResult> {
    this.log({ method: 'getLabel', at: this.now().toISOString(), awb });
    if (format !== 'PDF') {
      throw new CourierProviderError(this.courierCode, 'FORMAT_UNSUPPORTED');
    }
    const bytes = (await this.call(
      'getLabel',
      BLUEDART_ENDPOINTS.label,
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
    const body = await this.call('schedulePickup', BLUEDART_ENDPOINTS.pickup, {
      body: buildPickupBody({
        pickupLocationId: request.pickupLocationId,
        awbs: request.awbs,
        pickupDate: request.pickupDate,
      }),
    });
    const parsed = parsePickupResponse(body);
    if (!parsed.accepted) {
      throw new CourierProviderError(this.courierCode, parsed.reason ?? 'PICKUP_REJECTED');
    }
    return { acknowledged: true, providerPickupId: parsed.id };
  }

  // ------------------------------------------------------------------
  // §8.2 ndrAction — declared unsupported (A1-03)
  // ------------------------------------------------------------------

  async ndrAction(request: NdrActionRequest): Promise<NdrActionResult> {
    this.log({ method: 'ndrAction', at: this.now().toISOString(), awb: request.awb });
    // A1-03: never a silent no-op — Blue Dart's NDR-action APIs are
    // inconsistent at v1, so the capability is declared unsupported with a
    // documented manual fallback (courier_capability row in bluedart.seed).
    throw new UnsupportedCapabilityError(this.courierCode, 'ndrAction', BLUEDART_NDR_FALLBACK_NOTE);
  }
}

/**
 * Builds the AdapterFactory for the registry (§9.3.4), closed over the
 * Redis-backed token cache the module injects. Reads the KEY_PASTE
 * credentials (`client_id`, `client_secret`) and picks the base URL by mode.
 * The plaintext credentials are captured inside the instance and never
 * logged or re-emitted (§5.7 control 1, INV-18).
 */
export const createBluedartAdapterFactory =
  (tokenCache: BluedartTokenCache): AdapterFactory =>
  (ctx: AdapterBuildContext) => {
    for (const key of ['client_id', 'client_secret'] as const) {
      const value = ctx.credentials[key];
      if (typeof value !== 'string' || value.length === 0) {
        // Names the missing field, never a value (INV-18).
        throw new CourierAuthError(ctx.courierCode, `${ctx.courierCode}: missing credential ${key}`);
      }
    }
    return new BluedartAdapter({
      courierAccountId: ctx.courierAccountId,
      courierCode: ctx.courierCode,
      mode: ctx.mode,
      clientId: ctx.credentials.client_id,
      clientSecret: ctx.credentials.client_secret,
      tokenCache,
      now: ctx.now,
    });
  };
