import { describe, expect, it } from 'vitest';
import {
  deriveCodAssignmentState,
  deriveOrderShippingStatus,
  ShipmentStatusInput,
} from '../../src/modules/order-derivation/order-status';

/** §3.24 COD_ASSIGNMENT_STATE (INV-9) and F-22 (§4.9, A2-06). */

function shipment(overrides: Partial<ShipmentStatusInput> = {}): ShipmentStatusInput {
  return { bookingState: 'CONFIRMED', movementState: 'NOT_SHIPPED', custodyState: 'PICKUP_PENDING', ...overrides };
}

describe('deriveCodAssignmentState (§3.24, INV-9)', () => {
  it('NOT_APPLICABLE when F-15 = 0', () => {
    expect(
      deriveCodAssignmentState({
        codOutstanding: '0.00',
        shipments: [{ bookingState: 'CONFIRMED', awbNormalized: 'AWB1', collectible: '0.00' }],
      }),
    ).toBe('NOT_APPLICABLE');
  });

  it('ASSIGNED while exactly one active-AWB shipment carries the FULL Collectible (§4.7 worked example)', () => {
    expect(
      deriveCodAssignmentState({
        codOutstanding: '2000.00',
        shipments: [
          { bookingState: 'CONFIRMED', awbNormalized: 'AWBA', collectible: '2000.00' },
          { bookingState: 'CONFIRMED', awbNormalized: 'AWBB', collectible: '0.00' },
        ],
      }),
    ).toBe('ASSIGNED');
  });

  it('UNASSIGNED when F-15 > 0, no active carrier, and ≥1 shipment already booked', () => {
    // §4.7 worked example continued: the collectible-bearing shipment was
    // cancelled before pickup while the sibling is already booked.
    expect(
      deriveCodAssignmentState({
        codOutstanding: '2000.00',
        shipments: [
          { bookingState: 'VOID', awbNormalized: 'AWBA', collectible: '2000.00' },
          { bookingState: 'CONFIRMED', awbNormalized: 'AWBB', collectible: '0.00' },
        ],
      }),
    ).toBe('UNASSIGNED');
  });

  it('UNASSIGNED on a shortfall while any shipment is booked — surfaced, never tolerated (INV-9)', () => {
    expect(
      deriveCodAssignmentState({
        codOutstanding: '2000.00',
        shipments: [{ bookingState: 'CONFIRMED', awbNormalized: 'AWBA', collectible: '1500.00' }],
      }),
    ).toBe('UNASSIGNED');
  });

  it('pre-booking sums are legitimately 0 (INV-9): F-15 > 0 with only DRAFTs stays NOT_APPLICABLE', () => {
    expect(
      deriveCodAssignmentState({
        codOutstanding: '2000.00',
        shipments: [{ bookingState: 'DRAFT', awbNormalized: null, collectible: '0.00' }],
      }),
    ).toBe('NOT_APPLICABLE');
  });
});

