import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { AdapterCallerService } from '../courier-framework/adapter-caller.service';
import type { CancelShipmentResult } from '../courier-framework/adapter.types';
import { EntitlementLedgerService } from '../platform/ledger/entitlement-ledger.service';
import { OrderDerivationService } from '../order-derivation/order-derivation.service';
import { OverageService } from '../billing/overage.service';
import type { BookingState, CancelResult, CustodyState } from './booking.types';

/**
 * Pre-pickup cancellation (§3.3 machine C, §9.5.5).
 *
 * Only PICKUP_PENDING / PICKUP_SCHEDULED can be cancelled: the member action
 * moves custody to CANCEL_REQUESTED and calls the adapter's cancelShipment.
 * A courier-confirmed cancellation (pre-pickup) settles as CANCELLED +
 * booking VOID, reverses the entitlement exactly once (INV-12), and releases
 * the Collectible to the Order (§4.7 — cod_assignment_state is re-derived;
 * when every sibling is already booked it becomes UNASSIGNED and is
 * surfaced). A rejection returns custody to its previous state via
 * CANCEL_REJECTED. The §3.3 race — a PICKED_UP event landing while the
 * cancellation is pending — is flagged for review and reverses NOTHING
 * (§9.5.6).
 */

interface CancelLockRow {
  shipment_id: string;
  shop_id: string;
  order_id: string;
  courier_account_id: string | null;
  booking_state: BookingState;
  custody_state: CustodyState;
  awb_normalized: string | null;
  awb_raw: string | null;
  is_test: boolean;
  booking_intent_id: string | null;
}

@Injectable()
export class CancellationService {
  private readonly logger = new Logger(CancellationService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly adapterCaller: AdapterCallerService,
    private readonly ledger: EntitlementLedgerService,
    private readonly derivation: OrderDerivationService,
    @Optional() private readonly overage?: OverageService,
  ) {}

  async requestCancellation(input: {
    shopId: string;
    shipmentId: string;
    actorId: string;
  }): Promise<CancelResult> {
    // Phase 1 — guard and CANCEL_REQUESTED (§3.3).
    const client = await this.pool.connect();
    let shipment: CancelLockRow;
    let previousCustody: CustodyState;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<CancelLockRow>(
        `SELECT s.shipment_id, s.shop_id, s.order_id, s.courier_account_id,
                s.booking_state, s.custody_state, s.awb_normalized, s.awb_raw,
                s.is_test,
                (SELECT b.booking_intent_id FROM booking_intent b
                  WHERE b.shipment_id = s.shipment_id
                  ORDER BY b.created_at DESC LIMIT 1) AS booking_intent_id
           FROM shipment s
          WHERE s.shop_id = $1 AND s.shipment_id = $2
          FOR UPDATE`,
        [input.shopId, input.shipmentId],
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return { cancelled: false, code: 'SHIPMENT_NOT_FOUND' };
      }
      shipment = rows[0];
      if (shipment.booking_state !== 'CONFIRMED') {
        await client.query('ROLLBACK');
        return {
          cancelled: false,
          code: 'INVALID_BOOKING_STATE',
          currentState: shipment.booking_state,
        };
      }
      // §3.3: only the pre-pickup states can enter CANCEL_REQUESTED.
      if (!['PICKUP_PENDING', 'PICKUP_SCHEDULED'].includes(shipment.custody_state)) {
        await client.query('ROLLBACK');
        return {
          cancelled: false,
          code: 'INVALID_CUSTODY_STATE',
          currentCustody: shipment.custody_state,
        };
      }
      previousCustody = shipment.custody_state;
      await client.query(
        `UPDATE shipment SET custody_state = 'CANCEL_REQUESTED', version = version + 1
          WHERE shop_id = $1 AND shipment_id = $2`,
        [input.shopId, input.shipmentId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'MEMBER',
      actorId: input.actorId,
      action: 'booking.cancel_requested', // §12: cancellation is always audited
      objectType: 'shipment',
      objectId: input.shipmentId,
      before: { custodyState: previousCustody },
      after: { custodyState: 'CANCEL_REQUESTED' },
    });

    // Phase 2 — the adapter call (limiter → breaker → adapter).
    let result: CancelShipmentResult;
    try {
      result = await this.adapterCaller.call(
        input.shopId,
        shipment.courier_account_id as string,
        'cancelShipment',
        (adapter) => adapter.cancelShipment(shipment.awb_raw ?? (shipment.awb_normalized as string)),
      );
    } catch (err) {
      // An ambiguous cancel (timeout/transport failure after the call may
      // have left) is handled like OUTCOME_UNKNOWN (§3.2): stay in
      // CANCEL_REQUESTED, flag, reverse nothing.
      this.logger.warn(`cancel call ambiguous for shipment=${input.shipmentId}: ${(err as Error).name}`);
      result = { kind: 'OUTCOME_UNKNOWN', reason: (err as Error).name };
    }

    if (result.kind === 'CANCELLED') {
      return this.settleCancelled(input, shipment, previousCustody);
    }
    if (result.kind === 'REJECTED') {
      return this.settleRejected(input, previousCustody, result.reason);
    }
    return this.flagOutcomeUnknown(input);
  }

