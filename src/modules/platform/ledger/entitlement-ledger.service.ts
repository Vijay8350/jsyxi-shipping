import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../database/database.module';
import { AuditService } from '../../../audit/audit.service';

/**
 * AWB entitlement ledger (INV-12, §9.5.6) — the ONLY writer to
 * `awb_entitlement_ledger`. The table is append-only (trigger + revoked
 * UPDATE/DELETE, migration 0002); this service only ever INSERTs and SELECTs.
 *
 * - Exactly one DEBIT per durably-confirmed non-test AWB. The unique partial
 *   index is the enforcer; a unique violation is treated as idempotent
 *   success, never an error — booking retries must not double-debit (A1-04).
 * - Test shipments NEVER produce a ledger entry (INV-19).
 * - At most one REVERSAL, and only after courier-confirmed cancellation
 *   before any pickup event; the ambiguous cancel/pickup race reverses
 *   nothing and is flagged for review (§9.5.6).
 * - The ledger records plan allowance only — no margin, balance, wallet or
 *   payout concept exists here (INV-23).
 */

export interface LedgerDebitInput {
  shopId: string;
  subscriptionId: string;
  cycleStartAt: string | Date;
  shipmentId: string;
  bookingIntentId: string | null;
  /** INV-19 guard: test shipments are excluded from entitlement debits. */
  isTest: boolean;
}

export type LedgerDebitResult =
  | { debited: true; entryId: string }
  | { debited: false; reason: 'TEST_SHIPMENT' | 'ALREADY_DEBITED' };

export interface LedgerReverseInput {
  shopId: string;
  subscriptionId: string;
  cycleStartAt: string | Date;
  shipmentId: string;
  bookingIntentId: string | null;
  /**
   * §9.5.6 guard: a reversal requires courier-confirmed cancellation before
   * any pickup event. Without this explicit confirmation the cancel/pickup
   * race is ambiguous — nothing is reversed and the case is flagged.
   */
  courierConfirmedPrePickup: boolean;
}

export type LedgerReverseResult =
  | { reversed: true; entryId: string }
  | {
      reversed: false;
      reason: 'ALREADY_REVERSED';
      flaggedForReview: false;
    }
  | {
      reversed: false;
      reason: 'NOT_COURIER_CONFIRMED_PRE_PICKUP';
      flaggedForReview: true;
    };

export interface AllowanceBalance {
  debits: number;
  reversals: number;
  /** AWBs consumed from the plan allowance this cycle (debits - reversals). */
  consumed: number;
}

interface PgError {
  code?: string;
  constraint?: string;
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as PgError;
  return e?.code === '23505' && (e.constraint ?? '').includes(constraint);
}

@Injectable()
export class EntitlementLedgerService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  async debit(input: LedgerDebitInput): Promise<LedgerDebitResult> {
    // INV-19: test shipments never produce a ledger entry.
    if (input.isTest) return { debited: false, reason: 'TEST_SHIPMENT' };
    try {
      const result = await this.pool.query<{ entry_id: string }>(
        `INSERT INTO awb_entitlement_ledger
           (shop_id, subscription_id, cycle_start_at, shipment_id,
            direction, booking_intent_id)
         VALUES ($1, $2, $3, $4, 'DEBIT', $5)
         RETURNING entry_id`,
        [
          input.shopId,
          input.subscriptionId,
          input.cycleStartAt,
          input.shipmentId,
          input.bookingIntentId,
        ],
      );
      // §12: entitlement debits are always audited. Actor is the booking
      // pipeline, not an HTTP actor — SYSTEM.
      await this.audit.record({
        shopId: input.shopId,
        actorKind: 'SYSTEM',
        action: 'entitlement.debit',
        objectType: 'awb_entitlement_ledger',
        objectId: result.rows[0].entry_id,
        after: {
          shipmentId: input.shipmentId,
          subscriptionId: input.subscriptionId,
          bookingIntentId: input.bookingIntentId,
        },
      });
      return { debited: true, entryId: result.rows[0].entry_id };
    } catch (err) {
      // The unique partial index enforces exactly one DEBIT per shipment
      // (INV-12); a violation means this AWB was already debited — an
      // idempotent success for booking retries, never an error (A1-04).
      if (isUniqueViolation(err, 'awb_ledger_one_debit')) {
        return { debited: false, reason: 'ALREADY_DEBITED' };
      }
      throw err;
    }
  }

  async reverse(input: LedgerReverseInput): Promise<LedgerReverseResult> {
    // §9.5.6: no courier-confirmed pre-pickup cancellation → the race is
    // ambiguous; reverse nothing and flag for review.
    if (!input.courierConfirmedPrePickup) {
      return {
        reversed: false,
        reason: 'NOT_COURIER_CONFIRMED_PRE_PICKUP',
        flaggedForReview: true,
      };
    }
    try {
      const result = await this.pool.query<{ entry_id: string }>(
        `INSERT INTO awb_entitlement_ledger
           (shop_id, subscription_id, cycle_start_at, shipment_id,
            direction, booking_intent_id)
         VALUES ($1, $2, $3, $4, 'REVERSAL', $5)
         RETURNING entry_id`,
        [
          input.shopId,
          input.subscriptionId,
          input.cycleStartAt,
          input.shipmentId,
          input.bookingIntentId,
        ],
      );
      // §12: entitlement reversals are always audited.
      await this.audit.record({
        shopId: input.shopId,
        actorKind: 'SYSTEM',
        action: 'entitlement.reversal',
        objectType: 'awb_entitlement_ledger',
        objectId: result.rows[0].entry_id,
        after: {
          shipmentId: input.shipmentId,
          subscriptionId: input.subscriptionId,
          bookingIntentId: input.bookingIntentId,
        },
      });
      return { reversed: true, entryId: result.rows[0].entry_id };
    } catch (err) {
      // At most one REVERSAL per shipment (INV-12) — a second attempt is an
      // idempotent no-op.
      if (isUniqueViolation(err, 'awb_ledger_one_reversal')) {
        return {
          reversed: false,
          reason: 'ALREADY_REVERSED',
          flaggedForReview: false,
        };
      }
      throw err;
    }
  }

  /** Debits minus reversals for the subscription cycle (§9.5.6). */
  async allowanceBalance(
    subscriptionId: string,
    cycleStartAt: string | Date,
  ): Promise<AllowanceBalance> {
    const result = await this.pool.query<{ direction: string; n: string }>(
      `SELECT direction, count(*)::text AS n
         FROM awb_entitlement_ledger
        WHERE subscription_id = $1 AND cycle_start_at = $2
        GROUP BY direction`,
      [subscriptionId, cycleStartAt],
    );
    let debits = 0;
    let reversals = 0;
    for (const row of result.rows) {
      if (row.direction === 'DEBIT') debits = Number(row.n);
      else if (row.direction === 'REVERSAL') reversals = Number(row.n);
    }
    return { debits, reversals, consumed: debits - reversals };
  }
}
