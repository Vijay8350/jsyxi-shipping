import type { CarrierEventStatus } from './sync-back.types';

/**
 * §8.4 / A3-06: the mapping from CARRIER_EVENT_STATUS to Shopify's accepted
 * fulfillment-event statuses is a SHIPPED CONSTANT, not configuration. There
 * is deliberately no settings key, no DB table and no override path for this
 * table. (Verified against the Shopify FulfillmentEventStatus enum for the
 * pinned 2025-01 Admin API — spec §8.4 week-0 verification.)
 *
 * The §8.4 table, transcribed exactly:
 *
 *   PICKUP_SCHEDULED, PICKED_UP                      → confirmed / in-transit equivalent
 *   IN_TRANSIT                                       → in transit
 *   OUT_FOR_DELIVERY                                 → out for delivery
 *   DELIVERED                                        → delivered
 *   UNDELIVERED_ATTEMPT                              → attempted delivery
 *   RTO_INITIATED, RTO_IN_TRANSIT, RTO_OUT_FOR_DELIVERY,
 *   RTO_DELIVERED, LOST_OR_DAMAGED, CANCELLED_BY_COURIER → failure
 *
 * Because six values collapse onto `failure`, the exact Jsyxi status MUST be
 * written into the event's message text (§8.4) so the Shopify timeline stays
 * readable — see fulfillmentEventMessage().
 */
export type ShopifyFulfillmentEventStatus =
  | 'CONFIRMED'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'ATTEMPTED_DELIVERY'
  | 'FAILURE';

export const CARRIER_EVENT_TO_SHOPIFY: Readonly<
  Record<CarrierEventStatus, ShopifyFulfillmentEventStatus>
> = Object.freeze({
  PICKUP_SCHEDULED: 'CONFIRMED', // §8.4: confirmed / in-transit equivalent
  PICKED_UP: 'CONFIRMED', // §8.4: confirmed / in-transit equivalent
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  UNDELIVERED_ATTEMPT: 'ATTEMPTED_DELIVERY',
  RTO_INITIATED: 'FAILURE',
  RTO_IN_TRANSIT: 'FAILURE',
  RTO_OUT_FOR_DELIVERY: 'FAILURE',
  RTO_DELIVERED: 'FAILURE',
  LOST_OR_DAMAGED: 'FAILURE',
  CANCELLED_BY_COURIER: 'FAILURE',
});

export function mapCarrierEventToShopify(
  status: CarrierEventStatus,
): ShopifyFulfillmentEventStatus {
  return CARRIER_EVENT_TO_SHOPIFY[status];
}

/**
 * §8.4: the event message text always carries the exact Jsyxi
 * CARRIER_EVENT_STATUS so statuses collapsed onto `failure` stay readable on
 * the Shopify timeline.
 */
export function fulfillmentEventMessage(status: CarrierEventStatus): string {
  return status;
}
