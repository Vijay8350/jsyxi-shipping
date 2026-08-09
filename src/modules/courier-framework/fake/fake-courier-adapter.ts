import { createHash } from 'node:crypto';
import {
  AdapterMethod,
  CancelShipmentResult,
  CourierAdapter,
  CreateShipmentRequest,
  CreateShipmentResult,
  LabelResult,
  LookupByReferenceResult,
  NdrActionRequest,
  NdrActionResult,
  NdrActionType,
  PickupRequest,
  PickupResult,
  QuoteRequest,
  QuoteResponse,
  TrackEvent,
  UnsupportedCapabilityError,
} from '../adapter.types';
import {
  AdapterRateLimitError,
  CourierAuthError,
  CourierProviderError,
} from '../adapter-errors';
import { TestEventCapableAdapter, TestWebhookEvent } from '../test-event';

/**
 * The deterministic fake courier adapter (§15.1). Same inputs → same
 * outputs: no randomness, no clock dependence beyond the injected now().
 * Behavior is scriptable through FakeCourierProfile so the contract suite
 * (and adapter developers) can exercise every §15.1 row: serviceability,
 * booking, ambiguous create timeouts, labels, pickups, cancels, tracking,
 * NDR, unsupported capabilities, rate limiting and idempotency under retry.
 *
 * Conventions the contract suite relies on (see test/courier-framework/
 * contract-suite.ts):
 * - destinations beginning '999999' are unserviceable by default;
 * - bookingIntentIds beginning 'contract-timeout-' return OUTCOME_UNKNOWN
 *   while still recording the create, so lookupByReference resolves them;
 * - `unsupportedMethods` declares capabilities that throw
 *   UnsupportedCapabilityError (A1-03 — never a silent no-op);
 * - `requestLog` records every received call, with `deduplicated: true` on
 *   a retried intent — the idempotency assertion (A1-04, INV-5).
 */

export interface FakeCourierProfile {
  courierCode?: string;
  /** If set, only destinations starting with one of these prefixes are
   *  serviceable. Default: everything except the '999999' convention. */
  serviceableDestinationPrefixes?: string[];
  /** Structured failure codes for unserviceable quotes (§8.3). */
  unserviceableReasons?: string[];
  /** When false, COD quotes are unserviceable with COD_NOT_SERVICEABLE. */
  codServiceable?: boolean;
  /** bookingIntentIds (exact, or prefix ending in '*') whose create returns
   *  OUTCOME_UNKNOWN while recording the create (INV-5 exercise). Default:
   *  the 'contract-timeout-' prefix. */
  timeoutOnCreateIntents?: string[];
  /** When true every call throws CourierAuthError → DISCONNECTED (§3.21). */
  failAuth?: boolean;
  /** Max getQuote calls before AdapterRateLimitError (§15.1 rate limiting). */
  quoteRateLimit?: number;
  /** NDR action types the fake rejects. */
  ndrRejectActions?: NdrActionType[];
  /** Fixed tracking script returned by track(); default derives from now(). */
  trackingScript?: TrackEvent[];
  /** Declared-unsupported capabilities (A1-03). */
  unsupportedMethods?: AdapterMethod[];
  /** AWB prefix; default 'FAKE'. */
  awbPrefix?: string;
}

export interface FakeAdapterCallRecord {
  method: AdapterMethod;
  at: string;
  bookingIntentId?: string;
  merchantReference?: string;
  awb?: string;
  /** A1-04: a retry of an already-recorded intent — no second create. */
  deduplicated?: boolean;
}

