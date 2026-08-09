import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import { randomToken, saltedPiiHash, tokenHash } from '../../common/crypto';
import { AuditService } from '../../audit/audit.service';
import { BuyerNotificationService } from './buyer-notification.service';
import { NotificationSettingsService } from './notification-settings.service';
import {
  COD_CONFIRMATION_BOOKER,
  CodConfirmationBooker,
} from './cod-booker-seam';

/**
 * ADD-28: COD order confirmation before booking.
 *
 *  - start(): called by the parent from order-derivation, at the point a new
 *    order's payment_mode resolves to COD (binding: order-derivation/payment.ts
 *    handler chain). Creates the cod_confirmation row (PENDING) + a hashed
 *    single-purpose token and messages the buyer to confirm. One row per
 *    (shop, order) — a repeat call is a no-op.
 *  - The window: COD_CONFIRM_DEFAULT_WINDOW_MINUTES (60) unless the shop
 *    overrides codConfirmation.windowMinutes in notification_settings.
 *  - The buyer confirms via the public tokenized link (same pattern as
 *    ADD-27 / the track page) → CONFIRMED.
 *  - sweepExpired() (BullMQ repeatable, notifications-queue.ts): on expiry
 *    the shop's choice applies — BOOK_ANYWAY (default; calls the
 *    CodConfirmationBooker seam the parent binds to BookingService) or HOLD:
 *    the order's DRAFT shipments move to NEEDS_MANUAL_ASSIGNMENT with
 *    manual_assignment_reason COD_UNCONFIRMED (§3.30 value added in
 *    migration 0014).
 *
 *  S-11 respect: the confirmation window is expected to run INSIDE the
 *  auto-ship hold window — the hold choice consumes that window rather than
 *  fighting it (auto-ship must treat a PENDING cod_confirmation as
 *  "not yet eligible"; on expiry the default/hold outcome applies). That
 *  eligibility check lives in order-derivation/auto-ship — noted for the
 *  parent; nothing here double-books.
 *
 *  INV-21: messaging is fire-and-observe; state transitions here are
 *  database writes, never dependent on message delivery.
 */

const CONFIRM_THROTTLE = { attempts: 10, windowSeconds: 600 };

export interface CodConfirmPage {
  orderRef: string | null;
  amount: string | null;
  expiresAt: string;
}

@Injectable()
export class CodConfirmationService {
  private readonly logger = new Logger(CodConfirmationService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly settings: NotificationSettingsService,
    private readonly buyer: BuyerNotificationService,
    private readonly audit: AuditService,
    @Inject(COD_CONFIRMATION_BOOKER)
    private readonly booker: CodConfirmationBooker,
  ) {}

  private salt(): string {
    return this.config.get<string>('crypto.piiHashSalt') ?? '';
  }

