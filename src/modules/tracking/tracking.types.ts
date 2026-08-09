/**
 * Tracking engine types (§2.5, §3.4, §3.6, §8.5, §9.7). Value lists mirror
 * the spec enums verbatim (RV-07); the PG enums live in migrations 0006/0010.
 */

/** §3.6 CARRIER_EVENT_STATUS — the only mapping target (A2-06). */
export type CarrierEventStatus =
  | 'PICKUP_SCHEDULED'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'UNDELIVERED_ATTEMPT'
  | 'RTO_INITIATED'
  | 'RTO_IN_TRANSIT'
  | 'RTO_OUT_FOR_DELIVERY'
  | 'RTO_DELIVERED'
  | 'LOST_OR_DAMAGED'
  | 'CANCELLED_BY_COURIER';

/** §3.4 MOVEMENT_STATE (machine D). */
export type MovementState =
  | 'NOT_SHIPPED'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'NDR'
  | 'DELIVERED'
  | 'RTO_INITIATED'
  | 'RTO_IN_TRANSIT'
  | 'RTO_OUT_FOR_DELIVERY'
  | 'RTO_DELIVERED'
  | 'LOST_OR_DAMAGED'
  | 'CANCELLED_BY_COURIER';

/** §3.3 CUSTODY_STATE (machine C). */
export type CustodyState =
  | 'NOT_APPLICABLE'
  | 'PICKUP_PENDING'
  | 'PICKUP_SCHEDULED'
  | 'IN_CUSTODY'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'CANCEL_REJECTED';

/** §3.31 tracking_event_raw.source. */
export type TrackingSource = 'WEBHOOK' | 'POLL';

/** ADD-18 parse result on tracking_event_raw (migration 0010). */
export type TrackingParseResult =
  | 'PENDING'
  | 'ACCEPTED'
  | 'DUPLICATE'
  | 'UNMAPPED_STATUS'
  | 'SIGNATURE_FAILURE'
  | 'AWB_QUARANTINED';

/**
 * The canonical event shape every source is reduced to before normalization.
 * Webhook payloads are extracted into this (tolerant aliasing, §8.5); adapter
 * `track(awb)` results (§8.2) already carry these fields and are re-serialized
 * into the same canonical payload so one extraction path serves both sources.
 */
export interface CanonicalTrackEvent {
  awb: string;
  rawStatus: string;
  /** ISO 8601 instant (§5.2: occurred-at stored in UTC). */
  occurredAt: string;
  locationText: string | null;
  reasonText: string | null;
  providerEventId: string | null;
}

/** tracking_event_raw row as the ingest pipeline reads it. */
export interface RawEventRow {
  raw_event_id: string;
  shop_id: string;
  courier_account_id: string | null;
  awb_normalized: string | null;
  payload: unknown;
  received_at: string;
  source: TrackingSource;
  signature_valid: boolean;
  dedupe_hash: string | null;
  parse_result: TrackingParseResult;
}

/** What ingestVerifiedWebhook returns to the caller (the webhook tier). */
export interface IngestResult {
  rawEventId: string;
  parseResult: TrackingParseResult;
  /** True when the row is new and was queued for normalization. */
  queued: boolean;
}

/** Outcome of processRawEvent — also the replay result (ADD-18). */
export interface ProcessResult {
  rawEventId: string;
  parseResult: TrackingParseResult;
  shipmentId: string | null;
  eventId: string | null;
  carrierEventStatus: CarrierEventStatus | null;
  /** Reducer outcome when a mapped event reached the reducer. */
  stateChanged: boolean;
  reviewFlag: boolean;
}
