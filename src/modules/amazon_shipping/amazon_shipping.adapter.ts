import { createHash } from 'node:crypto';
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
  AMAZON_ACCESS_TOKEN_HEADER,
  AMAZON_LWA_TOKEN_URL,
  AMAZON_SHIPPING_BASE_URLS,
  AMAZON_SHIPPING_COURIER_CODE,
  AMAZON_SHIPPING_ENDPOINTS,
  CANCEL_REJECT_HTTP_STATUSES,
  EndpointSpec,
  TOKEN_TTL_DEFAULT_SECONDS,
  TOKEN_TTL_SKEW_SECONDS,
  buildCancelPath,
  buildCreateShipmentBody,
  buildLabelQuery,
  buildLookupQuery,
  buildLwaRefreshBody,
  buildTrackQuery,
  parseCancelResponse,
  parseCreateResponse,
  parseLabelBase64,
  parseLookupResponse,
  parseLwaTokenResponse,
  parseProviderErrorCode,
  parseRetryAfterMs,
  parseTrackingResponse,
} from './amazon_shipping-api.map';

/**
 * Amazon Shipping adapter (§8.2, §9.3.4) — a DIRECT courier reached on the
 * merchant's own credentials (BYOC, INV-23). One instance per
 * courier_account build context (courier_account_id + mode + credentials
 * version, RW-20).
 *
 * Auth (§9.3.3 OAUTH — Login with Amazon): the merchant connects via LWA
 * consent; the stored credentials are the LWA `refresh_token` plus the LWA
 * app's `client_id`/`client_secret`. Access tokens are minted via
 * POST {lwa}/auth/o2/token (grant_type=refresh_token) and cached in Redis
 * with a TTL (key scoped to courier_account + a fingerprint of the
 * refresh_token, never the token itself). A REFRESH FAILURE throws
 * CourierAuthError, which moves the account to DISCONNECTED (§3.21) and
 * raises the courier-disconnected alert path (§9.3.3) — the framework's
 * health service does the rest. The plaintext credentials and tokens are
 * confined to this instance and the cache (§5.7 control 1, INV-18): never
 * logged, never re-emitted in errors.
 *
 * Transport policy (§8.2):
 * - 401 → one silent access-token refresh + single resend (the rejected
 *   request never reached business logic, so resending a create is not the
 *   INV-5 blind retry); a still-failing call → CourierAuthError
 * - 403 → CourierAuthError
 * - 429 → AdapterRateLimitError (back-pressure, not provider failure)
 * - AbortSignal timeout → AdapterTimeoutError; on createShipment it is
 *   CONVERTED to {kind:'OUTCOME_UNKNOWN'} (§9.5.4, INV-5) and never
 *   retried blindly — lookupByReference resolves it (RW-12).
 * - other non-2xx → CourierProviderError with a structured code parsed
 *   from the provider body (codes/IDs only — never secrets or PII, INV-18).
 *
 * Idempotent create (A1-04, INV-5): Amazon's create is keyed by
 * clientReferenceId = intent.merchantReference; additionally this adapter
 * deduplicates per bookingIntentId in-process, so a transport retry of the
 * same intent NEVER issues a second create and always returns the original
 * outcome (including a cached OUTCOME_UNKNOWN — resolution belongs to
 * lookupByReference, not to a blind retry, §9.5.4).
 *
 * Declared-unsupported capabilities (A1-03 — never a silent no-op):
 * - getQuote: Amazon Shipping Services are cost_source = RATE_CARD (§3.7),
 *   priced and lane-checked by the §4.5 cost engine; rate endpoints exist
 *   only in some Amazon programs and are not mapped at v1.
 * - schedulePickup: Amazon Shipping auto-collects under most merchant
 *   contracts; no pickup-scheduling endpoint is mapped at v1.
 * - ndrAction: no NDR action endpoint is mapped at v1; exceptions are
 *   handled in Amazon Seller Central.
 *
 * Every endpoint URL, request and response mapping lives in
 * amazon_shipping-api.map.ts with TODO(sandbox-verify) markers; this file
 * should not need to change on a sandbox pass.
 */

