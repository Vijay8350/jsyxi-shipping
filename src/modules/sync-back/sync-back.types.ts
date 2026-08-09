/**
 * Types for the Shopify sync-back outbox (§2.8 sync_outbox, §3.17 SYNC_STATE,
 * §8.4). Values mirror migration 0008 enums exactly.
 */

/** §3.31 sync_outbox.operation. */
export type SyncOperation =
  | 'CREATE_FULFILLMENT'
  | 'ADD_FULFILLMENT_EVENT'
  | 'CANCEL_FULFILLMENT'
  | 'SET_ORDER_TAGS';

/** §3.17 SYNC_STATE (machine E). */
export type SyncState = 'PENDING' | 'IN_FLIGHT' | 'SUCCEEDED' | 'RETRYING' | 'DEAD';

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

/**
 * One allocated line's fulfillment-order mapping (§8.4: the payload carries
 * the fulfillment-order line mapping from the allocation). Line GIDs come
 * from the frozen booking snapshot (INV-8).
 */
export interface FulfillmentOrderLineMapping {
  fulfillmentOrderGid: string;
  lines: Array<{ shopifyLineGid: string; quantity: number }>;
}

/** CREATE_FULFILLMENT payload (§8.4 fulfillment payload). */
export interface CreateFulfillmentPayload {
  shopifyOrderGid: string;
  awb: string;
  courierName: string;
  serviceName: string;
  /** §8.4: Track-Order page URL when S-37 is on, else the courier's own URL. */
  trackingUrl: string | null;
  /** S-9. */
  notifyCustomer: boolean;
  lineItemsByFulfillmentOrder: FulfillmentOrderLineMapping[];
  /** Written back by the worker on success; read by CANCEL/EVENT execution. */
  fulfillmentGid?: string;
}

/** ADD_FULFILLMENT_EVENT payload (§8.4 constant mapping, A3-06). */
export interface AddFulfillmentEventPayload {
  carrierEventStatus: CarrierEventStatus;
  /** Shopify-side status, from the §8.4 constant mapping. */
  shopifyStatus: string;
  /** §8.4: the exact Jsyxi status MUST be in the message text. */
  message: string;
  /** Best-known fulfillment GID at enqueue; the worker re-resolves at run time. */
  fulfillmentGid: string | null;
}

/** CANCEL_FULFILLMENT payload. */
export interface CancelFulfillmentPayload {
  shopifyOrderGid: string;
  fulfillmentGid: string | null;
}

/** SET_ORDER_TAGS payload (§8.4 optional order tags). */
export interface SetOrderTagsPayload {
  shopifyOrderGid: string;
  tags: string[];
}

export type SyncPayload =
  | CreateFulfillmentPayload
  | AddFulfillmentEventPayload
  | CancelFulfillmentPayload
  | SetOrderTagsPayload;

/** A sync_outbox row as the worker reads it. */
export interface SyncOutboxRow {
  outbox_id: string;
  shop_id: string;
  order_id: string;
  shipment_id: string | null;
  operation: SyncOperation;
  payload: SyncPayload;
  state: SyncState;
  attempts: number;
  next_attempt_at: string | Date;
  idempotency_key: string;
  version: number;
}