interface FakeBooking {
  awb: string;
  bookingIntentId: string;
  merchantReference: string;
  cancelled: boolean;
  pickupScheduled: boolean;
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Exact decimal text → integer minor units (never floats; INV-15). */
function parseUnits(text: string, scale: number): number {
  const neg = text.startsWith('-');
  const [whole, frac = ''] = (neg ? text.slice(1) : text).split('.');
  const padded = (frac + '0'.repeat(scale)).slice(0, scale);
  const v = Number(whole || '0') * 10 ** scale + Number(padded || '0');
  return neg ? -v : v;
}

function format2dp(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export class FakeCourierAdapter implements CourierAdapter, TestEventCapableAdapter {
  readonly courierCode: string;
  readonly unsupportedMethods: AdapterMethod[];
  readonly requestLog: FakeAdapterCallRecord[] = [];

  private readonly profile: Required<
    Pick<FakeCourierProfile, 'unserviceableReasons' | 'codServiceable' | 'awbPrefix'>
  > &
    FakeCourierProfile;
  private readonly now: () => Date;
  private readonly bookings = new Map<string, FakeBooking>(); // by awb
  private readonly byIntent = new Map<string, FakeBooking>();
  private awbSeq = 0;
  private pickupSeq = 0;
  private ndrSeq = 0;
  private quoteCalls = 0;

  constructor(profile: FakeCourierProfile = {}, now: () => Date = () => new Date()) {
    this.profile = {
      unserviceableReasons: ['PINCODE_NOT_SERVICEABLE'],
      codServiceable: true,
      awbPrefix: 'FAKE',
      ...profile,
    };
    this.courierCode = this.profile.courierCode ?? 'FAKE';
    this.unsupportedMethods = this.profile.unsupportedMethods ?? [];
    this.now = now;
  }

  // ----------------------------------------------------------------
  // guards
  // ----------------------------------------------------------------

  private guard(method: AdapterMethod): void {
    if (this.profile.failAuth) throw new CourierAuthError(this.courierCode);
    if (this.unsupportedMethods.includes(method)) {
      throw new UnsupportedCapabilityError(
        this.courierCode,
        method,
        'Use the courier panel for this action',
      );
    }
  }

  private log(rec: FakeAdapterCallRecord): void {
    this.requestLog.push(rec);
  }

  private isServiceableDestination(pincode: string): boolean {
    const prefixes = this.profile.serviceableDestinationPrefixes;
    if (prefixes) return prefixes.some((p) => pincode.startsWith(p));
    return !pincode.startsWith('999999');
  }

  private matchesTimeoutIntent(bookingIntentId: string): boolean {
    const patterns = this.profile.timeoutOnCreateIntents ?? ['contract-timeout-*'];
    return patterns.some((p) =>
      p.endsWith('*') ? bookingIntentId.startsWith(p.slice(0, -1)) : bookingIntentId === p,
    );
  }

  /** Deterministic freight in paise from the parcel fields (INV-15-safe). */
  private freightPaise(req: {
    originPincode: string;
    destinationPincode: string;
    deadWeightKg: string;
  }): number {
    const milliKg = parseUnits(req.deadWeightKg, 3);
    const units = Math.max(1, Math.ceil(milliKg / 500)); // 0.5kg steps
    const zoneBump = req.originPincode.slice(0, 2) === req.destinationPincode.slice(0, 2) ? 0 : 500;
    return 4000 + 200 * (units - 1) + zoneBump;
  }

  // ----------------------------------------------------------------
  // §8.2 interface
  // ----------------------------------------------------------------

  async getQuote(request: QuoteRequest): Promise<QuoteResponse> {
    this.guard('getQuote');
    this.quoteCalls += 1;
    this.log({ method: 'getQuote', at: this.now().toISOString() });
    if (this.profile.quoteRateLimit !== undefined && this.quoteCalls > this.profile.quoteRateLimit) {
      throw new AdapterRateLimitError(this.courierCode, 60_000);
    }

    const failureReasons: string[] = [];
    if (!this.isServiceableDestination(request.destinationPincode)) {
      failureReasons.push(...(this.profile.unserviceableReasons ?? ['PINCODE_NOT_SERVICEABLE']));
    }
    if (request.paymentMode === 'COD' && !this.profile.codServiceable) {
      failureReasons.push('COD_NOT_SERVICEABLE');
    }
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
        fetchedAt: this.now().toISOString(),
        providerQuoteRef: null,
        capabilityFlags: [],
      };
    }

    const freight = this.freightPaise(request);
    const components = [
      { code: 'F-5', label: 'Base freight', amount: format2dp(freight), taxable: true },
    ];
    if (request.paymentMode === 'COD') {
      const collectiblePaise = parseUnits(request.collectible, 2);
      const cod = 1500 + Math.floor(collectiblePaise / 100); // ₹15 + 1%
      components.push({ code: 'F-7', label: 'COD charge', amount: format2dp(cod), taxable: false });
    }
    const total = components.reduce((acc, c) => acc + parseUnits(c.amount, 2), 0);
    const ship = new Date(`${request.shipDate}T00:00:00Z`);
    const day = 24 * 3600_000;
    const ref = sha(
      [
        request.courierAccountId,
        request.serviceId,
        request.originPincode,
        request.destinationPincode,
        request.shipDate,
        request.deadWeightKg,
        request.paymentMode,
      ].join('|'),
    );
    return {
      serviceable: true,
      failureReasons: [],
      rateAvailable: true,
      components,
      total: format2dp(total),
      currency: 'INR',
      rtoRule: { basis: 'SAME_AS_FORWARD', pct: null },
      eddFrom: new Date(ship.getTime() + 2 * day).toISOString().slice(0, 10),
      eddTo: new Date(ship.getTime() + 5 * day).toISOString().slice(0, 10),
      eddSource: 'PROVIDER',
      fetchedAt: this.now().toISOString(),
      providerQuoteRef: `FQ-${ref.slice(0, 12).toUpperCase()}`,
      capabilityFlags: ['COD', 'PREPAID'],
    };
  }

