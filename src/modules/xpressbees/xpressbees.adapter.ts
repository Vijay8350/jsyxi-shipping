import { createHash } from 'node:crypto';
import Redis from 'ioredis';
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
  TOKEN_TTL_DEFAULT_SECONDS,
  TOKEN_TTL_SKEW_SECONDS,
  XPRESSBEES_BASE_URLS,
  XPRESSBEES_COURIER_CODE,
  XPRESSBEES_ENDPOINTS,
  EndpointSpec,
  buildCancelBody,
  buildCreateShipmentBody,
  buildLabelQuery,
  buildLoginBody,
  buildNdrActionBody,
  buildPickupBody,
  buildTrackQueryByAwb,
  buildTrackQueryByReference,
  parseCancelResponse,
  parseCreateResponse,
  parseLoginResponse,
  parseNdrActionResponse,
  parsePickupResponse,
  parseProviderErrorCode,
  parseRetryAfterMs,
  parseTrackingResponse,
} from './xpressbees-api.map';

/**
 * Xpressbees adapter (§8.2, §9.3.4) — a DIRECT courier reached on the
 * merchant's own credentials (BYOC, INV-23). One instance per
 * courier_account build context (courier_account_id + mode + credentials
 * version, RW-20).
 *
 * Auth (§9.3.3 token pattern): the pasted email+password mint a bearer
 * token via POST /api/users/login. The token is cached in Redis with a TTL
 * (shared across processes; key scoped to courier_account + a fingerprint
 * of the login e-mail, never the password) and refreshed on 401 — a failed
 * refresh throws CourierAuthError, which moves the account to DISCONNECTED
 * (§3.21). The plaintext credentials and the token are confined to this
 * instance and the cache (§5.7 control 1, INV-18): never logged, never
 * re-emitted in errors.
 *
 * Transport policy (§8.2):
 * - 401 → one silent token refresh + single resend (the rejected request
 *   never reached business logic, so resending a create is not the INV-5
 *   blind retry); a still-failing call → CourierAuthError (→ DISCONNECTED)
 * - 403 → CourierAuthError
 * - 429 → AdapterRateLimitError (back-pressure, not provider failure)
 * - AbortSignal timeout → AdapterTimeoutError; on createShipment it is
 *   CONVERTED to {kind:'OUTCOME_UNKNOWN'} (§9.5.4, INV-5) and never
 *   retried blindly — lookupByReference resolves it (RW-12).
 * - other non-2xx → CourierProviderError with a structured code parsed
 *   from the provider body (codes/IDs only — never secrets or PII, INV-18).
 *
 * Idempotent create (A1-04, INV-5): Xpressbees' create is keyed by the
 * client order reference (`order_number` = intent.merchantReference);
 * additionally this adapter deduplicates per bookingIntentId in-process, so
 * a transport retry of the same intent NEVER issues a second create and
 * always returns the original outcome (including a cached OUTCOME_UNKNOWN —
 * resolution belongs to lookupByReference, not to a blind retry, §9.5.4).
 *
 * getQuote is DECLARED UNSUPPORTED (A1-03): Xpressbees Services are
 * cost_source = RATE_CARD (§3.7), priced and lane-checked by the §4.5 cost
 * engine; no Xpressbees rate endpoint is mapped at v1.
 *
 * Every endpoint URL, request and response mapping lives in
 * xpressbees-api.map.ts with TODO(sandbox-verify) markers; this file should
 * not need to change on a sandbox pass.
 */

/** Minimal token-cache surface — Redis in production, in-memory in tests. */
export interface TokenCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** Redis-backed TokenCache over an ioredis client. */
export class RedisTokenCache implements TokenCache {
  constructor(private readonly redis: Pick<Redis, 'get' | 'set' | 'del'>) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

/**
 * PROPOSAL (framework change, not made here): AdapterBuildContext carries
 * no cache handle, so the factory falls back to a lazily shared ioredis
 * client resolved from REDIS_URL exactly like configuration.ts /
 * redis.module.ts. When the framework threads the REDIS token into
 * AdapterBuildContext, this singleton goes away.
 */
let sharedTokenCache: TokenCache | null = null;
function defaultTokenCache(): TokenCache {
  if (!sharedTokenCache) {
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    sharedTokenCache = new RedisTokenCache(redis);
  }
  return sharedTokenCache;
}

export interface XpressbeesAdapterOptions {
  courierAccountId: string;
  /** Merchant's courier-registered pickup/customer code (optional). */
  pickupCode?: string;
  courierCode?: string;
  mode: CourierAccountMode;
  /** Plaintext login credentials, confined to this instance (§5.7 control 1,
   *  INV-18): never logged, never re-emitted in errors. */
  email: string;
  password: string;
  now: () => Date;
  /** Test hook: injectable fetch; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Test hook: override the mode-derived base URL. */
  baseUrlOverride?: string;
  /** Test hook: injectable token cache; defaults to the shared Redis cache. */
  tokenCache?: TokenCache;
}

export interface XpressbeesCallRecord {
  method: AdapterMethod;
  at: string;
  bookingIntentId?: string;
  merchantReference?: string;
  awb?: string;
  /** A1-04: a retry of an already-recorded intent — no second create. */
  deduplicated?: boolean;
}

export class XpressbeesAdapter implements CourierAdapter {
  readonly courierCode: string;
  /** §15.1 optional surface: getQuote is declared unsupported (A1-03) —
   *  RATE_CARD Services are priced by the §4.5 cost engine. */
  readonly unsupportedMethods: AdapterMethod[] = ['getQuote'];
  /** §15.1 optional surface: lets the contract suite assert A1-04. */
  readonly requestLog: XpressbeesCallRecord[] = [];