/** Minimal token-cache surface — Redis in production, in-memory in tests. */
export interface AmazonShippingTokenCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** A1-03 fallback notes, shared with the seed's courier_capability rows. */
export const AMAZON_SHIPPING_GETQUOTE_FALLBACK_NOTE =
  'Priced from the merchant rate card (RATE_CARD, §3.7); the cost engine synthesizes the quote and lane serviceability (§4.5). Amazon rate endpoints exist only in some programs and are not mapped at v1.';
export const AMAZON_SHIPPING_PICKUP_FALLBACK_NOTE =
  'Amazon Shipping auto-collects under most merchant contracts; no pickup-scheduling endpoint is mapped at v1. Arrange handover per the merchant contract / Amazon Seller Central.';
export const AMAZON_SHIPPING_NDR_FALLBACK_NOTE =
  'No Amazon Shipping NDR action endpoint is mapped at v1; handle delivery exceptions in Amazon Seller Central.';

export interface AmazonShippingAdapterOptions {
  courierAccountId: string;
  /** Merchant's courier-registered pickup/customer code (optional). */
  pickupCode?: string;
  courierCode?: string;
  mode: CourierAccountMode;
  /** Plaintext LWA credentials, confined to this instance (§5.7 control 1,
   *  INV-18): never logged, never re-emitted in errors. */
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  /** Redis-backed token cache (production) or an in-memory one (tests). */
  tokenCache: AmazonShippingTokenCache;
  now: () => Date;
  /** Test hook: injectable fetch; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Test hook: override the mode-derived region base URL. */
  baseUrlOverride?: string;
  /** Test hook: override the LWA token endpoint. */
  tokenUrlOverride?: string;
}

export interface AmazonShippingCallRecord {
  method: AdapterMethod;
  at: string;
  bookingIntentId?: string;
  merchantReference?: string;
  awb?: string;
  /** A1-04: a retry of an already-recorded intent — no second create. */
  deduplicated?: boolean;
}

export class AmazonShippingAdapter implements CourierAdapter {
  readonly courierCode: string;
  /** §15.1 optional surface: declared-unsupported capabilities (A1-03). */
  readonly unsupportedMethods: AdapterMethod[] = ['getQuote', 'schedulePickup', 'ndrAction'];
  /** §15.1 optional surface: lets the contract suite assert A1-04. */
  readonly requestLog: AmazonShippingCallRecord[] = [];

  private readonly courierAccountId: string;
  private readonly pickupCode?: string;
  private readonly baseUrl: string;
  private readonly tokenUrl: string;
  private readonly refreshToken: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tokenCache: AmazonShippingTokenCache;
  private readonly tokenCacheKey: string;
  private readonly now: () => Date;
  private readonly fetchFn: typeof fetch;
  /** INV-5: intent → the outcome of the one create issued for it. */
  private readonly createsByIntent = new Map<string, CreateShipmentResult>();
  /** Fast-path token copy; expires early by TOKEN_TTL_SKEW_SECONDS. */
  private memoryToken: { token: string; validUntilMs: number } | null = null;
  /** Single-flight refresh: concurrent calls share one token mint. */
  private refreshInFlight: Promise<string> | null = null;

  constructor(options: AmazonShippingAdapterOptions) {
    this.courierCode = options.courierCode ?? AMAZON_SHIPPING_COURIER_CODE;
    this.courierAccountId = options.courierAccountId;
    this.pickupCode = options.pickupCode;
    this.baseUrl =
      options.baseUrlOverride ??
      AMAZON_SHIPPING_BASE_URLS[options.mode] ??
      AMAZON_SHIPPING_BASE_URLS.LIVE;
    this.tokenUrl = options.tokenUrlOverride ?? AMAZON_LWA_TOKEN_URL;
    this.refreshToken = options.refreshToken;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.tokenCache = options.tokenCache;
    this.now = options.now;
    this.fetchFn = options.fetchFn ?? fetch;
    // Scoped per account + a fingerprint of the refresh_token so a
    // credential replace (RW-20) never reads the previous access token. The
    // token itself is never part of the key (INV-18).
    const credHash = createHash('sha256').update(this.refreshToken).digest('hex').slice(0, 12);
    this.tokenCacheKey = `adapter-token:${this.courierCode}:${this.courierAccountId}:${credHash}`;
  }

  // ------------------------------------------------------------------
  // access-token lifecycle (§9.3.3 OAUTH)
  // ------------------------------------------------------------------