  async createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResult> {
    this.guard('createShipment');
    const { intent } = request;

    // A1-04 / INV-5: a retry of an already-recorded intent returns the SAME
    // outcome; no second create is issued.
    const existing = this.byIntent.get(intent.bookingIntentId);
    if (existing) {
      this.log({
        method: 'createShipment',
        at: this.now().toISOString(),
        bookingIntentId: intent.bookingIntentId,
        merchantReference: intent.merchantReference,
        awb: existing.awb,
        deduplicated: true,
      });
      return {
        kind: 'CONFIRMED',
        awb: existing.awb,
        confirmedCharge: format2dp(this.freightPaise(request)),
        failureReasons: [],
      };
    }

    this.awbSeq += 1;
    const awb = `${this.profile.awbPrefix}${String(this.awbSeq).padStart(10, '0')}`;
    const booking: FakeBooking = {
      awb,
      bookingIntentId: intent.bookingIntentId,
      merchantReference: intent.merchantReference,
      cancelled: false,
      pickupScheduled: false,
    };
    this.bookings.set(awb, booking);
    this.byIntent.set(intent.bookingIntentId, booking);
    this.log({
      method: 'createShipment',
      at: this.now().toISOString(),
      bookingIntentId: intent.bookingIntentId,
      merchantReference: intent.merchantReference,
      awb,
    });

    // INV-5 exercise: a scripted timeout — the create IS recorded (so
    // lookupByReference resolves it) but the caller sees OUTCOME_UNKNOWN.
    if (this.matchesTimeoutIntent(intent.bookingIntentId)) {
      return { kind: 'OUTCOME_UNKNOWN', awb: null, confirmedCharge: null, failureReasons: [] };
    }
    return {
      kind: 'CONFIRMED',
      awb,
      confirmedCharge: format2dp(this.freightPaise(request)),
      failureReasons: [],
    };
  }

  async lookupByReference(merchantReference: string): Promise<LookupByReferenceResult> {
    this.guard('lookupByReference');
    this.log({
      method: 'lookupByReference',
      at: this.now().toISOString(),
      merchantReference,
    });
    for (const b of this.bookings.values()) {
      if (b.merchantReference === merchantReference) return { found: true, awb: b.awb };
    }
    return { found: false, awb: null };
  }

  async cancelShipment(awb: string): Promise<CancelShipmentResult> {
    this.guard('cancelShipment');
    this.log({ method: 'cancelShipment', at: this.now().toISOString(), awb });
    const booking = this.bookings.get(awb);
    if (!booking) return { kind: 'REJECTED', reason: 'AWB_NOT_FOUND' };
    if (booking.cancelled) return { kind: 'REJECTED', reason: 'ALREADY_CANCELLED' };
    if (booking.pickupScheduled) return { kind: 'REJECTED', reason: 'ALREADY_PICKED_UP' };
    booking.cancelled = true;
    return { kind: 'CANCELLED', reason: null };
  }