  private appUrl(): string {
    return (
      this.config.get<string>('shopify.appUrl') ?? 'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  /**
   * ADD-28 entry point — call when a new order resolves to COD. Returns the
   * confirmation id, or null when the order is not COD / already has one.
   */
  async start(shopId: string, orderId: string): Promise<string | null> {
    const order = await this.pool.query<{ payment_mode: string }>(
      `SELECT payment_mode FROM "order" WHERE shop_id = $1 AND order_id = $2`,
      [shopId, orderId],
    );
    if (order.rows[0]?.payment_mode !== 'COD') return null;

    const token = randomToken(32);
    const inserted = await this.pool.query<{ confirmation_id: string }>(
      `INSERT INTO cod_confirmation (shop_id, order_id, token_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (shop_id, order_id) DO NOTHING
       RETURNING confirmation_id`,
      [shopId, orderId, tokenHash(token)],
    );
    const row = inserted.rows[0];
    if (!row) return null; // confirmation already exists for this order

    // Fire-and-observe (INV-21): the confirmation exists regardless of
    // whether the buyer message could be sent.
    await this.buyer.sendCodConfirmationRequest(
      shopId,
      orderId,
      `${this.appUrl()}/cod/confirm/${token}`,
    );

    await this.audit.record({
      shopId,
      actorKind: 'SYSTEM',
      action: 'cod.confirmation_started',
      objectType: 'cod_confirmation',
      objectId: row.confirmation_id,
      after: { orderId },
    });
    return row.confirmation_id;
  }

  /** Public page data for the confirm link; null for any invalid case. */
  async getConfirmPage(token: string): Promise<CodConfirmPage | null> {
    const result = await this.pool.query<{
      state: string;
      created_at: string;
      shop_id: string;
      shopify_order_number: string | null;
      cod_outstanding: string | null;
    }>(
      `SELECT c.state, c.created_at, c.shop_id,
              o.shopify_order_number, o.cod_outstanding
         FROM cod_confirmation c
         JOIN "order" o ON o.order_id = c.order_id AND o.shop_id = c.shop_id
        WHERE c.token_hash = $1`,
      [tokenHash(token)],
    );
    const row = result.rows[0];
    if (!row || row.state !== 'PENDING') return null;
    const windowMinutes = await this.settings.codConfirmationWindowMinutes(
      row.shop_id,
    );
    const expiresAt = new Date(
      new Date(row.created_at).getTime() + windowMinutes * 60_000,
    );
    return {
      orderRef: row.shopify_order_number,
      amount: row.cod_outstanding,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** The buyer confirmed — PENDING → CONFIRMED (single-purpose token). */
  async confirm(
    token: string,
    ip: string,
  ): Promise<{ ok: boolean; throttled?: boolean }> {
    const ipHash = saltedPiiHash(this.salt(), ip || 'unknown');
    const key = `cod:confirm:thr:${ipHash}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, CONFIRM_THROTTLE.windowSeconds);
    if (count > CONFIRM_THROTTLE.attempts) return { ok: false, throttled: true };

    const result = await this.pool.query<{
      confirmation_id: string;
      shop_id: string;
      order_id: string;
    }>(
      `UPDATE cod_confirmation
          SET state = 'CONFIRMED', responded_at = now()
        WHERE token_hash = $1 AND state = 'PENDING'
        RETURNING confirmation_id, shop_id, order_id`,
      [tokenHash(token)],
    );
    const row = result.rows[0];
    if (!row) return { ok: false };

    await this.audit.record({
      shopId: row.shop_id,
      actorKind: 'SYSTEM',
      action: 'cod.confirmed',
      objectType: 'cod_confirmation',
      objectId: row.confirmation_id,
      after: { orderId: row.order_id },
      ipHash,
    });
    return { ok: true };
  }

  /**
   * The ADD-28 sweep — plain injectable (the BullMQ worker is a thin shell).
   * Resolves every PENDING confirmation whose per-shop window has lapsed.
   */
  async sweepExpired(now: Date = new Date()): Promise<number> {
    const pending = await this.pool.query<{
      confirmation_id: string;
      shop_id: string;
      order_id: string;
      created_at: string;
    }>(
      `SELECT confirmation_id, shop_id, order_id, created_at
         FROM cod_confirmation WHERE state = 'PENDING'`,
    );
    let resolved = 0;
    for (const row of pending.rows) {
      try {
        const windowMinutes = await this.settings.codConfirmationWindowMinutes(
          row.shop_id,
        );
        const expiresAt =
          new Date(row.created_at).getTime() + windowMinutes * 60_000;
        if (now.getTime() < expiresAt) continue;

        const policy = await this.settings.codConfirmationExpiryPolicy(
          row.shop_id,
        );
        if (policy === 'BOOK_ANYWAY') {
          // Default: proceed to booking via the parent-bound seam.
          await this.booker.bookAnyway(row.shop_id, row.order_id);
          await this.settle(row.confirmation_id, 'EXPIRED_BOOKED');
        } else {
          // HOLD: the order's unbooked shipments wait for a human, with the
          // §3.30 reason making the cause visible (§9.10 manual-assignment card).
          await this.pool.query(
            `UPDATE shipment
                SET booking_state = 'NEEDS_MANUAL_ASSIGNMENT',
                    manual_assignment_reason = 'COD_UNCONFIRMED'
              WHERE shop_id = $1 AND order_id = $2 AND booking_state = 'DRAFT'`,
            [row.shop_id, row.order_id],
          );
          await this.settle(row.confirmation_id, 'EXPIRED_HELD');
        }
        await this.audit.record({
          shopId: row.shop_id,
          actorKind: 'SYSTEM',
          action:
            policy === 'BOOK_ANYWAY' ? 'cod.expired_booked' : 'cod.expired_held',
          objectType: 'cod_confirmation',
          objectId: row.confirmation_id,
          after: { orderId: row.order_id, policy },
        });
        resolved += 1;
      } catch (err) {
        // INV-21: one shop's sweep failure must not stall the others.
        this.logger.error(
          `cod sweep failed for a confirmation: ${err instanceof Error ? err.name : 'Error'}`,
        );
      }
    }
    return resolved;
  }

  private async settle(
    confirmationId: string,
    state: 'EXPIRED_BOOKED' | 'EXPIRED_HELD',
  ): Promise<void> {
    await this.pool.query(
      `UPDATE cod_confirmation SET state = $2, responded_at = now()
        WHERE confirmation_id = $1 AND state = 'PENDING'`,
      [confirmationId, state],
    );
  }
}