  /** A usable LWA access token: memory fast path → Redis → fresh refresh.
   *  `method` is the call that triggered the token fetch, for timeout
   *  classification. */
  private async ensureToken(method: AdapterMethod): Promise<string> {
    if (this.memoryToken && this.now().getTime() < this.memoryToken.validUntilMs) {
      return this.memoryToken.token;
    }
    let cached: string | null = null;
    try {
      cached = await this.tokenCache.get(this.tokenCacheKey);
    } catch {
      cached = null; // cache unavailable: fall through to a fresh refresh
    }
    if (cached) {
      // Redis already enforces the TTL; keep the memory copy for one minute
      // so bursts do not hit Redis per call.
      this.memoryToken = { token: cached, validUntilMs: this.now().getTime() + 60_000 };
      return cached;
    }
    return this.refresh(method);
  }

  /** Single-flight refresh; a FAILED refresh is CourierAuthError (§9.3.3:
   *  → DISCONNECTED, §3.21). */
  private refresh(method: AdapterMethod): Promise<string> {
    this.refreshInFlight ??= this.performRefresh(method).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async performRefresh(method: AdapterMethod): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchFn(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildLwaRefreshBody(this.refreshToken, this.clientId, this.clientSecret),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        // A refresh timeout is a transport timeout on the triggering method;
        // on createShipment the caller converts it to OUTCOME_UNKNOWN
        // (§9.5.4) like any other create timeout.
        throw new AdapterTimeoutError(this.courierCode, method);
      }
      throw new CourierProviderError(this.courierCode, 'TRANSPORT_ERROR');
    }
    // LWA rejects a revoked/expired refresh_token with 400 invalid_grant
    // (or 401): the refresh has FAILED → DISCONNECTED (§9.3.3, §3.21).
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new CourierAuthError(this.courierCode, `${this.courierCode}: token refresh rejected`);
    }
    if (res.status === 429) {
      throw new AdapterRateLimitError(
        this.courierCode,
        parseRetryAfterMs(res.headers.get('retry-after')),
      );
    }
    if (!res.ok) {
      const body = await this.safeParseBody(res);
      throw new CourierProviderError(this.courierCode, parseProviderErrorCode(body, res.status));
    }
    const parsed = parseLwaTokenResponse(await this.safeParseBody(res));
    if (!parsed.accessToken) {
      // A 200 without an access token is an auth failure, not a provider hiccup.
      throw new CourierAuthError(this.courierCode, `${this.courierCode}: token refresh returned no access token`);
    }
    const ttlSeconds = Math.max(
      60,
      (parsed.expiresInSeconds ?? TOKEN_TTL_DEFAULT_SECONDS) - TOKEN_TTL_SKEW_SECONDS,
    );
    this.memoryToken = {
      token: parsed.accessToken,
      validUntilMs: this.now().getTime() + ttlSeconds * 1000,
    };
    try {
      await this.tokenCache.set(this.tokenCacheKey, parsed.accessToken, ttlSeconds);
    } catch {
      // Cache unavailable: the memory copy still serves this instance.
    }
    return parsed.accessToken;
  }

  /** Drop the access token everywhere (401 refresh path). The stored
   *  refresh_token stays — only the minted access token is invalidated. */
  private async invalidateToken(): Promise<void> {
    this.memoryToken = null;
    try {
      await this.tokenCache.del(this.tokenCacheKey);
    } catch {
      // best-effort; the next refresh overwrites the key
    }
  }

  // ------------------------------------------------------------------
  // transport core
  // ------------------------------------------------------------------

  private log(rec: AmazonShippingCallRecord): void {
    this.requestLog.push(rec);
  }

  /**
   * One authenticated request with the 401 → refresh-and-resend-once
   * discipline (§8.2). The rejected request never reached business logic,
   * so resending a create is not the INV-5 blind retry (§9.5.4). Returns
   * the raw Response; status classification is the caller's (see `call`).
   */
  private async authedRequest(
    method: AdapterMethod,
    endpoint: EndpointSpec,
    init: { path?: string; query?: Record<string, string>; body?: string; accept?: string },
  ): Promise<Response> {
    let token = await this.ensureToken(method);
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = new URL(init.path ?? endpoint.path, this.baseUrl);
      for (const [k, v] of Object.entries(init.query ?? {})) {
        url.searchParams.set(k, v);
      }
      const headers: Record<string, string> = { [AMAZON_ACCESS_TOKEN_HEADER]: token };
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

      if (res.status === 401 && attempt === 0) {
        await this.invalidateToken();
        token = await this.refresh(method);
        continue;
      }
      return res;
    }
    // Unreachable (the loop always returns or throws), but keeps the type
    // narrow without a non-null assertion.
    throw new CourierAuthError(this.courierCode);
  }

  /** The §8.2 status classification shared by every method. */
  private async classify(res: Response): Promise<void> {
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
      throw new CourierProviderError(this.courierCode, parseProviderErrorCode(body, res.status));
    }
  }

  /** One authenticated call with the full §8.2 error classification,
   *  returning the parsed JSON body. */
  private async call(
    method: AdapterMethod,
    endpoint: EndpointSpec,
    init: { path?: string; query?: Record<string, string>; body?: string; accept?: string } = {},
  ): Promise<unknown> {
    const res = await this.authedRequest(method, endpoint, init);
    await this.classify(res);
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
  // §8.2 getQuote — DECLARED UNSUPPORTED (A1-03). Amazon Shipping Services
  // are cost_source = RATE_CARD (§3.7): the §4.5 cost engine synthesizes
  // the §8.3 quote from the merchant's rate card, including lane
  // serviceability. Never a silent no-op.
  // ------------------------------------------------------------------

  async getQuote(_request: QuoteRequest): Promise<QuoteResponse> {
    this.log({ method: 'getQuote', at: this.now().toISOString() });
    throw new UnsupportedCapabilityError(
      this.courierCode,
      'getQuote',
      AMAZON_SHIPPING_GETQUOTE_FALLBACK_NOTE,
    );
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
      const createBody = await this.call('createShipment', AMAZON_SHIPPING_ENDPOINTS.createShipment, {
        body: buildCreateShipmentBody({
          merchantReference: intent.merchantReference,
          pickupLocationId: request.pickupLocationId,
          registeredPickupCode: this.pickupCode,
          recipient: request.recipient,
          paymentMode: request.paymentMode,
          collectible: request.collectible,
          declaredValue: request.declaredValue,
          deadWeightKg: request.deadWeightKg,
          lengthCm: request.lengthCm,
          widthCm: request.widthCm,
          heightCm: request.heightCm,
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
    const body = await this.call('lookupByReference', AMAZON_SHIPPING_ENDPOINTS.lookup, {
      query: buildLookupQuery(merchantReference),
    });
    return parseLookupResponse(body);
  }

  // ------------------------------------------------------------------
  // §8.2 cancelShipment
  // ------------------------------------------------------------------

  async cancelShipment(awb: string): Promise<CancelShipmentResult> {
    this.log({ method: 'cancelShipment', at: this.now().toISOString(), awb });
    let res: Response;
    try {
      res = await this.authedRequest('cancelShipment', AMAZON_SHIPPING_ENDPOINTS.cancel, {
        path: buildCancelPath(awb),
        body: '{}',
      });
    } catch (err) {
      if (err instanceof AdapterTimeoutError) {
        // Same exactly-once discipline as create (§9.5.4): no blind retry.
        return { kind: 'OUTCOME_UNKNOWN', reason: null };
      }
      throw err;
    }
    if (res.ok) {
      const parsed = parseCancelResponse(await this.safeParseBody(res));
      return parsed.accepted
        ? { kind: 'CANCELLED', reason: null }
        : { kind: 'REJECTED', reason: parsed.reason ?? 'CANCEL_REJECTED' };
    }
    if (CANCEL_REJECT_HTTP_STATUSES.includes(res.status)) {
      // TODO(sandbox-verify): refusal statuses (already collected / unknown
      // shipment) map to REJECTED, never to the circuit-breaker error path.
      const body = await this.safeParseBody(res);
      return { kind: 'REJECTED', reason: parseProviderErrorCode(body, res.status) };
    }
    await this.classify(res); // throws 401/403/429/5xx
    return { kind: 'REJECTED', reason: 'CANCEL_REJECTED' }; // unreachable
  }

  // ------------------------------------------------------------------
  // §8.2 track (§8.5 polling fallback)
  // ------------------------------------------------------------------

  async track(awb: string): Promise<TrackEvent[]> {
    this.log({ method: 'track', at: this.now().toISOString(), awb });
    const body = await this.call('track', AMAZON_SHIPPING_ENDPOINTS.track, {
      query: buildTrackQuery(awb),
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
      // §8.5 dedupe prefers the provider event ID; absent, it falls back to
      // the canonical fingerprint.
      providerEventId: scan.providerEventId,
    }));
  }

  // ------------------------------------------------------------------
  // §8.2 getLabel — courier PDF (label_mode COURIER_PDF_REQUIRED, §9.9.1:
  // Amazon Shipping labels are always the courier's own PDF)
  // ------------------------------------------------------------------

  async getLabel(awb: string, format: 'PDF'): Promise<LabelResult> {
    this.log({ method: 'getLabel', at: this.now().toISOString(), awb });
    if (format !== 'PDF') {
      throw new CourierProviderError(this.courierCode, 'FORMAT_UNSUPPORTED');
    }
    const body = await this.call('getLabel', AMAZON_SHIPPING_ENDPOINTS.label, {
      query: buildLabelQuery(awb),
      accept: 'application/json',
    });
    const base64 = parseLabelBase64(body);
    if (!base64) {
      throw new CourierProviderError(this.courierCode, 'LABEL_UNAVAILABLE');
    }
    return { contentType: 'application/pdf', bytes: Buffer.from(base64, 'base64') };
  }

  // ------------------------------------------------------------------
  // §8.2 schedulePickup — DECLARED UNSUPPORTED (A1-03): Amazon Shipping
  // auto-collects under most merchant contracts; no pickup-scheduling
  // endpoint is mapped at v1. Never a silent no-op.
  // ------------------------------------------------------------------

  async schedulePickup(_request: PickupRequest): Promise<PickupResult> {
    this.log({ method: 'schedulePickup', at: this.now().toISOString() });
    throw new UnsupportedCapabilityError(
      this.courierCode,
      'schedulePickup',
      AMAZON_SHIPPING_PICKUP_FALLBACK_NOTE,
    );
  }

  // ------------------------------------------------------------------
  // §8.2 ndrAction — DECLARED UNSUPPORTED (A1-03): no NDR action endpoint
  // is mapped at v1. Never a silent no-op.
  // ------------------------------------------------------------------

  async ndrAction(_request: NdrActionRequest): Promise<NdrActionResult> {
    this.log({ method: 'ndrAction', at: this.now().toISOString(), awb: _request.awb });
    throw new UnsupportedCapabilityError(
      this.courierCode,
      'ndrAction',
      AMAZON_SHIPPING_NDR_FALLBACK_NOTE,
    );
  }
}

/**
 * Builds the AdapterFactory for the registry (§9.3.4), closed over the
 * Redis-backed token cache the module injects. Reads the OAUTH credentials
 * (`refresh_token` secret, `client_id`, `client_secret` secret, §9.3.3) and
 * picks the region base URL by mode. The plaintext credentials are captured
 * inside the instance and never logged or re-emitted (§5.7 control 1,
 * INV-18).
 */
export const createAmazonShippingAdapterFactory =
  (tokenCache: AmazonShippingTokenCache): AdapterFactory =>
  (ctx: AdapterBuildContext) => {
    for (const key of ['refresh_token', 'client_id', 'client_secret'] as const) {
      const value = ctx.credentials[key];
      if (typeof value !== 'string' || value.length === 0) {
        // Names the missing field, never a value (INV-18).
        throw new CourierAuthError(ctx.courierCode, `${ctx.courierCode}: missing credential ${key}`);
      }
    }
    return new AmazonShippingAdapter({
      courierAccountId: ctx.courierAccountId,
      pickupCode:
        typeof ctx.credentials.pickup_code === 'string' && ctx.credentials.pickup_code
          ? ctx.credentials.pickup_code
          : undefined,
      courierCode: ctx.courierCode,
      mode: ctx.mode,
      refreshToken: ctx.credentials.refresh_token,
      clientId: ctx.credentials.client_id,
      clientSecret: ctx.credentials.client_secret,
      tokenCache,
      now: ctx.now,
    });
  };
