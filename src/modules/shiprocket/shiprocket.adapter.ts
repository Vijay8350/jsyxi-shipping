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
  QuoteComponent,
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
  SHIPROCKET_BASE_URLS,
  SHIPROCKET_COURIER_CODE,
  SHIPROCKET_COURIER_MAP_KEY,
  SHIPROCKET_ENDPOINTS,
  TOKEN_TTL_DEFAULT_SECONDS,
  TOKEN_TTL_SKEW_SECONDS,
  buildAssignAwbBody,
  buildCancelByAwbsBody,
  buildCreateOrderBody,
  buildGenerateLabelBody,
  buildLoginBody,
  buildOrdersSearchQuery,
  buildPickupBody,
  buildServiceabilityQuery,
  buildTrackByAwbPath,
  money2dpToPaise,
  paiseToMoney2dp,
  parseAssignAwbResponse,
  parseCancelResponse,
  parseCreateOrderResponse,
  parseGenerateLabelResponse,
  parseLoginResponse,
  parseOrdersSearchResponse,
  parsePickupResponse,
  parseProviderErrorCode,
  parseProviderDateTime,
  parseRetryAfterMs,
  parseServiceabilityResponse,
  parseTrackResponse,
  rtoRuleFromCharges,
} from './shiprocket-api.map';

/**
 * Shiprocket adapter (§8.2, §9.3.4) — the launch AGGREGATOR: Shiprocket's
 * nested courier options surface as Jsyxi Services with
 * cost_source = LIVE_QUOTE (A2-02), priced by GET /courier/serviceability,
 * and every booking passes the CHOSEN nested courier_id to
 * POST /courier/assign/awb. One instance per courier_account build context
 * (courier_account_id + mode + credentials version, RW-20).
 *
 * Auth (§9.3.3 KEY_PASTE token pattern): the pasted email+password mint a
 * bearer token via POST /auth/login. The token is cached in Redis with a
 * TTL (key scoped to courier_account + a fingerprint of the login e-mail,
 * never the password) and refreshed on 401 — a failed refresh throws
 * CourierAuthError, which moves the account to DISCONNECTED (§3.21). The
 * plaintext credentials and the token are confined to this instance and the
 * cache (§5.7 control 1, INV-18): never logged, never re-emitted in errors.
 *
 * Nested service identity (§15.1 acceptance): the Jsyxi Service ↔ Shiprocket
 * courier_id mapping is carried in the courier_account credential blob as
 * the NON-secret JSON field `shiprocket_courier_map`
 * ({ "<service.code or service_id>": "<shiprocket courier_id>", "default":
 * "<fallback courier_id>" }). The adapter resolves:
 * - getQuote: map[serviceId] → map['default']; a lane can be serviceable
 *   while the mapped nested courier is absent from the offer — that yields
 *   rateAvailable = false with SERVICE_NOT_MAPPED, never another courier's
 *   rate (INV-23 pass-through forbids substituting prices silently).
 * - createShipment: map[request.serviceId] → map['default'] — the booked
 *   Service arrives on CreateShipmentRequest from the frozen snapshot
 *   (INV-8), so the nested identity is honoured at booking time too.
 *
 * Transport policy (§8.2):
 * - 401 → one silent token refresh + single resend (the rejected request
 *   never reached business logic, so resending is not the INV-5 blind
 *   retry); a still-failing call → CourierAuthError (→ DISCONNECTED)
 * - 403 → CourierAuthError
 * - 429 → AdapterRateLimitError (back-pressure, not provider failure)
 * - AbortSignal timeout → AdapterTimeoutError; on createShipment (EITHER
 *   step — order create or AWB assign) it is CONVERTED to
 *   {kind:'OUTCOME_UNKNOWN'} (§9.5.4, INV-5) and never retried blindly —
 *   lookupByReference (GET /orders by the merchant reference) resolves it
 *   (RW-12).
 * - other non-2xx → CourierProviderError with a structured code parsed
 *   from the provider body (codes/IDs only — never secrets or PII, INV-18).
 *
 * Idempotent create (A1-04, INV-5): the order create is keyed by
 * order_id = intent.merchantReference (Shiprocket rejects duplicates);
 * additionally this adapter deduplicates per bookingIntentId in-process, so
 * a transport retry of the same intent NEVER issues a second create and
 * always returns the original outcome (including a cached OUTCOME_UNKNOWN —
 * resolution belongs to lookupByReference, not to a blind retry, §9.5.4).
 *
 * ndrAction is DECLARED UNSUPPORTED (A1-03): Shiprocket's NDR action API is
 * not externally verified at v1; the manual fallback is the Shiprocket
 * panel's NDR section.
 *
 * Every endpoint URL, request and response mapping lives in
 * shiprocket-api.map.ts with TODO(sandbox-verify) markers; this file should
 * not need to change on a sandbox pass.
 */

