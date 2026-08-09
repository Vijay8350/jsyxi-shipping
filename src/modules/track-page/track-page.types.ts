/**
 * Track-Order page types (§9.16, §2.8, §7.6).
 *
 * Two access paths (A1-07, A2-12):
 *  1. Tokenized link — per-Shipment `track_token`, no further verification.
 *  2. Manual lookup — (Order ID or AWB) AND (full normalized email or phone),
 *     one generic failure for every failure mode, throttled per S-38.
 *
 * The page NEVER exposes address, contact data, credentials or order totals
 * (§9.16). The JSON contract below is the whole render model — keep it free
 * of anything outside status / timeline / EDD / courier (S-35) / item summary
 * (S-36).
 */

/** §3.4 MOVEMENT_STATE (from migration 0001/0003). */
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

/** §7.6 S-31–S-37, S-49 — the row shape of track_page_config. */
export interface TrackPageConfigRow {
  shop_id: string;
  order_box_label: string; // S-31
  contact_box_label: string; // S-32
  theme: 'light' | 'dark'; // S-33
  button_colour: string; // S-34
  show_courier_name: boolean; // S-35
  show_item_summary: boolean; // S-36
  replace_tracking_link: boolean; // S-37
  logo_object_key: string | null; // S-49 (null = inherit brand logo)
  version: number;
  created_at: string;
  updated_at: string;
}

export interface TrackPageConfigView {
  shopId: string;
  orderBoxLabel: string;
  contactBoxLabel: string;
  theme: 'light' | 'dark';
  buttonColour: string;
  showCourierName: boolean;
  showItemSummary: boolean;
  replaceTrackingLink: boolean;
  logoObjectKey: string | null;
  version: number;
}

/** §7.6 defaults, duplicated from migration 0010 for the render fallback. */
export const TRACK_PAGE_CONFIG_DEFAULTS: Omit<
  TrackPageConfigView,
  'shopId' | 'version'
> = {
  orderBoxLabel: 'Order ID or AWB number', // S-31
  contactBoxLabel: 'Email or phone used on the order', // S-32
  theme: 'light', // S-33
  buttonColour: '#0F6B6B', // S-34 brand petrol teal
  showCourierName: true, // S-35
  showItemSummary: true, // S-36
  replaceTrackingLink: false, // S-37
  logoObjectKey: null, // S-49: inherit brand logo
};

export function configRowToView(row: TrackPageConfigRow): TrackPageConfigView {
  return {
    shopId: row.shop_id,
    orderBoxLabel: row.order_box_label,
    contactBoxLabel: row.contact_box_label,
    theme: row.theme,
    buttonColour: row.button_colour,
    showCourierName: row.show_courier_name,
    showItemSummary: row.show_item_summary,
    replaceTrackingLink: row.replace_tracking_link,
    logoObjectKey: row.logo_object_key,
    version: row.version,
  };
}

/** One normalized timeline row (§2.5 tracking_event), newest first. */
export interface TrackTimelineEvent {
  status: string | null; // carrier_event_status; null when unmapped (§3.6)
  rawStatus: string;
  occurredAt: string; // ISO 8601
  locationText: string | null;
  reasonText: string | null;
}

/** S-36 item summary — title, variant, quantity, thumbnail only (A1-07). */
export interface TrackItemSummary {
  title: string | null;
  variant: string | null;
  quantity: number;
  /** Always null at v1 — no product image sync exists; do not invent one. */
  thumbnail: null;
}

/** EDD from the snapshot quote (§2.9 expectedQuote); null when no quote. */
export interface TrackEdd {
  from: string | null;
  to: string | null;
  source: string | null;
}

/**
 * The per-shipment page data (§9.16). Deliberately carry no recipient,
 * address, contact, credential or money field — the denylist test asserts
 * none can appear in the serialized response.
 */
export interface TrackShipmentPageData {
  status: MovementState;
  awb: string | null;
  isTest: boolean; // §9.23 persistent test marker
  courierName: string | null; // only when S-35 is on
  edd: TrackEdd | null;
  items: TrackItemSummary[] | null; // only when S-36 is on
  timeline: TrackTimelineEvent[];
}

/** Branding the hosted page and the snippet render with (S-31–S-34, S-49). */
export interface TrackPageBranding {
  theme: 'light' | 'dark';
  buttonColour: string;
  logoObjectKey: string | null;
  orderBoxLabel: string;
  contactBoxLabel: string;
}

/** Tokenized-link JSON (path 1): exactly one shipment, no verification. */
export interface TrackTokenPageView {
  ok: true;
  branding: TrackPageBranding;
  shipment: TrackShipmentPageData;
}

/**
 * Manual-lookup success (path 2): by AWB one shipment; by Order ID EVERY
 * shipment on that order, each with its own timeline (§9.16).
 */
export interface TrackLookupSuccessView {
  ok: true;
  branding: TrackPageBranding;
  shipments: TrackShipmentPageData[];
}

/**
 * The ONE generic failure for every lookup failure mode (§9.16) — same body
 * whether the shop, identifier or contact was wrong. `captchaRequired` is a
 * throttle-state flag (S-38), never information about the identifier.
 */
export interface TrackLookupFailureView {
  ok: false;
  error: string;
  captchaRequired?: boolean;
}

export type TrackLookupView = TrackLookupSuccessView | TrackLookupFailureView;

/** The single generic failure message (§9.16 — no oracle). */
export const LOOKUP_GENERIC_ERROR =
  'We could not find an order matching those details. Please check them and try again.';

/** S-38 throttle numbers (admin settings, applied globally). */
export const LOOKUP_THROTTLE = {
  ipAttempts: 10,
  ipWindowSeconds: 600, // 10 attempts per 10 minutes per IP
  shopAttempts: 30,
  shopWindowSeconds: 3600, // 30 per hour per Shop
  captchaAfterFailures: 5, // CAPTCHA after 5 consecutive failures
} as const;