  /** Courier confirmed the cancellation — but only settle while the shipment
   *  is still in CANCEL_REQUESTED; the §3.3 race wins otherwise. */
  private async settleCancelled(
    input: { shopId: string; shipmentId: string; actorId: string },
    shipment: CancelLockRow,
    previousCustody: CustodyState,
  ): Promise<CancelResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ custody_state: CustodyState }>(
        `SELECT custody_state FROM shipment
          WHERE shop_id = $1 AND shipment_id = $2 FOR UPDATE`,
        [input.shopId, input.shipmentId],
      );
      const custody = rows[0]?.custody_state;
      if (custody === 'IN_CUSTODY') {
        // §3.3: a PICKED_UP event arrived while cancellation was pending —
        // the point of no return. Flag for review; NO entitlement reversal
        // (§9.5.6), no VOID.
        await client.query('COMMIT');
        await this.audit.record({
          shopId: input.shopId,
          actorKind: 'SYSTEM',
          action: 'booking.cancel_pickup_race', // §12
          objectType: 'shipment',
          objectId: input.shipmentId,
          before: { custodyState: 'CANCEL_REQUESTED' },
          after: { custodyState: 'IN_CUSTODY', flaggedForReview: true },
          reason: '§3.3 race: courier confirmed cancellation after PICKED_UP',
        });
        return {
          cancelled: false,
          code: 'CANCEL_PICKUP_RACE',
          flaggedForReview: true,
        };
      }
      if (custody !== 'CANCEL_REQUESTED') {
        // Already settled by a concurrent path — idempotent success.
        await client.query('COMMIT');
        return { cancelled: true };
      }
      // CONFIRMED → VOID (§3.2) + CANCEL_REQUESTED → CANCELLED (§3.3); the
      // Collectible returns to the Order (§4.7).
      await client.query(
        `UPDATE shipment
            SET custody_state = 'CANCELLED',
                booking_state = 'VOID',
                collectible = '0.00',
                version = version + 1
          WHERE shop_id = $1 AND shipment_id = $2 AND custody_state = 'CANCEL_REQUESTED'`,
        [input.shopId, input.shipmentId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    // INV-12: at most one REVERSAL, only after courier-confirmed cancellation
    // before any pickup event. Test shipments never had a debit (INV-19).
    if (!shipment.is_test) {
      const { rows: subs } = await this.pool.query<{
        subscription_id: string;
        cycle_start_at: string | null;
      }>(
        `SELECT subscription_id, cycle_start_at FROM subscription
          WHERE shop_id = $1 AND state IN ('TRIALING', 'ACTIVE')
          ORDER BY created_at DESC LIMIT 1`,
        [input.shopId],
      );
      if (subs[0]?.cycle_start_at) {
        const reversal = await this.ledger.reverse({
          shopId: input.shopId,
          subscriptionId: subs[0].subscription_id,
          cycleStartAt: subs[0].cycle_start_at,
          shipmentId: input.shipmentId,
          bookingIntentId: shipment.booking_intent_id,
          courierConfirmedPrePickup: true, // we are exactly in this case
        });
        // §9.5.6: an already-submitted overage is held as an equal credit (or
        // reversed where the API safely supports it) — never a negative
        // usage call. Only when the ledger actually reversed; the ambiguous
        // race flags for review and reverses nothing.
        if (reversal.reversed && this.overage) {
          try {
            await this.overage.reverseOverageForShipment({
              shopId: input.shopId,
              subscriptionId: subs[0].subscription_id,
              shipmentId: input.shipmentId,
            });
          } catch (err) {
            this.logger.warn(
              `overage reversal failed for shipment=${input.shipmentId}: ${(err as Error).name}`,
            );
          }
        }
      }
    }

    // §4.7: release the Collectible; if every sibling is already booked this
    // derives cod_assignment_state = UNASSIGNED (surfaced, never silent).
    await this.derivation.recomputeCodAssignment(input.shopId, shipment.order_id);

    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'MEMBER',
      actorId: input.actorId,
      action: 'booking.cancelled', // §12
      objectType: 'shipment',
      objectId: input.shipmentId,
      before: { bookingState: 'CONFIRMED', custodyState: previousCustody },
      after: { bookingState: 'VOID', custodyState: 'CANCELLED' },
    });
    return { cancelled: true };
  }

  /** §3.3: CANCEL_REQUESTED → CANCEL_REJECTED → previous state. */
  private async settleRejected(
    input: { shopId: string; shipmentId: string; actorId: string },
    previousCustody: CustodyState,
    reason: string | null,
  ): Promise<CancelResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE shipment SET custody_state = 'CANCEL_REJECTED', version = version + 1
          WHERE shop_id = $1 AND shipment_id = $2 AND custody_state = 'CANCEL_REQUESTED'`,
        [input.shopId, input.shipmentId],
      );
      await client.query(
        `UPDATE shipment SET custody_state = $3, version = version + 1
          WHERE shop_id = $1 AND shipment_id = $2 AND custody_state = 'CANCEL_REJECTED'`,
        [input.shopId, input.shipmentId, previousCustody],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'SYSTEM',
      action: 'booking.cancel_rejected', // §12
      objectType: 'shipment',
      objectId: input.shipmentId,
      after: { custodyState: previousCustody },
      reason: reason ?? 'courier refused cancellation',
    });
    return {
      cancelled: false,
      code: 'CANCEL_REJECTED',
      currentCustody: previousCustody,
      reason,
    };
  }

  /** Ambiguous cancel outcome: stay in CANCEL_REQUESTED, flag, no reversal. */
  private async flagOutcomeUnknown(input: {
    shopId: string;
    shipmentId: string;
    actorId: string;
  }): Promise<CancelResult> {
    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'SYSTEM',
      action: 'booking.cancel_outcome_unknown', // §12
      objectType: 'shipment',
      objectId: input.shipmentId,
      after: { custodyState: 'CANCEL_REQUESTED', flaggedForReview: true },
      reason: 'cancel outcome ambiguous (§3.2 OUTCOME_UNKNOWN handling): no reversal',
    });
    return {
      cancelled: false,
      code: 'CANCEL_OUTCOME_UNKNOWN',
      currentCustody: 'CANCEL_REQUESTED',
      flaggedForReview: true,
    };
  }
}
