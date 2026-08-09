import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { AdapterCallerService } from '../courier-framework/adapter-caller.service';
import {
  SYNC_BACK_PUBLISHER,
  SyncBackPublisher,
} from '../booking-ops/sync-back-publisher';
import {
  AccountBudgetExhaustedError,
  AdapterRateLimitError,
  CircuitOpenError,
  CourierAuthError,
} from '../courier-framework/adapter-errors';
import { UnsupportedCapabilityError } from '../courier-framework/adapter.types';
import type {
  CreateShipmentRequest,
  CreateShipmentResult,
} from '../courier-framework/adapter.types';
import { EntitlementLedgerService } from '../platform/ledger/entitlement-ledger.service';
import { OrderDerivationService } from '../order-derivation/order-derivation.service';
import { GstInvoiceService } from '../gst/gst-invoice.service';
import { BuyerNotificationService } from '../notifications/buyer-notification.service';
import { OverageService } from '../billing/overage.service';
import { BillingAlertsService } from '../billing/billing-alerts.service';
import { normalizeAwb } from './snapshot';
import type {
  BookingJobData,
  BookingSnapshot,
  BookingState,
  ResolveOutcome,
} from './booking.types';

/**
 * The booking worker (§3.2 QUEUED → SUBMITTED → CONFIRMED / FAILED /
 * OUTCOME_UNKNOWN) and the §9.5.4 exactly-once protocol.
 *
 *  - The create request is built from the FROZEN snapshot (INV-8), never
 *    from working values or current master data.
 *  - Transport retries reuse the same booking intent and digest (§8.2); a
 *    timeout or any ambiguous post-call failure settles as OUTCOME_UNKNOWN
 *    and is NEVER retried with a second create (INV-5). Pre-call
 *    back-pressure (open breaker, exhausted budget, provider rate limit)
 *    rethrows so BullMQ retries the same intent — no create was issued.
 *  - CONFIRMED enforces INV-6 AWB uniqueness under an advisory lock keyed on
 *    (courier_account_id, awb_normalized) — the partitioned shipment table
 *    cannot hold the unique index (migration 0003 header). A duplicate is
 *    quarantined and flagged, never overwritten (INV-20).
 *  - Entitlement debits exactly once, at CONFIRMED, for non-test shipments
 *    only (INV-12, INV-19) via the ledger's idempotent debit.
 */

interface ShipmentLockRow {
  shipment_id: string;
  shop_id: string;
  order_id: string;
  courier_account_id: string | null;
  booking_state: BookingState;
  expected_cost_basis: string | null;
  snapshot: BookingSnapshot | null;
}

interface IntentRow {
  booking_intent_id: string;
  outcome: string;
  merchant_reference: string;
  request_digest: string;
}

@Injectable()
export class BookingWorkerService {
  private readonly logger = new Logger(BookingWorkerService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly adapterCaller: AdapterCallerService,
    private readonly ledger: EntitlementLedgerService,
    private readonly derivation: OrderDerivationService,
    // §9.6 seam: the real publisher comes from SyncBackModule; when no
    // module provides it, CONFIRMED bookings simply skip the Shopify write.
    @Optional()
    @Inject(SYNC_BACK_PUBLISHER)
    private readonly syncBackPublisher?: SyncBackPublisher,
    private readonly gstInvoice?: GstInvoiceService,
    @Optional()
    private readonly buyerNotifications?: BuyerNotificationService,
    @Optional()
    private readonly overage?: OverageService,
    @Optional()
    private readonly billingAlerts?: BillingAlertsService,
  ) {}

  /* ------------------------------------------------------------------------
   * The BullMQ job entry point.
   * --------------------------------------------------------------------- */

