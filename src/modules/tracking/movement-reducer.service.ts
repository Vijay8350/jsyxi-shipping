import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { SyncBackService } from '../sync-back/sync-back.service';
import { BuyerNotificationService } from '../notifications/buyer-notification.service';
import { TRACKING_SEAMS, TrackingSeams } from './tracking-seams';
import type {
  CarrierEventStatus,
  CustodyState,
  MovementState,
} from './tracking.types';

/**
 * The §3.4 reducer — the ONLY writer of shipment.movement_state.
 *
 * Rules (§3.4, A1-10):
 *  - The event → state table is applied exactly (EVENT_TO_MOVEMENT).
 *  - Every transition runs under the shipment's optimistic version check
 *    (INV-22): read version → conditional UPDATE → a mismatch re-reads and
 *    re-applies, never a last-write-wins merge.
 *  - A terminal movement state is NEVER regressed (INV-17): a later event
 *    targeting a different state is stored with review_flag and the review
 *    path is raised instead of changing state.
 *  - PICKED_UP also drives custody (§3.3): PICKUP_PENDING/PICKUP_SCHEDULED →
 *    IN_CUSTODY, terminal for machine C — including the CANCEL_REQUESTED
 *    race row (A1-04), which is flagged for review with NO entitlement
 *    reversal (§9.5.6).
 *  - DELIVERED sets shipment.delivered_at from the event's occurred-at
 *    (§5.2 period attribution) and fires the recon COD seam (onDelivered).
 *  - NDR fires the onNdr seam for the later machine F block (§3.10).
 *  - After each state change the §8.4 fulfillment event is enqueued
 *    (INV-19 test exclusion lives inside SyncBackService).
 */

/** §3.4: the event → MOVEMENT_STATE table, verbatim. */
export const EVENT_TO_MOVEMENT: Record<CarrierEventStatus, MovementState> = {
  PICKUP_SCHEDULED: 'IN_TRANSIT',
  PICKED_UP: 'IN_TRANSIT',
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  UNDELIVERED_ATTEMPT: 'NDR',
  DELIVERED: 'DELIVERED',
  RTO_INITIATED: 'RTO_INITIATED',
  RTO_IN_TRANSIT: 'RTO_IN_TRANSIT',
  RTO_OUT_FOR_DELIVERY: 'RTO_OUT_FOR_DELIVERY',
  RTO_DELIVERED: 'RTO_DELIVERED',
  LOST_OR_DAMAGED: 'LOST_OR_DAMAGED',
  CANCELLED_BY_COURIER: 'CANCELLED_BY_COURIER',
};

/** §3.4 terminal states — never silently regressed (INV-17). */
export const TERMINAL_MOVEMENT_STATES: ReadonlySet<MovementState> = new Set([
  'DELIVERED',
  'RTO_DELIVERED',
  'LOST_OR_DAMAGED',
  'CANCELLED_BY_COURIER',
]);

const MAX_VERSION_RETRIES = 5;

export interface ShipmentMovementRow {
  shipment_id: string;
  shop_id: string;
  order_id: string;
  movement_state: MovementState;
  custody_state: CustodyState;
  delivered_at: string | null;
  version: number;
}

export interface ReducerDecision {
  targetMovement: MovementState;
  /** movement_state actually changes. */
  movementChanges: boolean;
  /** §3.3 custody transition to apply (IN_CUSTODY on PICKED_UP), if any. */
  custodyTarget: CustodyState | null;
  /** INV-17 terminal regression or the §3.3 CANCEL_REQUESTED race. */
  reviewFlag: boolean;
  reviewReason: string | null;
  /** DELIVERED stamps delivered_at (§5.2). */
  setDeliveredAt: boolean;
}

/**
 * Pure reducer decision — one §3.4 row applied to the current shipment
 * states. Exported for direct unit testing of every table row.
 */