  private readonly courierAccountId: string;
  private readonly pickupCode?: string;
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private readonly now: () => Date;
  private readonly fetchFn: typeof fetch;
  private readonly tokenCache: TokenCache;
  private readonly tokenCacheKey: string;
  /** INV-5: intent → the outcome of the one create issued for it. */
  private readonly createsByIntent = new Map<string, CreateShipmentResult>();
  /** Fast-path token copy; expires early by TOKEN_TTL_SKEW_SECONDS. */
  private memoryToken: { token: string; validUntilMs: number } | null = null;
  /** Single-flight login: concurrent calls share one token mint. */
  private loginInFlight: Promise<string> | null = null;

  constructor(options: XpressbeesAdapterOptions) {
    this.courierCode = options.courierCode ?? XPRESSBEES_COURIER_CODE;
    this.courierAccountId = options.courierAccountId;
    this.pickupCode = options.pickupCode;
    this.baseUrl =
      options.baseUrlOverride ??
      XPRESSBEES_BASE_URLS[options.mode] ??
      XPRESSBEES_BASE_URLS.LIVE;
    this.email = options.email;
    this.password = options.password;
    this.now = options.now;
    this.fetchFn = options.fetchFn ?? fetch;
    this.tokenCache = options.tokenCache ?? defaultTokenCache();
    // Scoped per account + a fingerprint of the login identity so a
    // credential replace (RW-20) never reads the previous token. The
    // password is never part of the key (INV-18).
    const emailHash = createHash('sha256').update(this.email).digest('hex').slice(0, 12);
    this.tokenCacheKey = `adapter-token:${this.courierCode}:${this.courierAccountId}:${emailHash}`;
  }

  // ------------------------------------------------------------------
  // token lifecycle (§9.3.3)
  // ------------------------------------------------------------------

  /** A usable bearer token: memory fast path → Redis → fresh login.
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
      cached = null; // cache unavailable: fall through to a fresh login
    }
    if (cached) {
      // Redis already enforces the TTL; keep the memory copy for one minute
      // so bursts do not hit Redis per call.
      this.memoryToken = { token: cached, validUntilMs: this.now().getTime() + 60_000 };
      return cached;
    }
    return this.login(method);
  }

  /** Single-flight login; a failed login is CourierAuthError (§3.21). */
  private login(method: AdapterMethod): Promise<string> {
    this.loginInFlight ??= this.performLogin(method).finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async performLogin(method: AdapterMethod): Promise<string> {
    const endpoint = XPRESSBEES_ENDPOINTS.login;
    const url = new URL(endpoint.path, this.baseUrl);
    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), {
        method: endpoint.method,
        headers: { 'Content-Type': endpoint.contentType },
        body: buildLoginBody(this.email, this.password),
        signal: AbortSignal.timeout(endpoint.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        // A login timeout is a transport timeout on the triggering method;
        // on createShipment the caller converts it to OUTCOME_UNKNOWN
        // (§9.5.4) like any other create timeout.
        throw new AdapterTimeoutError(this.courierCode, method);
      }
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
      throw new CourierProviderError(this.courierCode, parseProviderErrorCode(body, res.status));
    }
    const parsed = parseLoginResponse(await this.safeParseBody(res));
    if (!parsed.token) {
      // A 200 without a token is an auth failure, not a provider hiccup.
      throw new CourierAuthError(this.courierCode);
    }
    const ttlSeconds = Math.max(
      60,
      (parsed.expiresInSeconds ?? TOKEN_TTL_DEFAULT_SECONDS) - TOKEN_TTL_SKEW_SECONDS,
    );
    this.memoryToken = {
      token: parsed.token,
      validUntilMs: this.now().getTime() + ttlSeconds * 1000,
    };
    try {
      await this.tokenCache.set(this.tokenCacheKey, parsed.token, ttlSeconds);
    } catch {
      // Cache unavailable: the memory copy still serves this instance.
    }
    return parsed.token;
  }

  /** Drop the token everywhere (401 refresh path). */
  private async invalidateToken(): Promise<void> {
    this.memoryToken = null;
    try {
      await this.tokenCache.del(this.tokenCacheKey);
    } catch {
      // best-effort; the next login overwrites the key
    }
  }

  // ------------------------------------------------------------------
  // transport core
  // ------------------------------------------------------------------

  private log(rec: XpressbeesCallRecord): void {
    this.requestLog.push(rec);
  }

