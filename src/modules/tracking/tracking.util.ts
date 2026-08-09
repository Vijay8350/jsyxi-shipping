import { createHash } from 'node:crypto';
import type { CanonicalTrackEvent } from './tracking.types';

/**
 * Pure helpers for the tracking engine. No I/O — directly unit-testable.
 */

/** F-19 · AWB normalization: trim → strip whitespace and hyphens → upper-case. */
export function normalizeAwb(awb: string): string {
  return awb.trim().replace(/[\s-]+/g, '').toUpperCase();
}

/** courier_status_map.raw_status is stored case-folded (migration 0006). */
export function foldRawStatus(rawStatus: string): string {
  return rawStatus.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * §8.5 dedupe, raw layer: prefer the provider's event ID; otherwise the
 * canonical fingerprint — raw status + normalized occurred-at + location +
 * reason, scoped by shop + courier account + normalized AWB (A1-10).
 */
export function rawDedupeHash(input: {
  shopId: string;
  courierAccountId: string | null;
  awbNormalized: string;
  event: Omit<CanonicalTrackEvent, 'awb'>;
}): string {
  const { event } = input;
  if (event.providerEventId) {
    return `pid:${input.shopId}:${event.providerEventId}`;
  }
  const canonical = [
    input.shopId,
    input.courierAccountId ?? '',
    input.awbNormalized,
    foldRawStatus(event.rawStatus),
    normalizeOccurredAt(event.occurredAt) ?? '',
    foldText(event.locationText),
    foldText(event.reasonText),
  ].join('|');
  return `fp:${sha256Hex(canonical)}`;
}

/**
 * §2.5 / §8.5 dedupe, normalized layer: the dedupe_key stored on
 * tracking_event — provider_event_id else the fingerprint computed within
 * the resolved Shipment.
 */
export function eventDedupeKey(input: {
  shipmentId: string;
  event: Omit<CanonicalTrackEvent, 'awb'>;
}): string {
  const { event } = input;
  if (event.providerEventId) return `pid:${event.providerEventId}`;
  const canonical = [
    input.shipmentId,
    foldRawStatus(event.rawStatus),
    normalizeOccurredAt(event.occurredAt) ?? '',
    foldText(event.locationText),
    foldText(event.reasonText),
  ].join('|');
  return `fp:${sha256Hex(canonical)}`;
}

/** §5.2: instants in UTC; invalid input is null, never a guessed date. */
export function normalizeOccurredAt(value: string): string | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function foldText(value: string | null): string {
  return (value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/* ---------------------------------------------------------------------------
 * Webhook payload extraction (§8.5). Courier payload shapes differ; the
 * canonical keys are tried first, then common aliases. Extraction never
 * guesses: a payload without an AWB and a status cannot be extracted and the
 * caller quarantines it (INV-20) instead of dropping it.
 * ------------------------------------------------------------------------- */

const AWB_KEYS = ['awb', 'awb_number', 'awbNumber', 'waybill', 'tracking_number', 'trackingNumber'];
const STATUS_KEYS = ['status', 'raw_status', 'rawStatus', 'scan_status', 'status_text', 'current_status'];
const OCCURRED_KEYS = ['occurredAt', 'occurred_at', 'timestamp', 'event_time', 'scan_datetime', 'status_datetime'];
const EVENT_ID_KEYS = ['providerEventId', 'provider_event_id', 'event_id', 'eventId', 'scan_id'];
const LOCATION_KEYS = ['location', 'locationText', 'location_text', 'scan_location', 'city'];
const REASON_KEYS = ['reason', 'reasonText', 'reason_text', 'remarks', 'ndr_reason'];

function pick(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/**
 * Extract the canonical event from a raw courier payload. Returns null when
 * the payload has no usable AWB or status — the caller stores the raw row and
 * marks it AWB_QUARANTINED (INV-20: surfaced, never silently dropped).
 */
export function extractTrackEvent(payload: unknown): CanonicalTrackEvent | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  const awb = pick(obj, AWB_KEYS);
  const rawStatus = pick(obj, STATUS_KEYS);
  if (!awb || !rawStatus) return null;
  const occurredRaw = pick(obj, OCCURRED_KEYS);
  return {
    awb,
    rawStatus,
    // Missing/unparseable occurred-at falls back to ingest time upstream;
    // normalizeOccurredAt returns null for garbage and the caller substitutes.
    occurredAt: occurredRaw ?? '',
    locationText: pick(obj, LOCATION_KEYS),
    reasonText: pick(obj, REASON_KEYS),
    providerEventId: pick(obj, EVENT_ID_KEYS),
  };
}

/* ---------------------------------------------------------------------------
 * ADD-18 masking (INV-18, §5.7 control 4): the raw payload jsonb is courier
 * data and may carry recipient PII; the payload viewer must never render it
 * raw. Phone/email/address-looking fields are masked before display.
 * ------------------------------------------------------------------------- */

const PHONE_KEY = /phone|mobile|telephone|contact_?number/i;
const EMAIL_KEY = /e-?mail/i;
const ADDRESS_KEY = /address|addr|street|landmark|locality|recipient|customer_?name|consignee|^\s*name\s*$/i;

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `${digits.slice(0, 2)}${'*'.repeat(Math.max(digits.length - 4, 2))}${digits.slice(-2)}`;
}

function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at <= 0) return '***';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const domHead = domain.slice(0, 1);
  return `${local.slice(0, 1)}***@${domHead}***`;
}

/** Mask one payload value by key name; recurses into objects and arrays. */
export function maskPayload(value: unknown, key = '', depth = 0): unknown {
  if (depth > 8) return '[masked]';
  if (Array.isArray(value)) {
    return value.map((v) => maskPayload(v, key, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskPayload(v, k, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (PHONE_KEY.test(key)) return maskPhone(value);
    if (EMAIL_KEY.test(key)) return maskEmail(value);
    if (ADDRESS_KEY.test(key)) return '[masked]';
    return value;
  }
  if (typeof value === 'number' && PHONE_KEY.test(key)) return maskPhone(String(value));
  return value;
}
