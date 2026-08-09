/**
 * §9.2.3 location consolidation — the PURE planning half, split from the
 * DB-writing AllocationService so the merge/fallback/exclusion behaviour is
 * unit-testable without Postgres or Shopify.
 *
 * Rules (§9.2.3, A4-01, RV-06, RV-11, INV-20):
 *  - Every unfulfilled, in-house fulfillment order on a ships_via_jsyxi=true
 *    location consolidates into ONE allocation and one DRAFT shipment by
 *    default (canMergeFulfillmentOrders = true — the week-0 verification
 *    seam; see AllocationService).
 *  - Where merging is unavailable, one allocation per fulfillment order —
 *    never drop one (this fallback is the ONLY way an Order gets more than
 *    one Shipment in v1).
 *  - Externally-fulfilled fulfillment orders, and any on a
 *    ships_via_jsyxi=false location, yield an EXCLUDED allocation WITH the
 *    reason — never silently absent (INV-20).
 */

/** §3.22 EXCLUDED reasons — surfaced on the Order with the allocation. */
export type AllocationExclusionReason =
  | 'EXTERNALLY_FULFILLED'
  | 'LOCATION_NOT_SHIPPED_VIA_JSYXI'
  | 'FULFILLMENT_ORDER_CANCELLED';

export interface FulfillmentOrderInfo {
  gid: string;
  status: string;
  locationGid: string | null;
  locationName: string | null;
}

export interface AllocationPlanItem {
  state: 'OPEN' | 'EXCLUDED';
  sourceFulfillmentOrderGids: string[];
  shopifyLocationGid: string | null;
  exclusionReason: AllocationExclusionReason | null;
  mergePath: 'CONSOLIDATED' | 'FALLBACK_PER_FULFILLMENT_ORDER' | null;
}

/** Unfulfilled, in-house statuses — anything else is either externally
 *  fulfilled (CLOSED, IN_PROGRESS) or dead quantity (CANCELLED, INCOMPLETE).
 *  Externally fulfilled or cancelled quantities are never bookable (§9.2.5). */
const IN_HOUSE_STATUSES = new Set(['OPEN', 'SCHEDULED', 'ON_HOLD']);
const CANCELLED_STATUSES = new Set(['CANCELLED', 'INCOMPLETE']);

export function buildAllocationPlan(
  fulfillmentOrders: FulfillmentOrderInfo[],
  shipsViaJsyxi: (locationGid: string | null) => boolean,
  canMerge: boolean,
): AllocationPlanItem[] {
  const plan: AllocationPlanItem[] = [];
  const inHouse: FulfillmentOrderInfo[] = [];

  for (const fo of fulfillmentOrders) {
    if (IN_HOUSE_STATUSES.has(fo.status)) {
      if (!shipsViaJsyxi(fo.locationGid)) {
        // INV-20: excluded WITH the reason, never silently absent.
        plan.push({
          state: 'EXCLUDED',
          sourceFulfillmentOrderGids: [fo.gid],
          shopifyLocationGid: fo.locationGid,
          exclusionReason: 'LOCATION_NOT_SHIPPED_VIA_JSYXI',
          mergePath: null,
        });
        continue;
      }
      inHouse.push(fo);
      continue;
    }
    plan.push({
      state: 'EXCLUDED',
      sourceFulfillmentOrderGids: [fo.gid],
      shopifyLocationGid: fo.locationGid,
      exclusionReason: CANCELLED_STATUSES.has(fo.status)
        ? 'FULFILLMENT_ORDER_CANCELLED'
        : 'EXTERNALLY_FULFILLED',
      mergePath: null,
    });
  }

  if (canMerge) {
    // RV-11: one allocation / one Shipment per Order by default.
    if (inHouse.length > 0) {
      plan.push({
        state: 'OPEN',
        sourceFulfillmentOrderGids: inHouse.map((fo) => fo.gid),
        shopifyLocationGid: inHouse[0]?.locationGid ?? null,
        exclusionReason: null,
        mergePath: 'CONSOLIDATED',
      });
    }
  } else {
    // §9.2.3 fallback: one per fulfillment order — never drop one (INV-20).
    for (const fo of inHouse) {
      plan.push({
        state: 'OPEN',
        sourceFulfillmentOrderGids: [fo.gid],
        shopifyLocationGid: fo.locationGid,
        exclusionReason: null,
        mergePath: 'FALLBACK_PER_FULFILLMENT_ORDER',
      });
    }
  }

  if (plan.length === 0) {
    // No fulfillment orders at all (e.g. a just-created order Shopify has
    // not routed yet): the order still lands — one default allocation, no
    // source GIDs (never skip an order, §9.2.3).
    plan.push({
      state: 'OPEN',
      sourceFulfillmentOrderGids: [],
      shopifyLocationGid: null,
      exclusionReason: null,
      mergePath: 'CONSOLIDATED',
    });
  }
  return plan;
}