/** Minimal token-cache surface — Redis in production, in-memory in tests. */
export interface ShiprocketTokenCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** Redis-backed ShiprocketTokenCache over an ioredis client. */
export class RedisShiprocketTokenCache implements ShiprocketTokenCache {
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

/** A1-03: the manual fallback shown wherever ndrAction is disabled. */
export const SHIPROCKET_NDR_FALLBACK_NOTE =
  'NDR actions (reattempt / address update / RTO) are taken in the Shiprocket panel (NDR section); the Shiprocket NDR action API is not externally verified at v1 (TODO(sandbox-verify)).';

export interface ShiprocketAdapterOptions {
  courierAccountId: string;
  /** Merchant's courier-registered pickup/customer code (optional). */
  pickupCode?: string;
  courierCode?: string;
  mode: CourierAccountMode;
  /** Plaintext login credentials, confined to this instance (§5.7 control 1,
   *  INV-18): never logged, never re-emitted in errors. */
  email: string;
  password: string;
  /** Nested-identity mapping: Jsyxi service code/id → Shiprocket courier_id,
   *  plus an optional 'default' key. From the non-secret credential-blob
   *  field shiprocket_courier_map (see the class doc). */
  courierMap: Record<string, string>;
  now: () => Date;
  /** Test hook: injectable fetch; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Test hook: override the mode-derived base URL. */
  baseUrlOverride?: string;
  /** Test hook: injectable token cache; defaults to the shared Redis cache. */
  tokenCache?: ShiprocketTokenCache;
}

export interface ShiprocketCallRecord {
  method: AdapterMethod;
  at: string;
  bookingIntentId?: string;
  merchantReference?: string;
  awb?: string;
  /** A1-04: a retry of an already-recorded intent — no second create. */
  deduplicated?: boolean;
}

/** What this instance learned about a booking — feeds the awb → shipment_id
 *  resolution that pickup/label generation needs. */
interface BookingRecord {
  orderId: string | null;
  shipmentId: string | null;
  awb: string | null;
}

export class ShiprocketAdapter implements CourierAdapter {
  readonly courierCode: string;
  /** §15.1 optional surface: ndrAction is declared unsupported (A1-03). */
  readonly unsupportedMethods: AdapterMethod[] = ['ndrAction'];
  /** §15.1 optional surface: lets the contract suite assert A1-04. */
  readonly requestLog: ShiprocketCallRecord[] = [];

  private readonly courierAccountId: string;
  private readonly pickupCode?: string;
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private readonly courierMap: Record<string, string>;
  private readonly now: () => Date;
  private readonly fetchFn: typeof fetch;
  private readonly tokenCache: ShiprocketTokenCache;
  private readonly tokenCacheKey: string;
  /** INV-5: intent → the outcome of the one create issued for it. */
  private readonly createsByIntent = new Map<string, CreateShipmentResult>();
  /** Bookings this instance created or resolved, by AWB. */
  private readonly bookingsByAwb = new Map<string, BookingRecord>();
  /** Fast-path token copy; expires early by TOKEN_TTL_SKEW_SECONDS. */
  private memoryToken: { token: string; validUntilMs: number } | null = null;
  /** Single-flight login: concurrent calls share one token mint. */
  private loginInFlight: Promise<string> | null = null;