  async track(awb: string): Promise<TrackEvent[]> {
    this.guard('track');
    this.log({ method: 'track', at: this.now().toISOString(), awb });
    if (!this.bookings.has(awb)) {
      throw new CourierProviderError(this.courierCode, 'AWB_NOT_FOUND');
    }
    if (this.profile.trackingScript) return this.profile.trackingScript;
    const base = this.now().getTime();
    const h = 3600_000;
    return [
      {
        rawStatus: 'PICKED_UP',
        occurredAt: new Date(base - 4 * h).toISOString(),
        locationText: 'Origin Hub',
        reasonText: null,
        providerEventId: `FE-${sha(awb).slice(0, 8)}-1`,
      },
      {
        rawStatus: 'IN_TRANSIT',
        occurredAt: new Date(base - 2 * h).toISOString(),
        locationText: 'Regional Hub',
        reasonText: null,
        providerEventId: `FE-${sha(awb).slice(0, 8)}-2`,
      },
      {
        rawStatus: 'OUT_FOR_DELIVERY',
        occurredAt: new Date(base - 1 * h).toISOString(),
        locationText: 'Destination Hub',
        reasonText: null,
        providerEventId: `FE-${sha(awb).slice(0, 8)}-3`,
      },
    ];
  }

  async getLabel(awb: string, format: 'PDF'): Promise<LabelResult> {
    this.guard('getLabel');
    this.log({ method: 'getLabel', at: this.now().toISOString(), awb });
    if (format !== 'PDF') throw new CourierProviderError(this.courierCode, 'FORMAT_UNSUPPORTED');
    if (!this.bookings.has(awb)) {
      throw new CourierProviderError(this.courierCode, 'AWB_NOT_FOUND');
    }
    const bytes = Buffer.from(
      `%PDF-1.4\n% FakeCourier label\n% awb=${awb}\n% digest=${sha(awb).slice(0, 16)}\n%%EOF\n`,
      'utf8',
    );
    return { contentType: 'application/pdf', bytes };
  }

  async schedulePickup(request: PickupRequest): Promise<PickupResult> {
    this.guard('schedulePickup');
    this.log({ method: 'schedulePickup', at: this.now().toISOString() });
    if (request.awbs.length === 0) {
      throw new CourierProviderError(this.courierCode, 'NO_AWBS');
    }
    for (const awb of request.awbs) {
      const b = this.bookings.get(awb);
      if (!b) throw new CourierProviderError(this.courierCode, 'AWB_NOT_FOUND');
      b.pickupScheduled = true;
    }
    this.pickupSeq += 1;
    return {
      acknowledged: true,
      providerPickupId: `FPK-${String(this.pickupSeq).padStart(6, '0')}`,
    };
  }

  async ndrAction(request: NdrActionRequest): Promise<NdrActionResult> {
    this.guard('ndrAction');
    this.log({ method: 'ndrAction', at: this.now().toISOString(), awb: request.awb });
    if (!this.bookings.has(request.awb)) {
      throw new CourierProviderError(this.courierCode, 'AWB_NOT_FOUND');
    }
    if (this.profile.ndrRejectActions?.includes(request.action)) {
      return { accepted: false, providerAck: `REJECTED_${request.action}` };
    }
    this.ndrSeq += 1;
    return { accepted: true, providerAck: `FNDR-${String(this.ndrSeq).padStart(6, '0')}` };
  }

  // ----------------------------------------------------------------
  // ADD-18: send test event
  // ----------------------------------------------------------------

  buildTestWebhookEvent(): TestWebhookEvent {
    const first = this.bookings.values().next().value as FakeBooking | undefined;
    const awb = first?.awb ?? `${this.profile.awbPrefix ?? 'FAKE'}${String(1).padStart(10, '0')}`;
    return {
      payload: {
        event_id: `FE-TEST-${sha(awb).slice(0, 8)}`,
        awb,
        status: 'IN_TRANSIT',
        occurred_at: this.now().toISOString(),
        location: 'Regional Hub',
      },
    };
  }
}