  /**
   * One authenticated HTTP call with the §8.2 error classification. On 401
   * the cached token is dropped, a fresh one minted, and the request resent
   * exactly once; a second 401 (or a failed login) is CourierAuthError
   * (→ DISCONNECTED, §3.21). `responseType` 'bytes' is for the label PDF.
   */
  private async call(
    method: AdapterMethod,
    endpoint: EndpointSpec,
    init: { query?: Record<string, string>; body?: string; accept?: string },
    responseType: 'json' | 'bytes' = 'json',
  ): Promise<unknown> {
    let token = await this.ensureToken(method);
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = new URL(endpoint.path, this.baseUrl);
      for (const [k, v] of Object.entries(init.query ?? {})) {
        url.searchParams.set(k, v);
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
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
        // Expired/revoked token: refresh once and resend. The rejected
        // request never reached business logic, so resending a create is
        // not the INV-5 blind retry (§9.5.4).
        await this.invalidateToken();
        token = await this.login(method);
        continue;
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
    // Unreachable (the loop always returns or throws), but keeps the type
    // narrow without a non-null assertion.
    throw new CourierAuthError(this.courierCode);
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
  // §8.2 getQuote — DECLARED UNSUPPORTED (A1-03). Xpressbees Services are
  // cost_source = RATE_CARD (§3.7): the §4.5 cost engine synthesizes the
  // §8.3 quote from the merchant's rate card, including lane
  // serviceability. Never a silent no-op.
  // ------------------------------------------------------------------

  async getQuote(_request: QuoteRequest): Promise<QuoteResponse> {
    this.log({ method: 'getQuote', at: this.now().toISOString() });
    throw new UnsupportedCapabilityError(
      this.courierCode,
      'getQuote',
      'Priced from the merchant rate card (RATE_CARD, §3.7); the cost engine synthesizes the quote and lane serviceability (§4.5). No Xpressbees rate endpoint is mapped at v1.',
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
      const createBody = await this.call('createShipment', XPRESSBEES_ENDPOINTS.createShipment, {
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
    const body = await this.call('lookupByReference', XPRESSBEES_ENDPOINTS.track, {
      query: buildTrackQueryByReference(merchantReference),
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
      const body = await this.call('cancelShipment', XPRESSBEES_ENDPOINTS.cancel, {
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
    const body = await this.call('track', XPRESSBEES_ENDPOINTS.track, {
      query: buildTrackQueryByAwb(awb),
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
  // §8.2 getLabel — courier PDF (label_mode CUSTOM_ALLOWED, §9.9.1:
  // Xpressbees allows custom labels; the courier PDF is still offered here)
  // ------------------------------------------------------------------

  async getLabel(awb: string, format: 'PDF'): Promise<LabelResult> {
    this.log({ method: 'getLabel', at: this.now().toISOString(), awb });
    if (format !== 'PDF') {
      throw new CourierProviderError(this.courierCode, 'FORMAT_UNSUPPORTED');
    }
    const bytes = (await this.call(
      'getLabel',
      XPRESSBEES_ENDPOINTS.label,
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
    const body = await this.call('schedulePickup', XPRESSBEES_ENDPOINTS.pickup, {
      body: buildPickupBody({
        awbs: request.awbs,
        pickupLocationId: request.pickupLocationId,
          registeredPickupCode: this.pickupCode,
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
  // §8.2 ndrAction
  // ------------------------------------------------------------------

  async ndrAction(request: NdrActionRequest): Promise<NdrActionResult> {
    this.log({ method: 'ndrAction', at: this.now().toISOString(), awb: request.awb });
    const body = await this.call('ndrAction', XPRESSBEES_ENDPOINTS.ndrAction, {
      body: buildNdrActionBody(request),
    });
    const parsed = parseNdrActionResponse(body);
    return { accepted: parsed.accepted, providerAck: parsed.id ?? parsed.reason };
  }
}

/**
 * AdapterFactory for the registry (§9.3.4). Reads the KEY_PASTE credentials
 * (`email` + `password`, both secret), picks the base URL by mode. The
 * plaintext credentials are captured inside the instance and never logged
 * or re-emitted (§5.7 control 1, INV-18).
 */
export const xpressbeesAdapterFactory: AdapterFactory = (ctx: AdapterBuildContext) => {
  const email = ctx.credentials.email;
  const password = ctx.credentials.password;
  if (typeof email !== 'string' || email.length === 0) {
    // Names the missing field, never a value (INV-18).
    throw new CourierAuthError(ctx.courierCode, `${ctx.courierCode}: missing credential email`);
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new CourierAuthError(ctx.courierCode, `${ctx.courierCode}: missing credential password`);
  }
  return new XpressbeesAdapter({
    courierAccountId: ctx.courierAccountId,
      pickupCode:
        typeof ctx.credentials.pickup_code === 'string' && ctx.credentials.pickup_code
          ? ctx.credentials.pickup_code
          : undefined,
    courierCode: ctx.courierCode,
    mode: ctx.mode,
    email,
    password,
    now: ctx.now,
  });
};