  constructor(options: ShiprocketAdapterOptions) {
    this.courierCode = options.courierCode ?? SHIPROCKET_COURIER_CODE;
    this.courierAccountId = options.courierAccountId;
    this.pickupCode = options.pickupCode;
    this.baseUrl =
      options.baseUrlOverride ??
      SHIPROCKET_BASE_URLS[options.mode] ??
      SHIPROCKET_BASE_URLS.LIVE;
    this.email = options.email;
    this.password = options.password;
    this.courierMap = options.courierMap;
    this.now = options.now;
    this.fetchFn = options.fetchFn ?? fetch;
    this.tokenCache = options.tokenCache ?? new RedisShiprocketTokenCache(defaultRedis());
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
    const endpoint = SHIPROCKET_ENDPOINTS.login;
    // baseUrl carries the /v1/external prefix, so concatenate — a relative
    // new URL(path, base) resolution would drop it.
    const url = new URL(`${this.baseUrl}${endpoint.path}`);
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

  private log(rec: ShiprocketCallRecord): void {
    this.requestLog.push(rec);
  }

  /**
   * One authenticated HTTP call with the §8.2 error classification. On 401
   * the cached token is dropped, a fresh one minted, and the request resent
   * exactly once; a second 401 (or a failed login) is CourierAuthError
   * (→ DISCONNECTED, §3.21).
   */
  private async call(
    method: AdapterMethod,
    endpoint: EndpointSpec,
    init: { query?: Record<string, string>; body?: string; accept?: string },
  ): Promise<unknown> {
    let token = await this.ensureToken(method);
    for (let attempt = 0; attempt < 2; attempt++) {
      // baseUrl carries the /v1/external prefix, so concatenate — a
      // relative new URL(path, base) resolution would drop it.
      const url = new URL(`${this.baseUrl}${endpoint.path}`);
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
  // nested service identity (§15.1, §9.3.4 AGGREGATOR)
  // ------------------------------------------------------------------

  /** The chosen Shiprocket courier_id for a Jsyxi Service: exact
   *  serviceId/service-code key first, then the account default. */
  private resolveNestedCourierId(serviceKey: string | null): string | null {
    if (serviceKey) {
      const direct = this.courierMap[serviceKey];
      if (direct) return direct;
    }
    return this.courierMap.default ?? null;
  }

  /** Shiprocket's pickup/label surfaces key on shipment_id, not AWB;
   *  resolve via the booking registry, then the track payload. */
  private async resolveShipmentId(awb: string): Promise<string> {
    const known = this.bookingsByAwb.get(awb);
    if (known?.shipmentId) return known.shipmentId;
    const body = await this.call(
      'track',
      {
        ...SHIPROCKET_ENDPOINTS.trackByAwb,
        path: buildTrackByAwbPath(awb),
      },
      {},
    );
    const parsed = parseTrackResponse(body);
    if (!parsed) {
      throw new CourierProviderError(this.courierCode, 'AWB_NOT_FOUND');
    }
    if (parsed.shipmentId) {
      this.bookingsByAwb.set(awb, {
        orderId: known?.orderId ?? null,
        shipmentId: parsed.shipmentId,
        awb,
      });
      return parsed.shipmentId;
    }
    throw new CourierProviderError(this.courierCode, 'SHIPMENT_ID_UNRESOLVED');
  }

  // ------------------------------------------------------------------
  // §8.2 getQuote (§8.3) — LIVE_QUOTE via /courier/serviceability (A2-02)
  // ------------------------------------------------------------------

  async getQuote(request: QuoteRequest): Promise<QuoteResponse> {
    this.log({ method: 'getQuote', at: this.now().toISOString() });
    const fetchedAt = this.now().toISOString();

    const body = await this.call('getQuote', SHIPROCKET_ENDPOINTS.serviceability, {
      query: buildServiceabilityQuery({
        originPincode: request.originPincode,
        destinationPincode: request.destinationPincode,
        deadWeightKg: request.deadWeightKg,
        paymentMode: request.paymentMode,
        collectible: request.collectible,
      }),
    });
    const parsed = parseServiceabilityResponse(body);

    if (!parsed.serviceable) {
      return {
        serviceable: false,
        failureReasons: parsed.failureReasons,
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
        capabilityFlags: [],
      };
    }

    // §15.1 nested identities: the quote is for the ONE nested courier the
    // Jsyxi Service maps to — never an arbitrary courier from the offer.
    const wantedId = this.resolveNestedCourierId(request.serviceId);
    const selected = wantedId
      ? parsed.couriers.find((c) => c.courierId === wantedId)
      : undefined;

    if (!selected) {
      // Lane serviceable, but the mapped nested courier is not configured
      // or not offered on this lane: no rate, never a substituted one.
      return {
        serviceable: true,
        failureReasons: ['SERVICE_NOT_MAPPED'],
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
        capabilityFlags: [],
      };
    }

    const capabilityFlags: string[] = ['PREPAID'];
    if (selected.codSupported) capabilityFlags.push('COD');

    // Components from the provider's charge breakup (INV-15 exact text;
    // INV-23 unmarked). FREIGHT falls back to the headline rate when no
    // breakup is exposed.
    const components: QuoteComponent[] = [];
    const freight = selected.freight ?? selected.rate;
    if (freight) {
      components.push({ code: 'FREIGHT', label: 'Forward freight', amount: freight, taxable: true });
    }
    if (selected.codCharges && money2dpToPaise(selected.codCharges) > 0) {
      components.push({
        code: 'COD_CHARGE',
        label: 'COD charge',
        amount: selected.codCharges,
        taxable: false,
      });
    }
    if (selected.otherCharges && money2dpToPaise(selected.otherCharges) > 0) {
      components.push({
        code: 'OTHER_CHARGES',
        label: 'Other charges',
        amount: selected.otherCharges,
        taxable: true,
      });
    }

    const rateAvailable = components.length > 0;
    // INV-15: the total is exactly the sum of the stored components.
    const totalPaise = components.reduce((acc, c) => acc + money2dpToPaise(c.amount), 0);
    const eddTo = parseProviderDateTime(selected.etd)?.slice(0, 10) ?? null;

    return {
      serviceable: true,
      failureReasons: [],
      rateAvailable,
      components,
      total: rateAvailable ? paiseToMoney2dp(totalPaise) : '0.00',
      currency: 'INR',
      // §8.3 / §4.4: Shiprocket charges return freight; rto_charges maps
      // into the rto_rule when exposed, else null (F-12 owns the rest).
      rtoRule: rtoRuleFromCharges(selected.rtoCharges, freight),
      eddFrom: null,
      eddTo,
      eddSource: eddTo ? 'PROVIDER' : null,
      fetchedAt,
      // TODO(sandbox-verify): Shiprocket returns no quote id; the synthetic
      // ref records WHICH nested courier this price belongs to (A2-02).
      providerQuoteRef: `SR-Q-${selected.courierId}`,
      capabilityFlags,
    };
  }

  // ------------------------------------------------------------------
  // §8.2 createShipment — exactly-once (A1-04, INV-5, §9.5.4), two-step:
  // order create (order_id = merchant reference) → AWB assign with the
  // chosen nested courier_id (§15.1 nested service identities)
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
      // The chosen nested courier (§15.1): the booked Service's mapping
      // first, then the account default (CreateShipmentRequest.serviceId is
      // threaded from the frozen snapshot, INV-8).
      const courierId = this.resolveNestedCourierId(request.serviceId || null);
      if (!courierId) {
        outcome = {
          kind: 'FAILED',
          awb: null,
          confirmedCharge: null,
          failureReasons: ['SERVICE_NOT_MAPPED'],
        };
        this.createsByIntent.set(intent.bookingIntentId, outcome);
        return outcome;
      }

      // Step 1: create the order (keyed by the merchant reference).
      const createdBody = await this.call('createShipment', SHIPROCKET_ENDPOINTS.createOrder, {
        body: buildCreateOrderBody({
          merchantReference: intent.merchantReference,
          orderDate: shiprocketOrderDate(this.now()),
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
      const created = parseCreateOrderResponse(createdBody);
      if (!created.success) {
        outcome = {
          kind: 'FAILED',
          awb: null,
          confirmedCharge: null,
          failureReasons: created.failureReasons,
        };
        this.createsByIntent.set(intent.bookingIntentId, outcome);
        return outcome;
      }

      // Step 2: assign the AWB with the chosen nested courier_id.
      const assignedBody = await this.call('createShipment', SHIPROCKET_ENDPOINTS.assignAwb, {
        body: buildAssignAwbBody(created.shipmentId!, courierId),
      });
      const assigned = parseAssignAwbResponse(assignedBody);
      if (assigned.success && assigned.awb) {
        this.bookingsByAwb.set(assigned.awb, {
          orderId: created.orderId,
          shipmentId: created.shipmentId,
          awb: assigned.awb,
        });
        outcome = {
          kind: 'CONFIRMED',
          awb: assigned.awb,
          // §3.25: PROVIDER_CONFIRMED_CHARGE when the provider returns one.
          confirmedCharge: assigned.confirmedCharge,
          failureReasons: [],
        };
      } else {
        outcome = {
          kind: 'FAILED',
          awb: null,
          confirmedCharge: null,
          failureReasons: assigned.failureReasons,
        };
      }
    } catch (err) {
      if (err instanceof AdapterTimeoutError) {
        // §9.5.4 / INV-5: a create timeout (either step) is OUTCOME_UNKNOWN
        // and is NEVER retried — lookupByReference resolves it.
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
    const body = await this.call('lookupByReference', SHIPROCKET_ENDPOINTS.ordersSearch, {
      query: buildOrdersSearchQuery(merchantReference),
    });
    const parsed = parseOrdersSearchResponse(body, merchantReference);
    if (parsed.found && parsed.awb) {
      this.bookingsByAwb.set(parsed.awb, {
        orderId: parsed.orderId,
        shipmentId: parsed.shipmentId,
        awb: parsed.awb,
      });
      return { found: true, awb: parsed.awb };
    }
    return { found: false, awb: null };
  }

  // ------------------------------------------------------------------
  // §8.2 cancelShipment
  // ------------------------------------------------------------------

  async cancelShipment(awb: string): Promise<CancelShipmentResult> {
    this.log({ method: 'cancelShipment', at: this.now().toISOString(), awb });
    try {
      const body = await this.call('cancelShipment', SHIPROCKET_ENDPOINTS.cancelByAwbs, {
        body: buildCancelByAwbsBody([awb]),
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
    const body = await this.call(
      'track',
      {
        ...SHIPROCKET_ENDPOINTS.trackByAwb,
        path: buildTrackByAwbPath(awb),
      },
      {},
    );
    const parsed = parseTrackResponse(body);
    if (!parsed) {
      throw new CourierProviderError(this.courierCode, 'AWB_NOT_FOUND');
    }
    if (parsed.shipmentId) {
      const known = this.bookingsByAwb.get(awb);
      this.bookingsByAwb.set(awb, {
        orderId: known?.orderId ?? null,
        shipmentId: parsed.shipmentId,
        awb,
      });
    }
    // Raw status text passes through; normalization happens against
    // courier_status_map (§3.6), not in the adapter (A2-06).
    return parsed.events.map((event) => ({
      rawStatus: event.rawStatus,
      occurredAt: event.occurredAt ?? this.now().toISOString(),
      locationText: event.locationText,
      reasonText: event.reasonText,
      // §8.5 dedupe prefers the provider event ID; absent, it falls back to
      // the canonical fingerprint.
      providerEventId: event.providerEventId,
    }));
  }

  // ------------------------------------------------------------------
  // §8.2 getLabel — generate → download the courier PDF
  // (label_mode CUSTOM_ALLOWED, §9.9.1: custom labels are allowed for the
  // aggregator's services; the courier PDF is still offered here)
  // ------------------------------------------------------------------

  async getLabel(awb: string, format: 'PDF'): Promise<LabelResult> {
    this.log({ method: 'getLabel', at: this.now().toISOString(), awb });
    if (format !== 'PDF') {
      throw new CourierProviderError(this.courierCode, 'FORMAT_UNSUPPORTED');
    }
    const shipmentId = await this.resolveShipmentId(awb);
    const body = await this.call('getLabel', SHIPROCKET_ENDPOINTS.generateLabel, {
      body: buildGenerateLabelBody([shipmentId]),
    });
    const { labelUrl } = parseGenerateLabelResponse(body);
    if (!labelUrl) {
      throw new CourierProviderError(this.courierCode, 'LABEL_NOT_GENERATED');
    }
    // TODO(sandbox-verify): label_url is a pre-signed download needing no
    // auth header; fetched with the same timeout discipline.
    let res: Response;
    try {
      res = await this.fetchFn(labelUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(SHIPROCKET_ENDPOINTS.labelDownload.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new AdapterTimeoutError(this.courierCode, 'getLabel');
      }
      throw new CourierProviderError(this.courierCode, 'TRANSPORT_ERROR');
    }
    if (!res.ok) {
      throw new CourierProviderError(this.courierCode, 'LABEL_DOWNLOAD_FAILED');
    }
    return { contentType: 'application/pdf', bytes: Buffer.from(await res.arrayBuffer()) };
  }

  // ------------------------------------------------------------------
  // §8.2 schedulePickup
  // ------------------------------------------------------------------

  async schedulePickup(request: PickupRequest): Promise<PickupResult> {
    this.log({ method: 'schedulePickup', at: this.now().toISOString() });
    if (request.awbs.length === 0) {
      throw new CourierProviderError(this.courierCode, 'NO_AWBS');
    }
    const shipmentIds: string[] = [];
    for (const awb of request.awbs) {
      shipmentIds.push(await this.resolveShipmentId(awb));
    }
    const body = await this.call('schedulePickup', SHIPROCKET_ENDPOINTS.generatePickup, {
      body: buildPickupBody(shipmentIds),
    });
    const parsed = parsePickupResponse(body);
    if (!parsed.accepted) {
      throw new CourierProviderError(this.courierCode, parsed.reason ?? 'PICKUP_REJECTED');
    }
    return { acknowledged: true, providerPickupId: parsed.id };
  }

  // ------------------------------------------------------------------
  // §8.2 ndrAction — DECLARED UNSUPPORTED (A1-03). Shiprocket's NDR action
  // API (best-known /courier/ndr/action) is not externally verified at v1;
  // the manual fallback is the Shiprocket panel. Never a silent no-op.
  // ------------------------------------------------------------------

  async ndrAction(request: NdrActionRequest): Promise<NdrActionResult> {
    this.log({ method: 'ndrAction', at: this.now().toISOString(), awb: request.awb });
    throw new UnsupportedCapabilityError(this.courierCode, 'ndrAction', SHIPROCKET_NDR_FALLBACK_NOTE);
  }
}

/** Shiprocket's order_date format: 'YYYY-MM-DD HH:mm' (TODO(sandbox-verify)). */
function shiprocketOrderDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * PROPOSAL (framework change, not made here): AdapterBuildContext carries
 * no cache handle, so the factory falls back to a lazily shared ioredis
 * client resolved from REDIS_URL exactly like configuration.ts /
 * redis.module.ts. The Nest module wires the real REDIS token through
 * createShiprocketAdapterFactory; this fallback exists for direct
 * construction (tests inject their own cache).
 */
let sharedRedis: Redis | null = null;
function defaultRedis(): Redis {
  if (!sharedRedis) {
    sharedRedis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
  }
  return sharedRedis;
}

/** Parse the non-secret courier-map credential field (INV-18: config, not
 *  a secret). Malformed JSON is a configuration error, named by field. */
function parseCourierMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CourierProviderError(SHIPROCKET_COURIER_CODE, 'COURIER_MAP_INVALID');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CourierProviderError(SHIPROCKET_COURIER_CODE, 'COURIER_MAP_INVALID');
  }
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) map[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) map[k] = String(v);
  }
  return map;
}

/**
 * AdapterFactory for the registry (§9.3.4), built by the Nest module with
 * the global REDIS token cache (same pattern as the Blue Dart module).
 * Reads the KEY_PASTE credentials (`email` + `password`, both secret) plus
 * the non-secret `shiprocket_courier_map` JSON (nested-identity mapping).
 * The plaintext credentials are captured inside the instance and never
 * logged or re-emitted (§5.7 control 1, INV-18).
 */
export const createShiprocketAdapterFactory =
  (tokenCache: ShiprocketTokenCache): AdapterFactory =>
  (ctx: AdapterBuildContext) => {
    const email = ctx.credentials.email;
    const password = ctx.credentials.password;
    if (typeof email !== 'string' || email.length === 0) {
      // Names the missing field, never a value (INV-18).
      throw new CourierAuthError(ctx.courierCode, `${ctx.courierCode}: missing credential email`);
    }
    if (typeof password !== 'string' || password.length === 0) {
      throw new CourierAuthError(ctx.courierCode, `${ctx.courierCode}: missing credential password`);
    }
    return new ShiprocketAdapter({
      courierAccountId: ctx.courierAccountId,
      pickupCode:
        typeof ctx.credentials.pickup_code === 'string' && ctx.credentials.pickup_code
          ? ctx.credentials.pickup_code
          : undefined,
      courierCode: ctx.courierCode,
      mode: ctx.mode,
      email,
      password,
      courierMap: parseCourierMap(ctx.credentials[SHIPROCKET_COURIER_MAP_KEY]),
      tokenCache,
      now: ctx.now,
    });
  };