describe('deriveOrderShippingStatus (F-22, §4.9, A2-06)', () => {
  it('zero shipments → the ORDER_STATE (§3.1)', () => {
    expect(deriveOrderShippingStatus({ orderState: 'READY', shipments: [] })).toBe('READY');
  });

  it('precedence 1: manual assignment needed beats everything', () => {
    expect(
      deriveOrderShippingStatus({
        orderState: 'PARTIALLY_BOOKED',
        shipments: [
          shipment({ bookingState: 'NEEDS_MANUAL_ASSIGNMENT' }),
          shipment({ movementState: 'DELIVERED' }),
        ],
      }),
    ).toBe('MANUAL_ASSIGNMENT_NEEDED');
  });

  it('precedence 2: NDR beats RTO in progress', () => {
    expect(
      deriveOrderShippingStatus({
        orderState: 'FULLY_BOOKED',
        shipments: [
          shipment({ movementState: 'RTO_INITIATED' }),
          shipment({ movementState: 'NDR' }),
        ],
      }),
    ).toBe('NDR');
  });

  it('precedence 3: non-terminal RTO beats booking failed', () => {
    expect(
      deriveOrderShippingStatus({
        orderState: 'FULLY_BOOKED',
        shipments: [
          shipment({ bookingState: 'FAILED', movementState: 'NOT_SHIPPED' }),
          shipment({ movementState: 'RTO_OUT_FOR_DELIVERY' }),
        ],
      }),
    ).toBe('RTO_IN_PROGRESS');
  });

  it('precedence 4: booking failed beats in-flight', () => {
    expect(
      deriveOrderShippingStatus({
        orderState: 'FULLY_BOOKED',
        shipments: [
          shipment({ bookingState: 'FAILED', movementState: 'NOT_SHIPPED' }),
          shipment({ movementState: 'IN_TRANSIT' }),
        ],
      }),
    ).toBe('BOOKING_FAILED');
  });

  it('precedence 5: in-flight, LEAST ADVANCED wins', () => {
    expect(
      deriveOrderShippingStatus({
        orderState: 'FULLY_BOOKED',
        shipments: [
          shipment({ movementState: 'OUT_FOR_DELIVERY' }),
          shipment({ movementState: 'IN_TRANSIT' }),
        ],
      }),
    ).toBe('IN_TRANSIT');
    expect(
      deriveOrderShippingStatus({
        orderState: 'PARTIALLY_BOOKED',
        shipments: [
          shipment({ movementState: 'IN_TRANSIT' }),
          shipment({ bookingState: 'DRAFT', movementState: 'NOT_SHIPPED', custodyState: 'NOT_APPLICABLE' }),
        ],
      }),
    ).toBe('NOT_SHIPPED');
  });

  it('delivered only when EVERY shipment is DELIVERED', () => {
    expect(
      deriveOrderShippingStatus({
        orderState: 'FULLY_BOOKED',
        shipments: [shipment({ movementState: 'DELIVERED' }), shipment({ movementState: 'DELIVERED' })],
      }),
    ).toBe('DELIVERED');
  });

  it('cancelled only when ALL are cancelled — across VOID / custody / courier machines', () => {
    expect(
      deriveOrderShippingStatus({
        orderState: 'FULLY_BOOKED',
        shipments: [
          shipment({ bookingState: 'VOID', movementState: 'NOT_SHIPPED', custodyState: 'NOT_APPLICABLE' }),
          shipment({ custodyState: 'CANCELLED', movementState: 'NOT_SHIPPED' }),
          shipment({ movementState: 'CANCELLED_BY_COURIER' }),
        ],
      }),
    ).toBe('CANCELLED');
  });

  it('mixed terminal outcomes render PARTIALLY_DELIVERED', () => {
    expect(
      deriveOrderShippingStatus({
        orderState: 'FULLY_BOOKED',
        shipments: [
          shipment({ movementState: 'DELIVERED' }),
          shipment({ movementState: 'RTO_DELIVERED' }),
        ],
      }),
    ).toBe('PARTIALLY_DELIVERED');
    expect(
      deriveOrderShippingStatus({
        orderState: 'FULLY_BOOKED',
        shipments: [
          shipment({ movementState: 'DELIVERED' }),
          shipment({ movementState: 'CANCELLED_BY_COURIER' }),
        ],
      }),
    ).toBe('PARTIALLY_DELIVERED');
  });

  it('a VOID shipment does not shadow the terminal rungs as NOT_SHIPPED', () => {
    // VOID keeps movement NOT_SHIPPED; cancelled shipments are excluded from
    // the in-flight rung or "cancelled (all)" would be unreachable.
    expect(
      deriveOrderShippingStatus({
        orderState: 'FULLY_BOOKED',
        shipments: [
          shipment({ movementState: 'DELIVERED' }),
          shipment({ bookingState: 'VOID', movementState: 'NOT_SHIPPED', custodyState: 'NOT_APPLICABLE' }),
        ],
      }),
    ).toBe('PARTIALLY_DELIVERED');
  });
});
