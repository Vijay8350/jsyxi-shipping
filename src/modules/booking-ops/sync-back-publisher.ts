import { Injectable } from '@nestjs/common';

/**
 * §9.6 sync-back seam. When a shipment reaches CONFIRMED, a Shopify
 * fulfillment must eventually be created (§8.4, one per Shipment). The
 * sync-back module is built separately against THIS interface; booking-ops
 * defines and exports it so the booking worker can be pointed at a real
 * implementation later without touching booking module files.
 *
 * The default is a deliberate no-op: with only this module wired, CONFIRMED
 * bookings do not write to Shopify yet. The parent wires the real publisher
 * into the booking worker's confirm path (BookingWorkerService.confirmBooking)
 * when the §9.6 module lands. Test shipments must never reach Shopify
 * (INV-19) — that exclusion belongs to the real implementation.
 */
export const SYNC_BACK_PUBLISHER = Symbol('SYNC_BACK_PUBLISHER');

export interface SyncBackPublisher {
  /** Enqueue a §8.4 CREATE_FULFILLMENT for a CONFIRMED shipment. */
  enqueueFulfillmentCreate(shipmentId: string): Promise<void>;
}

@Injectable()
export class NoopSyncBackPublisher implements SyncBackPublisher {
  async enqueueFulfillmentCreate(_shipmentId: string): Promise<void> {
    // Seam only — the §9.6 sync-back module provides the real publisher.
  }
}