  async processBooking(data: BookingJobData): Promise<void> {
    // Phase 1 — claim: QUEUED → SUBMITTED (§3.2, worker transition). Guard:
    // the booking intent exists and its digest was computed (queue time).
    const client = await this.pool.connect();
    let shipment: ShipmentLockRow;
    let intent: IntentRow;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ShipmentLockRow>(
        `SELECT shipment_id, shop_id, order_id, courier_account_id,
                booking_state, expected_cost_basis, snapshot
           FROM shipment
          WHERE shop_id = $1 AND shipment_id = $2
          FOR UPDATE`,
        [data.shopId, data.shipmentId],
      );
      if (!rows[0]) {
        await client.query('COMMIT');
        return; // gone — nothing to do
      }
      shipment = rows[0];
      const { rows: intentRows } = await client.query<IntentRow>(
        `SELECT booking_intent_id, outcome, merchant_reference, request_digest
           FROM booking_intent
          WHERE shipment_id = $1 AND booking_intent_id = $2`,
        [data.shipmentId, data.bookingIntentId],
      );
      if (!intentRows[0]) {
        await client.query('COMMIT');
        return;
      }
      intent = intentRows[0];
      // Idempotent re-drive: a settled intent or a state outside
      // QUEUED/SUBMITTED means a duplicate delivery of this job — no second
      // create, ever (INV-5).
      if (
        !['IN_FLIGHT'].includes(intent.outcome) ||
        !['QUEUED', 'SUBMITTED'].includes(shipment.booking_state)
      ) {
        await client.query('COMMIT');
        return;
      }
      if (shipment.booking_state === 'QUEUED') {
        await client.query(
          `UPDATE shipment SET booking_state = 'SUBMITTED', version = version + 1
            WHERE shop_id = $1 AND shipment_id = $2 AND booking_state = 'QUEUED'`,
          [data.shopId, data.shipmentId],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    // Phase 2 — the adapter create, from the frozen snapshot (INV-8).
    const snapshot = shipment.snapshot;
    if (!snapshot) {
      // The §2.9 freeze is guaranteed by the DRAFT → QUEUED write path; its
      // absence is a defect and must fail loudly, not silently re-derive.
      throw new Error(`shipment ${data.shipmentId} reached SUBMITTED without a frozen snapshot`);
    }
    const request: CreateShipmentRequest = {
      intent: {
        bookingIntentId: intent.booking_intent_id,
        requestDigest: intent.request_digest,
        merchantReference: intent.merchant_reference,
      },
      // Aggregators map the booked Service to their nested courier identity
      // (§9.3.4, §15.1). From the frozen snapshot, never current data (INV-8).
      serviceId: snapshot.service?.serviceId ?? '',
      originPincode: snapshot.formulaInputs.originPincode,
      destinationPincode: snapshot.formulaInputs.destinationPincode,
      deadWeightKg: snapshot.formulaInputs.deadWeightKg,
      lengthCm: snapshot.formulaInputs.lengthCm,
      widthCm: snapshot.formulaInputs.widthCm,
      heightCm: snapshot.formulaInputs.heightCm,
      paymentMode: snapshot.formulaInputs.paymentMode,
      collectible: snapshot.formulaInputs.collectible,
      declaredValue: snapshot.formulaInputs.declaredValue,
      recipient: {
        name: snapshot.recipient?.name ?? '',
        addressLines: snapshot.recipient?.addressLines ?? [],
        city: snapshot.recipient?.city ?? '',
        state: snapshot.recipient?.state ?? '',
        pincode: snapshot.recipient?.pincode ?? '',
        phone: snapshot.recipient?.phone ?? '',
        email: snapshot.recipient?.email ?? null,
      },
      pickupLocationId: snapshot.pickupLocation?.pickupLocationId ?? '',
    };

    let result: CreateShipmentResult;
    try {
      result = await this.adapterCaller.call(
        data.shopId,
        data.courierAccountId,
        'createShipment',
        (adapter) => adapter.createShipment(request),
      );
    } catch (err) {
      // Pre-call back-pressure: no create was issued — BullMQ retries the
      // SAME intent and digest (§8.2 transport policy).
      if (
        err instanceof CircuitOpenError ||
        err instanceof AccountBudgetExhaustedError ||
        err instanceof AdapterRateLimitError
      ) {
        throw err;
      }
      // Definitive provider rejections (§3.2 SUBMITTED → FAILED).
      if (err instanceof CourierAuthError || err instanceof UnsupportedCapabilityError) {
        await this.settleFailed({
          data,
          fromStates: ['SUBMITTED'],
          intentOutcome: 'FAILED',
          reasons: [err.name],
          actor: { kind: 'SYSTEM', id: null },
        });
        return;
      }
      // Anything else may have left the process — ambiguous (INV-5).
      await this.markOutcomeUnknown(data);
      return;
    }

    // Phase 3 — settle the outcome.
    if (result.kind === 'CONFIRMED' && result.awb) {
      await this.confirmBooking({
        data,
        awbRaw: result.awb,
        confirmedCharge: result.confirmedCharge,
        intentOutcome: 'CONFIRMED',
      });
    } else if (result.kind === 'FAILED') {
      await this.settleFailed({
        data,
        fromStates: ['SUBMITTED'],
        intentOutcome: 'FAILED',
        reasons: result.failureReasons,
        actor: { kind: 'SYSTEM', id: null },
      });
    } else {
      // OUTCOME_UNKNOWN, or a defective "CONFIRMED" with no AWB — ambiguous
      // either way; INV-5 treats both identically.
      await this.markOutcomeUnknown(data);
    }
  }

  /* ------------------------------------------------------------------------
   * SUBMITTED → CONFIRMED — the shared write path (also the
   * OUTCOME_UNKNOWN → CONFIRMED resolution, §3.2).
   * --------------------------------------------------------------------- */

  async confirmBooking(args: {
    data: BookingJobData;
    awbRaw: string;
    confirmedCharge: string | null;
    intentOutcome: 'CONFIRMED' | 'RESOLVED_CONFIRMED';
    resolvedByMemberId?: string | null;
  }): Promise<{ confirmed: boolean; reason?: string; awbNormalized?: string }> {
    const { data } = args;
    const awbNormalized = normalizeAwb(args.awbRaw); // F-19
    const client = await this.pool.connect();
    let orderId: string;
    let isTest = false;
    let basis: string;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ShipmentLockRow>(
        `SELECT shipment_id, shop_id, order_id, courier_account_id,
                booking_state, expected_cost_basis, snapshot
           FROM shipment
          WHERE shop_id = $1 AND shipment_id = $2
          FOR UPDATE`,
        [data.shopId, data.shipmentId],
      );
      const shipment = rows[0];
      if (!shipment || !['SUBMITTED', 'OUTCOME_UNKNOWN'].includes(shipment.booking_state)) {
        await client.query('ROLLBACK');
        return { confirmed: false, reason: 'INVALID_STATE' };
      }
      orderId = shipment.order_id;

      // INV-6: uniqueness on (shop_id, courier_account_id, awb_normalized).
      // The partitioned table cannot hold the index, so the booking
      // transaction enforces it under an advisory lock on the key.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `${shipment.courier_account_id ?? ''}:${awbNormalized}`,
      ]);
      const { rows: dupes } = await client.query<{ shipment_id: string }>(
        `SELECT shipment_id FROM shipment
          WHERE shop_id = $1 AND courier_account_id = $2 AND awb_normalized = $3
            AND shipment_id <> $4 AND booking_state <> 'VOID'
          LIMIT 1`,
        [data.shopId, shipment.courier_account_id, awbNormalized, data.shipmentId],
      );
      if (dupes[0]) {
        // INV-20: quarantine and flag — the AWB is never stored on this
        // shipment, no debit happens, and nothing is overwritten.
        await client.query(
          `UPDATE shipment SET booking_state = 'FAILED', version = version + 1
            WHERE shop_id = $1 AND shipment_id = $2`,
          [data.shopId, data.shipmentId],
        );
        await client.query(
          `UPDATE booking_intent SET outcome = 'FAILED', resolved_at = now()
            WHERE booking_intent_id = $1`,
          [data.bookingIntentId],
        );
        await client.query(
          `INSERT INTO dlq_item (shop_id, queue, payload, error)
           VALUES ($1, 'booking', $2, $3)`,
          [
            data.shopId,
            JSON.stringify({
              shipmentId: data.shipmentId,
              bookingIntentId: data.bookingIntentId,
              conflictingShipmentId: dupes[0].shipment_id,
            }),
            `INV-6 duplicate AWB quarantined (courier account ${shipment.courier_account_id})`,
          ],
        );
        await client.query('COMMIT');
        await this.audit.record({
          shopId: data.shopId,
          actorKind: 'SYSTEM',
          action: 'booking.awb_duplicate_quarantined', // §12, INV-20
          objectType: 'shipment',
          objectId: data.shipmentId,
          after: { conflictingShipmentId: dupes[0].shipment_id },
        });
        return { confirmed: false, reason: 'DUPLICATE_AWB_QUARANTINED' };
      }

      // INV-19: is_test is inherited from the courier account's mode at
      // booking, written here at CONFIRMED and immutable afterwards.
      const { rows: accounts } = await client.query<{ mode: string }>(
        `SELECT mode FROM courier_account
          WHERE courier_account_id = $1 AND shop_id = $2`,
        [shipment.courier_account_id, data.shopId],
      );
      isTest = accounts[0]?.mode === 'TEST';

      // §3.25 / §4.5: a frozen quote keeps SNAPSHOT_QUOTE; otherwise the
      // provider's confirmed charge becomes the expectation, else NONE
      // (reconciles on weight only).
      basis =
        shipment.expected_cost_basis === 'SNAPSHOT_QUOTE'
          ? 'SNAPSHOT_QUOTE'
          : args.confirmedCharge
            ? 'PROVIDER_CONFIRMED_CHARGE'
            : 'NONE';

      await client.query(
        `UPDATE shipment
            SET booking_state = 'CONFIRMED',
                awb_raw = $3,
                awb_normalized = $4,
                booked_at = now(),
                custody_state = 'PICKUP_PENDING',   -- §3.3 NOT_APPLICABLE → PICKUP_PENDING
                expected_cost_basis = $5::expected_cost_basis,
                provider_confirmed_charge = $7::numeric(19,4),     -- §3.25: persisted for §4.8
                is_test = $6,
                version = version + 1
          WHERE shop_id = $1 AND shipment_id = $2`,
        [
          data.shopId,
          data.shipmentId,
          args.awbRaw,
          awbNormalized,
          basis,
          isTest,
          basis === 'PROVIDER_CONFIRMED_CHARGE' ? args.confirmedCharge : null,
        ],
      );
      await client.query(
        `UPDATE booking_intent
            SET outcome = $2::booking_intent_outcome,
                resolved_at = CASE WHEN $2::booking_intent_outcome IN ('RESOLVED_CONFIRMED', 'RESOLVED_FAILED')
                                   THEN now() ELSE resolved_at END,
                resolved_by = $3
          WHERE booking_intent_id = $1`,
        [data.bookingIntentId, args.intentOutcome, args.resolvedByMemberId ?? null],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    // INV-12 / INV-19: exactly one DEBIT per durably-confirmed non-test AWB.
    // Post-commit and idempotent (the ledger's unique index treats a repeat
    // as success, never an error — A1-04).
    if (!isTest) {
      const { rows: subs } = await this.pool.query<{
        subscription_id: string;
        cycle_start_at: string | null;
      }>(
        `SELECT subscription_id, cycle_start_at FROM subscription
          WHERE shop_id = $1 AND state IN ('TRIALING', 'ACTIVE')
          ORDER BY created_at DESC LIMIT 1`,
        [data.shopId],
      );
      if (subs[0]?.cycle_start_at) {
        await this.ledger.debit({
          shopId: data.shopId,
          subscriptionId: subs[0].subscription_id,
          cycleStartAt: subs[0].cycle_start_at,
          shipmentId: data.shipmentId,
          bookingIntentId: data.bookingIntentId,
          isTest: false,
        });
        // §9.5.6: emit the single overage usage record when this AWB pushed
        // the cycle past the plan allowance (never gates the booking), and
        // §9.14: the 80%/100% allowance alerts (§9.21).
        if (this.overage) {
          try {
            await this.overage.recordOverageForShipment({
              shopId: data.shopId,
              subscriptionId: subs[0].subscription_id,
              shipmentId: data.shipmentId,
            });
          } catch (err) {
            this.logger.warn(`overage record failed for shipment=${data.shipmentId}: ${(err as Error).name}`);
          }
        }
        if (this.billingAlerts) {
          try {
            await this.billingAlerts.checkAllowanceThresholds(data.shopId);
          } catch (err) {
            this.logger.warn(`allowance alert check failed for shop=${data.shopId}: ${(err as Error).name}`);
          }
        }
      } else {
        this.logger.warn(`no active subscription for entitlement debit; shipment=${data.shipmentId}`);
      }
    }

    await this.audit.record({
      shopId: data.shopId,
      actorKind: args.resolvedByMemberId ? 'MEMBER' : 'SYSTEM',
      actorId: args.resolvedByMemberId ?? null,
      action:
        args.intentOutcome === 'RESOLVED_CONFIRMED'
          ? 'booking.outcome_unknown_resolved' // §12
          : 'booking.confirmed',
      objectType: 'shipment',
      objectId: data.shipmentId,
      after: {
        bookingState: 'CONFIRMED',
        custodyState: 'PICKUP_PENDING',
        expectedCostBasis: basis,
        isTest,
        via: args.intentOutcome === 'RESOLVED_CONFIRMED' ? 'RESOLVED_CONFIRMED' : undefined,
      },
    });

    // §4.7 / §3.24: the Collectible now sits on an active AWB — derive
    // cod_assignment_state (ASSIGNED). Never gates the booking (INV-21-style:
    // derivation can be re-run).
    try {
      await this.derivation.recomputeCodAssignment(data.shopId, orderId);
    } catch (err) {
      this.logger.warn(`cod reassignment after confirm failed: ${(err as Error).name}`);
    }

    // §9.6 / §8.4: one fulfillment per Shipment via the outbox. Test
    // shipments write nothing to Shopify (INV-19) — skip before publishing.
    // The publisher never gates the booking (failure is logged, not thrown).
    if (!isTest && this.syncBackPublisher) {
      try {
        await this.syncBackPublisher.enqueueFulfillmentCreate(data.shipmentId);
      } catch (err) {
        this.logger.warn(
          `sync-back publish failed for shipment=${data.shipmentId}: ${(err as Error).name}`,
        );
      }
    }

    // §9.9.2: one GST invoice per Order, created at first outbound booking
    // in ISSUE_PENDING. Never gates the booking (INV-7, A2-07); the service
    // itself no-ops for test shipments (INV-19).
    if (this.gstInvoice) {
      try {
        await this.gstInvoice.onShipmentConfirmed(data.shopId, data.shipmentId);
      } catch (err) {
        this.logger.warn(
          `gst invoice hook failed for shipment=${data.shipmentId}: ${(err as Error).name}`,
        );
      }
    }

    // ADD-26: the buyer "shipped" message (AWB + per-shipment track link).
    // Never gates the booking (INV-21); test shipments excluded inside.
    if (this.buyerNotifications) {
      try {
        await this.buyerNotifications.onShipmentBooked(data.shopId, data.shipmentId);
      } catch (err) {
        this.logger.warn(
          `buyer shipped-notification failed for shipment=${data.shipmentId}: ${(err as Error).name}`,
        );
      }
    }
    return { confirmed: true, awbNormalized };
  }

  /* ------------------------------------------------------------------------
   * SUBMITTED → FAILED / OUTCOME_UNKNOWN, and the §9.5.4 resolvers.
   * --------------------------------------------------------------------- */

  private async settleFailed(args: {
    data: BookingJobData;
    fromStates: BookingState[];
    intentOutcome: 'FAILED' | 'RESOLVED_FAILED';
    reasons: string[];
    actor: { kind: 'MEMBER' | 'SYSTEM'; id: string | null };
  }): Promise<void> {
    const { data } = args;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE shipment SET booking_state = 'FAILED', version = version + 1
          WHERE shop_id = $1 AND shipment_id = $2 AND booking_state = ANY($3)`,
        [data.shopId, data.shipmentId, args.fromStates],
      );
      if (rowCount === 1) {
        await client.query(
          `UPDATE booking_intent
              SET outcome = $2,
                  resolved_at = CASE WHEN $2 = 'RESOLVED_FAILED' THEN now() ELSE resolved_at END,
                  resolved_by = $3
            WHERE booking_intent_id = $1`,
          [data.bookingIntentId, args.intentOutcome, args.actor.id],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    // §12: the failure carries the provider's structured codes only — never
    // free text or payloads (§5.7 control 4).
    await this.audit.record({
      shopId: data.shopId,
      actorKind: args.actor.kind,
      actorId: args.actor.id,
      action:
        args.intentOutcome === 'RESOLVED_FAILED'
          ? 'booking.outcome_unknown_resolved'
          : 'booking.failed',
      objectType: 'shipment',
      objectId: data.shipmentId,
      after: { bookingState: 'FAILED', failureReasons: args.reasons },
    });
  }

  /** SUBMITTED → OUTCOME_UNKNOWN: no second create, no debit (INV-5). */
  private async markOutcomeUnknown(data: BookingJobData): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE shipment SET booking_state = 'OUTCOME_UNKNOWN', version = version + 1
          WHERE shop_id = $1 AND shipment_id = $2 AND booking_state = 'SUBMITTED'`,
        [data.shopId, data.shipmentId],
      );
      if (rowCount === 1) {
        await client.query(
          `UPDATE booking_intent SET outcome = 'UNKNOWN' WHERE booking_intent_id = $1`,
          [data.bookingIntentId],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    await this.audit.record({
      shopId: data.shopId,
      actorKind: 'SYSTEM',
      action: 'booking.outcome_unknown', // §12 — resolution is always audited
      objectType: 'shipment',
      objectId: data.shipmentId,
      after: { bookingState: 'OUTCOME_UNKNOWN' },
      reason: 'INV-5: no second create and no entitlement debit until resolved',
    });
  }

  private async loadOutcomeUnknown(
    shopId: string,
    shipmentId: string,
  ): Promise<{ intent: IntentRow; courierAccountId: string } | ResolveOutcome> {
    const { rows } = await this.pool.query<{
      booking_state: BookingState;
      courier_account_id: string | null;
    }>(
      `SELECT booking_state, courier_account_id FROM shipment
        WHERE shop_id = $1 AND shipment_id = $2`,
      [shopId, shipmentId],
    );
    if (!rows[0]) return { resolved: false, code: 'SHIPMENT_NOT_FOUND' };
    if (rows[0].booking_state !== 'OUTCOME_UNKNOWN') {
      return { resolved: false, code: 'INVALID_STATE', currentState: rows[0].booking_state };
    }
    const { rows: intents } = await this.pool.query<IntentRow>(
      `SELECT booking_intent_id, outcome, merchant_reference, request_digest
         FROM booking_intent
        WHERE shipment_id = $1 AND outcome = 'UNKNOWN'
        ORDER BY created_at DESC LIMIT 1`,
      [shipmentId],
    );
    if (!intents[0] || !rows[0].courier_account_id) {
      return { resolved: false, code: 'INVALID_STATE', currentState: rows[0].booking_state };
    }
    return { intent: intents[0], courierAccountId: rows[0].courier_account_id };
  }

  /**
   * §9.5.4: resolve an OUTCOME_UNKNOWN booking via the provider's
   * lookupByReference (§8.2 — required of every adapter; where unsupported
   * the adapter throws UnsupportedCapabilityError and the operator path is
   * the fallback, RW-12). INV-5 held until this returns.
   */
  async resolveOutcomeUnknown(shopId: string, shipmentId: string): Promise<ResolveOutcome> {
    const loaded = await this.loadOutcomeUnknown(shopId, shipmentId);
    if ('resolved' in loaded) return loaded;
    const { intent, courierAccountId } = loaded;

    const lookup = await this.adapterCaller.call(
      shopId,
      courierAccountId,
      'lookupByReference',
      (adapter) => adapter.lookupByReference(intent.merchant_reference),
    );
    const data: BookingJobData = {
      shopId,
      shipmentId,
      bookingIntentId: intent.booking_intent_id,
      merchantReference: intent.merchant_reference,
      serviceId: '',
      courierAccountId,
    };
    if (lookup.found && lookup.awb) {
      // RESOLVED_CONFIRMED — complete the CONFIRMED write path (§3.2).
      const confirmed = await this.confirmBooking({
        data,
        awbRaw: lookup.awb,
        confirmedCharge: null,
        intentOutcome: 'RESOLVED_CONFIRMED',
      });
      return confirmed.confirmed
        ? { resolved: true, outcome: 'RESOLVED_CONFIRMED', awbNormalized: confirmed.awbNormalized }
        : { resolved: false, code: 'INVALID_STATE' };
    }
    // The provider proved no shipment exists → RESOLVED_FAILED → FAILED;
    // the next queueBooking re-enters DRAFT under a NEW intent (§3.2, §9.5.4).
    await this.settleFailed({
      data,
      fromStates: ['OUTCOME_UNKNOWN'],
      intentOutcome: 'RESOLVED_FAILED',
      reasons: ['LOOKUP_NOT_FOUND'],
      actor: { kind: 'SYSTEM', id: null },
    });
    return { resolved: true, outcome: 'RESOLVED_FAILED' };
  }

  /**
   * §3.2 / §9.5.4: the explicit Operator+ resolution of an OUTCOME_UNKNOWN
   * booking — always audited (§12). CONFIRMED requires the AWB the operator
   * obtained from the courier; FAILED releases the shipment for retry.
   */
  async resolveOutcomeUnknownByOperator(
    shopId: string,
    shipmentId: string,
    memberId: string,
    decision: { outcome: 'CONFIRMED'; awb: string } | { outcome: 'FAILED' },
  ): Promise<ResolveOutcome> {
    const loaded = await this.loadOutcomeUnknown(shopId, shipmentId);
    if ('resolved' in loaded) return loaded;
    const { intent, courierAccountId } = loaded;
    const data: BookingJobData = {
      shopId,
      shipmentId,
      bookingIntentId: intent.booking_intent_id,
      merchantReference: intent.merchant_reference,
      serviceId: '',
      courierAccountId,
    };
    if (decision.outcome === 'CONFIRMED') {
      const confirmed = await this.confirmBooking({
        data,
        awbRaw: decision.awb,
        confirmedCharge: null,
        intentOutcome: 'RESOLVED_CONFIRMED',
        resolvedByMemberId: memberId,
      });
      return confirmed.confirmed
        ? { resolved: true, outcome: 'RESOLVED_CONFIRMED', awbNormalized: confirmed.awbNormalized }
        : { resolved: false, code: 'INVALID_STATE' };
    }
    await this.settleFailed({
      data,
      fromStates: ['OUTCOME_UNKNOWN'],
      intentOutcome: 'RESOLVED_FAILED',
      reasons: ['OPERATOR_RESOLVED_FAILED'],
      actor: { kind: 'MEMBER', id: memberId },
    });
    return { resolved: true, outcome: 'RESOLVED_FAILED' };
  }
}
