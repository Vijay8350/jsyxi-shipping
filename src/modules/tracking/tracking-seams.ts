import { Injectable } from '@nestjs/common';
import type { CarrierEventStatus, MovementState } from './tracking.types';

/**
 * Downstream seams the reducer fires after a state change. Both have no-op
 * defaults; later modules bind their own implementation to TRACKING_SEAMS.
 *
 *  - onDelivered: the recon COD expectation seam (§2.7 recon_cod_expected,
 *    §3.15, F-21) — created when the reconciliation block lands. The reducer
 *    has already set shipment.delivered_at by then; this hook is where the
 *    COD module attaches.
 *  - onNdr: the NDR suite (machine F, §3.10, §9.8) — opening/aging an
 *    ndr_case when movement enters NDR is the M8 block's work.
 */
export const TRACKING_SEAMS = Symbol('TRACKING_SEAMS');

export interface TrackingSeams {
  onDelivered(input: { shopId: string; shipmentId: string; occurredAt: string }): Promise<void>;
  onNdr(input: {
    shopId: string;
    shipmentId: string;
    carrierEventStatus: CarrierEventStatus;
    occurredAt: string;
  }): Promise<void>;
  /** Fired for terminal MOVEMENT_STATEs other than DELIVERED (RTO_DELIVERED,
   *  LOST_OR_DAMAGED, CANCELLED_BY_COURIER) so machine F's terminal row
   *  (§3.10) closes there too. */
  onTerminalMovement?(input: {
    shopId: string;
    shipmentId: string;
    movementState: MovementState;
    occurredAt: string;
  }): Promise<void>;
  /** Fired when movement enters RTO_INITIATED — §4.7: a Collectible-bearing
   *  Shipment that goes RTO records RTO_UNCOLLECTED, never a Short. */
  onRtoInitiated?(input: {
    shopId: string;
    shipmentId: string;
    movementState: MovementState;
    occurredAt: string;
  }): Promise<void>;
}

@Injectable()
export class NoopTrackingSeams implements TrackingSeams {
  async onDelivered(): Promise<void> {
    // No-op default — the recon COD expectation module binds over this.
  }

  async onNdr(): Promise<void> {
    // No-op default — the NDR suite (§9.8, machine F) binds over this.
  }

  async onTerminalMovement(): Promise<void> {
    // No-op default.
  }
}
