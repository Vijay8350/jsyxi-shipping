import { describe, expect, it } from 'vitest';
import {
  CARRIER_EVENT_TO_SHOPIFY,
  fulfillmentEventMessage,
  mapCarrierEventToShopify,
} from '../../src/modules/sync-back/fulfillment-event.map';
import type { CarrierEventStatus } from '../../src/modules/sync-back/sync-back.types';

/**
 * §8.4 / A3-06: the carrier-event → Shopify fulfillment-event mapping is a
 * shipped constant. Every value is asserted one by one, including the rule
 * that the exact Jsyxi status lands in the event message text.
 */

const ALL_STATUSES: CarrierEventStatus[] = [
  'PICKUP_SCHEDULED',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'UNDELIVERED_ATTEMPT',
  'RTO_INITIATED',
  'RTO_IN_TRANSIT',
  'RTO_OUT_FOR_DELIVERY',
  'RTO_DELIVERED',
  'LOST_OR_DAMAGED',
  'CANCELLED_BY_COURIER',
];

describe('§8.4 constant mapping (A3-06)', () => {
  it('covers all 12 CARRIER_EVENT_STATUS values (§3.6)', () => {
    expect(Object.keys(CARRIER_EVENT_TO_SHOPIFY).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it.each([
    ['PICKUP_SCHEDULED', 'CONFIRMED'],
    ['PICKED_UP', 'CONFIRMED'],
    ['IN_TRANSIT', 'IN_TRANSIT'],
    ['OUT_FOR_DELIVERY', 'OUT_FOR_DELIVERY'],
    ['DELIVERED', 'DELIVERED'],
    ['UNDELIVERED_ATTEMPT', 'ATTEMPTED_DELIVERY'],
    ['RTO_INITIATED', 'FAILURE'],
    ['RTO_IN_TRANSIT', 'FAILURE'],
    ['RTO_OUT_FOR_DELIVERY', 'FAILURE'],
    ['RTO_DELIVERED', 'FAILURE'],
    ['LOST_OR_DAMAGED', 'FAILURE'],
    ['CANCELLED_BY_COURIER', 'FAILURE'],
  ] as Array<[CarrierEventStatus, string]>)('%s → %s', (carrier, shopify) => {
    expect(mapCarrierEventToShopify(carrier)).toBe(shopify);
  });

  it.each(ALL_STATUSES)('message text carries the exact Jsyxi status: %s', (status) => {
    // §8.4: six values collapse onto FAILURE, so the exact Jsyxi status MUST
    // be written into the event's message text.
    expect(fulfillmentEventMessage(status)).toBe(status);
  });

  it('the six RTO/LOST/CANCELLED statuses collapse onto FAILURE', () => {
    const failures = ALL_STATUSES.filter((s) => mapCarrierEventToShopify(s) === 'FAILURE');
    expect(failures.sort()).toEqual(
      [
        'CANCELLED_BY_COURIER',
        'LOST_OR_DAMAGED',
        'RTO_DELIVERED',
        'RTO_INITIATED',
        'RTO_IN_TRANSIT',
        'RTO_OUT_FOR_DELIVERY',
      ].sort(),
    );
  });
});
