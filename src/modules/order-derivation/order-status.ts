import { rupeesToPaise } from '../../common/money';

/**
 * §3.24 COD_ASSIGNMENT_STATE (INV-9) and F-22 derived order shipping status
 * (§4.9, A2-06) — pure derivations over an order's shipments.
 */

export type CodAssignmentState = 'NOT_APPLICABLE' | 'ASSIGNED' | 'UNASSIGNED';

export interface ShipmentCodInput {
  bookingState: string;
  awbNormalized: string | null;
  /** shipment.collectible, NUMERIC text. */
  collectible: string;
}

/**
 * "Active AWB" mirrors the DB guard in migration 0003
 * (enforce_single_collectible): awb set and booking not VOID.
 */
function hasActiveAwb(s: ShipmentCodInput): boolean {
  return s.awbNormalized !== null && s.bookingState !== 'VOID';
}

/**
 * §3.24 / INV-9:
 *  - NOT_APPLICABLE when F-15 = 0;
 *  - ASSIGNED while exactly one Shipment with an active AWB carries the FULL
 *    Collectible (Σ collectible over active AWBs = F-15, INV-9);
 *  - UNASSIGNED when F-15 > 0, no active carrier (or a shortfall), and ≥1
 *    Shipment on the Order is already booked (active AWB present);
 *  - before the Order's first booking the sum is legitimately 0 (INV-9), so
 *    the state stays NOT_APPLICABLE — there is nothing to assign yet. This is
 *    the week-4 reading of §3.24's three values for the pre-booking case.
 */
export function deriveCodAssignmentState(input: {
  /** F-15, NUMERIC text; null treated as 0 (undetermined → not assigned). */
  codOutstanding: string | null;
  shipments: ShipmentCodInput[];
}): CodAssignmentState {
  const outstanding = rupeesToPaise(input.codOutstanding ?? '0.00');
  if (outstanding <= 0n) return 'NOT_APPLICABLE';

  const active = input.shipments.filter(hasActiveAwb);
  const carriers = active.filter((s) => rupeesToPaise(s.collectible) > 0n);
  if (
    carriers.length === 1 &&
    rupeesToPaise((carriers[0] as ShipmentCodInput).collectible) === outstanding
  ) {
    return 'ASSIGNED';
  }
  // INV-9: a shortfall while any Shipment is booked is UNASSIGNED — surfaced,
  // never tolerated silently.
  if (active.length >= 1) return 'UNASSIGNED';
  // Pre-booking: the sum is legitimately 0 (INV-9).
  return 'NOT_APPLICABLE';
}

/** §4.9 F-22 display codes; zero shipments → the ORDER_STATE (§3.1). */
export type DerivedShippingStatus =
  | 'MANUAL_ASSIGNMENT_NEEDED'
  | 'NDR'
  | 'RTO_IN_PROGRESS'
  | 'BOOKING_FAILED'
  | 'NOT_SHIPPED'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'PARTIALLY_DELIVERED';

export interface ShipmentStatusInput {
  bookingState: string;
  movementState: string;
  custodyState: string;
}

/** §3.4 terminal movement states. */
const TERMINAL_MOVEMENT = new Set([
  'DELIVERED',
  'RTO_DELIVERED',
  'LOST_OR_DAMAGED',
  'CANCELLED_BY_COURIER',
]);

/** §4.9 F-22: "any non-terminal RTO state". */
const RTO_IN_PROGRESS = new Set(['RTO_INITIATED', 'RTO_IN_TRANSIT', 'RTO_OUT_FOR_DELIVERY']);

/** In-flight movement, least advanced first (§4.9 F-22). */
const IN_FLIGHT_ORDER = ['NOT_SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'] as const;

/** A cancelled Shipment across the three machines (§3.2 VOID, §3.3, §3.4). */
function isCancelled(s: ShipmentStatusInput): boolean {
  return (
    s.bookingState === 'VOID' ||
    s.custodyState === 'CANCELLED' ||
    s.movementState === 'CANCELLED_BY_COURIER'
  );
}

/**
 * F-22 first-match precedence (§4.9, A2-06):
 *   manual assignment needed → NDR → RTO in progress → booking failed →
 *   in-flight least-advanced → delivered (ALL) → cancelled (ALL) →
 *   mixed terminal = PARTIALLY_DELIVERED.
 * Cancelled/terminal shipments are excluded from the in-flight rung (their
 * movement state still reads NOT_SHIPPED, which would otherwise shadow the
 * cancelled rung).
 */
export function deriveOrderShippingStatus(input: {
  orderState: string;
  shipments: ShipmentStatusInput[];
}): string {
  const { shipments } = input;
  // §3.1: an Order with zero Shipments displays its ORDER_STATE.
  if (shipments.length === 0) return input.orderState;

  if (shipments.some((s) => s.bookingState === 'NEEDS_MANUAL_ASSIGNMENT')) {
    return 'MANUAL_ASSIGNMENT_NEEDED';
  }
  if (shipments.some((s) => s.movementState === 'NDR')) return 'NDR';
  if (shipments.some((s) => RTO_IN_PROGRESS.has(s.movementState))) return 'RTO_IN_PROGRESS';
  if (shipments.some((s) => s.bookingState === 'FAILED')) return 'BOOKING_FAILED';

  // In-flight, least advanced wins.
  for (const state of IN_FLIGHT_ORDER) {
    if (shipments.some((s) => !isCancelled(s) && !TERMINAL_MOVEMENT.has(s.movementState) && s.movementState === state)) {
      return state;
    }
  }

  if (shipments.every((s) => s.movementState === 'DELIVERED')) return 'DELIVERED';
  if (shipments.every(isCancelled)) return 'CANCELLED';
  // Mixed terminal outcomes (§4.9 F-22).
  return 'PARTIALLY_DELIVERED';
}