export function decideTransition(
  current: Pick<ShipmentMovementRow, 'movement_state' | 'custody_state' | 'delivered_at'>,
  status: CarrierEventStatus,
): ReducerDecision {
  const target = EVENT_TO_MOVEMENT[status];

  // §3.3: the first PICKED_UP event confirms custody (terminal machine C),
  // including the A1-04 race — a PICKED_UP while CANCEL_REQUESTED moves
  // custody to IN_CUSTODY, flags for review, and reverses NOTHING (§9.5.6).
  let custodyTarget: CustodyState | null = null;
  let custodyRace = false;
  if (
    status === 'PICKED_UP' &&
    (current.custody_state === 'PICKUP_PENDING' ||
      current.custody_state === 'PICKUP_SCHEDULED' ||
      current.custody_state === 'CANCEL_REQUESTED')
  ) {
    custodyTarget = 'IN_CUSTODY';
    custodyRace = current.custody_state === 'CANCEL_REQUESTED';
  }

  // INV-17: a terminal state is never regressed. A repeat of the SAME
  // terminal status is stored but harmless — not flagged, not applied.
  if (TERMINAL_MOVEMENT_STATES.has(current.movement_state) && target !== current.movement_state) {
    return {
      targetMovement: target,
      movementChanges: false,
      // Custody is terminal too; a late PICKED_UP after a terminal movement
      // does not reopen machine C — the event is review-flagged instead.
      custodyTarget: null,
      reviewFlag: true,
      reviewReason: `terminal ${current.movement_state} not regressed by ${status} (INV-17)`,
      setDeliveredAt: false,
    };
  }

  const movementChanges = target !== current.movement_state;
  return {
    targetMovement: target,
    movementChanges,
    custodyTarget,
    reviewFlag: custodyRace,
    reviewReason: custodyRace
      ? 'PICKED_UP arrived while cancellation pending — CANCEL_REQUESTED → IN_CUSTODY race (§3.3, A1-04); no entitlement reversal (§9.5.6)'
      : null,
    setDeliveredAt: movementChanges && target === 'DELIVERED' && !current.delivered_at,
  };
}

export interface ReducerOutcome {
  stateChanged: boolean;
  movementState: MovementState;
  reviewFlag: boolean;
  reviewReason: string | null;
}

