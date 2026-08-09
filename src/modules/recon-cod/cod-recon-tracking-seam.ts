import { Injectable } from '@nestjs/common';
import type { MovementState } from '../tracking/tracking.types';
import { CodExpectationService } from './cod-expectation.service';

const RTO_MOVEMENT_STATES: readonly MovementState[] = [
  'RTO_INITIATED',
  'RTO_IN_TRANSIT',
  'RTO_OUT_FOR_DELIVERY',
  'RTO_DELIVERED',
];

/**
 * The COD reconciliation binding of the tracking seams (TRACKING_SEAMS in
 * tracking/tracking-seams.ts). The parent wires this class into the seam
 * composite in tracking.module.ts:
 *
 *  - onDelivered({shopId, shipmentId, occurredAt})  → §9.17.3 expectation
 *    creation (Collectible > 0, non-test, idempotent).
 *  - onRtoInitiated({shopId, shipmentId, movementState, occurredAt}) → §4.7
 *    RTO_UNCOLLECTED for any RTO_* movement state.
 *  - onTerminalMovement({shopId, shipmentId, movementState, occurredAt}) →
 *    the same for the terminal RTO_DELIVERED (the TrackingSeams interface's
 *    optional terminal hook).
 */
@Injectable()
export class CodReconTrackingSeam {
  constructor(private readonly expectations: CodExpectationService) {}

  /** §9.17.3: DELIVERED creates the expectation. */
  async onDelivered(input: {
    shopId: string;
    shipmentId: string;
    occurredAt: string;
  }): Promise<void> {
    await this.expectations.createOnDelivered(input);
  }

  /** §4.7: any RTO_* movement flips an existing expectation, never a Short. */
  async onRtoInitiated(input: {
    shopId: string;
    shipmentId: string;
    movementState: MovementState;
    occurredAt: string;
  }): Promise<void> {
    if (!RTO_MOVEMENT_STATES.includes(input.movementState)) return;
    await this.expectations.markRtoUncollected(input);
  }

  /** Terminal-movement hook (RTO_DELIVERED lands here in the reducer). */
  async onTerminalMovement(input: {
    shopId: string;
    shipmentId: string;
    movementState: MovementState;
    occurredAt: string;
  }): Promise<void> {
    if (input.movementState !== 'RTO_DELIVERED') return;
    await this.expectations.markRtoUncollected(input);
  }
}
