/**
 * Shared types and constants for the notification layer (spec.md §9.21,
 * INV-21; addendum ADD-25/26/27/28; schema in migration 0014).
 *
 * INV-21 everywhere: no send gates a business action. Every public method on
 * the services in this module is fire-and-observe — it catches its own
 * delivery errors, records them in message_log, and returns a result object
 * instead of throwing (the single stated exception is ADD-27's audited buyer
 * response record, which is a database write, not a message delivery).
 */

export type MessageChannel = 'EMAIL' | 'SMS' | 'WHATSAPP';

export type MessageDeliveryState =
  | 'QUEUED'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED';

/**
 * §9.21 event matrix — event names are the machine contract every caller
 * (courier-framework, booking, tracking, billing, recon, reports, tickets,
 * platform announcements) uses with NotificationService.notify().
 */
export const NOTIFICATION_EVENTS = {
  /** §3.21 credential/token failure → Owner, email + in-app, S-46 throttle. */
  COURIER_DISCONNECTED: 'courier.disconnected',
  /** §9.5.2 batch finished → the actor, in-app; email if offline, immediate. */
  BOOKING_BATCH_COMPLETE: 'booking.batch_complete',
  /** §3.10 NDR received → S-41 recipients, email digest per S-42. */
  NDR_RECEIVED: 'ndr.received',
  /** Pickup not scheduled → Operator, daily email digest. */
  PICKUP_NOT_SCHEDULED: 'pickup.not_scheduled',
  /** S-47 delayed shipment → Operator, daily email digest. */
  SHIPMENT_DELAYED: 'shipment.delayed',
  /** §3.11 allowance at 80% → Owner, email + in-app, immediate. */
  ALLOWANCE_80: 'billing.allowance_80',
  /** §3.11 allowance at 100% → Owner, email + in-app, immediate. */
  ALLOWANCE_100: 'billing.allowance_100',
  /** §3.11 trial ending in 3 days → Owner, email + in-app, immediate. */
  TRIAL_ENDING: 'billing.trial_ending',
  /** §3.28 recon batch with disputes / control_total_state MISMATCH → Finance. */
  RECON_BATCH_DISPUTED: 'recon.batch_disputed',
  /** §11 report ready → the requester, email with an expiring link. */
  REPORT_READY: 'report.ready',
  /** Ticket reply → thread participants, email + in-app, immediate. */
  TICKET_REPLY: 'ticket.reply',
  /** Platform announcement → all Members, in-app unless type WARNING. */
  ANNOUNCEMENT: 'announcement',
  /** §3.24 cod_assignment_state = UNASSIGNED → Owner + Finance daily digest. */
  COD_UNASSIGNED: 'cod.unassigned',
  /** §3.12 invoice issue pending → Owner + Finance daily digest. */
  INVOICE_PENDING: 'invoice.pending',
} as const;

export type NotificationEvent =
  (typeof NOTIFICATION_EVENTS)[keyof typeof NOTIFICATION_EVENTS];

/**
 * In-app inbox convention (no in_app table exists and migrations may not be
 * added — briefed DECISION): an in-app notification is a message_log row with
 * event = IN_APP_EVENT and provider_ref = the recipient member's uuid (an
 * internal id, not PII). channel is 'EMAIL' only because the message_channel
 * enum has no IN_APP value; such rows are NEVER emailed. The rendered text
 * lives on the referenced message_template row (message_log has no body
 * column), created one-per-send with event = IN_APP_EVENT as well.
 */
export const IN_APP_EVENT = 'in_app';

/** Buyer-facing events (ADD-26) — message_template.event values. */
export const BUYER_EVENTS = {
  SHIPPED: 'shipment.shipped',
  OUT_FOR_DELIVERY: 'shipment.out_for_delivery',
  NDR_ATTEMPT: 'shipment.ndr_attempt',
  DELIVERED: 'shipment.delivered',
  RTO_INITIATED: 'shipment.rto_initiated',
  COD_CONFIRMATION_REQUEST: 'cod.confirmation_request',
} as const;

export type BuyerEvent = (typeof BUYER_EVENTS)[keyof typeof BUYER_EVENTS];

/** S-46 (§7): same-event alert throttle — 1 per recipient per hour. */
export const THROTTLE_WINDOW_SECONDS = 3600;

/** ADD-28: the COD confirmation window default (per-shop overridable). */
export const COD_CONFIRM_DEFAULT_WINDOW_MINUTES = 60;

/** Default shop-local hour at which daily digests go out (§5.2). */
export const DEFAULT_DIGEST_HOUR_LOCAL = 9;

/**
 * A member counts as "online" for the booking-batch rule ("email if the
 * actor is offline") when shop_member.last_active_at is within this window.
 */
export const ONLINE_WINDOW_MINUTES = 15;

/** What notify() callers hand over. Never contains raw buyer PII. */
export interface NotifyContext {
  /** booking.batch_complete — the actor. */
  actorMemberId?: string;
  /** report.ready — the requester. */
  requesterMemberId?: string;
  /** ticket.reply — thread participants. */
  participantMemberIds?: string[];
  /** announcement — anything other than 'WARNING' stays in-app only. */
  announcementType?: string;
  subject: string;
  body: string;
  /** Expiring link (report.ready) or action-card target. */
  link?: string;
  shipmentId?: string;
  ndrCaseId?: string;
  /** Digestable line items (digest events only). */
  lines?: string[];
}

export interface NotifyResult {
  delivered: number;
  suppressed: number;
  digested: number;
  skipped: boolean; // S-45 toggle off
}