@Injectable()
export class MovementReducerService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly syncBack: SyncBackService,
    @Inject(TRACKING_SEAMS) private readonly seams: TrackingSeams,
    @Optional() private readonly buyerNotifications?: BuyerNotificationService,
  ) {}

  private readonly logger = new Logger(MovementReducerService.name);

  /** ADD-26: buyer-facing tracking messages. Never gates anything (INV-21);
   *  the service no-ops for test shipments (INV-19). */
  private async notifyBuyer(
    method: 'onOutForDelivery' | 'onUndeliveredAttempt' | 'onDelivered' | 'onRtoInitiated',
    shopId: string,
    shipmentId: string,
  ): Promise<void> {
    if (!this.buyerNotifications) return;
    try {
      if (method === 'onUndeliveredAttempt') {
        const { rows } = await this.pool.query<{ ndr_case_id: string }>(
          `SELECT ndr_case_id FROM ndr_case
            WHERE shop_id = $1 AND shipment_id = $2 AND state <> 'CLOSED'
            ORDER BY last_ndr_at DESC LIMIT 1`,
          [shopId, shipmentId],
        );
        if (rows[0]) await this.buyerNotifications.onUndeliveredAttempt(shopId, shipmentId, rows[0].ndr_case_id);
        return;
      }
      await this.buyerNotifications[method](shopId, shipmentId);
    } catch (err) {
      this.logger.warn(`buyer notification ${method} failed for shipment=${shipmentId}: ${(err as Error).name}`);
    }
  }

  /**
   * Apply one normalized event to a shipment. The tracking_event row is
   * already stored by the caller (raw events append always, A1-10); this
   * method owns the state transition and flips review_flag when the §3.4
   * reducer rules demand review instead of a change.
   */
  async applyEvent(input: {
    shopId: string;
    shipmentId: string;
    eventId: string;
    status: CarrierEventStatus;
    occurredAt: string;
  }): Promise<ReducerOutcome> {
    for (let attempt = 1; attempt <= MAX_VERSION_RETRIES; attempt++) {
      const row = await this.loadShipment(input.shopId, input.shipmentId);
      const decision = decideTransition(row, input.status);

      if (decision.reviewFlag) {
        await this.pool.query(
          `UPDATE tracking_event SET review_flag = true
            WHERE event_id = $1`,
          [input.eventId],
        );
      }

      if (!decision.movementChanges && !decision.custodyTarget) {
        // Same-state event (or an INV-17 regression): stored, nothing moves.
        // A repeat UNDELIVERED_ATTEMPT while already NDR still drives machine
        // F (§3.10: re-open / attempt_count++) and the buyer message (ADD-26).
        if (input.status === 'UNDELIVERED_ATTEMPT' && row.movement_state === 'NDR') {
          await this.seams.onNdr({
            shopId: input.shopId,
            shipmentId: input.shipmentId,
            carrierEventStatus: input.status,
            occurredAt: input.occurredAt,
          });
          await this.notifyBuyer('onUndeliveredAttempt', input.shopId, input.shipmentId);
        }
        return {
          stateChanged: false,
          movementState: row.movement_state,
          reviewFlag: decision.reviewFlag,
          reviewReason: decision.reviewReason,
        };
      }

      // INV-22: conditional update on the version we read. A mismatch means
      // a concurrent writer won — re-read and re-apply, never merge.
      const { rowCount } = await this.pool.query(
        `UPDATE shipment
            SET movement_state = $3,
                custody_state = COALESCE($4::custody_state, custody_state),
                delivered_at = CASE WHEN $5 THEN $6::timestamptz ELSE delivered_at END,
                version = version + 1
          WHERE shop_id = $1 AND shipment_id = $2 AND version = $7`,
        [
          input.shopId,
          input.shipmentId,
          decision.targetMovement,
          decision.custodyTarget,
          decision.setDeliveredAt,
          input.occurredAt,
          row.version,
        ],
      );
      if ((rowCount ?? 0) === 0) continue; // version mismatch — re-read.

      if (decision.movementChanges) {
        // §8.4 fulfillment event after the state change (INV-19 handled
        // inside SyncBackService: test shipments enqueue nothing).
        await this.syncBack.enqueueFulfillmentEvent(
          input.shopId,
          input.shipmentId,
          input.status,
        );
        if (decision.targetMovement === 'DELIVERED') {
          // Recon COD expectation seam (§2.7/§3.15) — no-op until M17 binds.
          await this.seams.onDelivered({
            shopId: input.shopId,
            shipmentId: input.shipmentId,
            occurredAt: input.occurredAt,
          });
          await this.notifyBuyer('onDelivered', input.shopId, input.shipmentId);
        }
        if (decision.targetMovement === 'NDR') {
          // NDR machine F seam (§3.10, §9.8).
          await this.seams.onNdr({
            shopId: input.shopId,
            shipmentId: input.shipmentId,
            carrierEventStatus: input.status,
            occurredAt: input.occurredAt,
          });
          // ADD-26: the NDR buyer message carries the ADD-27 self-serve link.
          await this.notifyBuyer('onUndeliveredAttempt', input.shopId, input.shipmentId);
        }
        if (decision.targetMovement === 'OUT_FOR_DELIVERY') {
          await this.notifyBuyer('onOutForDelivery', input.shopId, input.shipmentId);
        }
        if (decision.targetMovement === 'RTO_INITIATED') {
          await this.notifyBuyer('onRtoInitiated', input.shopId, input.shipmentId);
          // §4.7: a Collectible-bearing Shipment going RTO records
          // RTO_UNCOLLECTED on its COD expectation, never a Short.
          await this.seams.onRtoInitiated?.({
            shopId: input.shopId,
            shipmentId: input.shipmentId,
            movementState: decision.targetMovement,
            occurredAt: input.occurredAt,
          });
        }
        if (
          decision.targetMovement === 'RTO_DELIVERED' ||
          decision.targetMovement === 'LOST_OR_DAMAGED' ||
          decision.targetMovement === 'CANCELLED_BY_COURIER'
        ) {
          // §3.10 terminal row: NDR cases close on every terminal movement,
          // not just DELIVERED.
          await this.seams.onTerminalMovement?.({
            shopId: input.shopId,
            shipmentId: input.shipmentId,
            movementState: decision.targetMovement,
            occurredAt: input.occurredAt,
          });
        }
      }
      return {
        stateChanged: decision.movementChanges,
        movementState: decision.targetMovement,
        reviewFlag: decision.reviewFlag,
        reviewReason: decision.reviewReason,
      };
    }
    // INV-22: retries exhausted — surface, never silently last-write-wins.
    throw new ConflictException(
      `shipment ${input.shipmentId} movement update lost to concurrent writes`,
    );
  }

  private async loadShipment(shopId: string, shipmentId: string): Promise<ShipmentMovementRow> {
    // Shop-scoped (INV-1).
    const { rows } = await this.pool.query<ShipmentMovementRow>(
      `SELECT shipment_id, shop_id, order_id, movement_state, custody_state,
              delivered_at, version
         FROM shipment
        WHERE shop_id = $1 AND shipment_id = $2`,
      [shopId, shipmentId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('shipment not found in this shop');
    return row;
  }
}
