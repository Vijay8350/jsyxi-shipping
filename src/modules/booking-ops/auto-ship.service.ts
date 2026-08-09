import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import { AuditService } from '../../audit/audit.service';
import { BookingService } from '../booking/booking.service';
import { RouteResolver } from './route-resolver';
import {
  AUTO_SHIP_SWEEP_INTERVAL_MS,
  AutoShipOrderOutcome,
  AutoShipSweepSummary,
} from './booking-ops.types';

/**
 * §9.5.3 auto-ship (A3-03, S-10…S-13). Runs ONLY on the scheduled sweep —
 * the BullMQ repeatable job registered by AutoShipScheduler — never on the
 * order webhook. Per shop with S-10 enabled, the sweep books eligible orders
 * through the single booking path (queueBooking), which re-evaluates every
 * INV-7 hard-block and uses the F-20 resolved profile without prompting
 * (§9.5.1's ship modal is not involved — no prompt exists on this path).
 *
 * Eligibility (each rule produces a visible skip reason — ineligible orders
 * stay in the normal queue, never retried silently, §9.5.3/INV-20):
 *
 *  - ORDER_STATE = READY (machine A: every INV-7 condition met);
 *  - paid (PREPAID) or confirmed COD — UNRESOLVED is skipped;
 *  - no Shopify risk flag (§8.1);
 *  - not on hold / partially cancelled — machine A has no ON_HOLD state at
 *    v1: CANCELLED_IN_SHOPIFY is terminal and excluded by the READY guard,
 *    and a rule-hold surfaces as NEEDS_MANUAL_ASSIGNMENT/HELD_BY_RULE
 *    (ADD-14), which is not DRAFT and so never a sweep candidate;
 *  - a matching route via the RouteResolver seam (S-22 default chain today;
 *    the §9.4 rules engine slots in there);
 *  - no manual booking in progress (no sibling QUEUED/SUBMITTED/
 *    OUTCOME_UNKNOWN);
 *  - older than the S-11 hold window (created_at_shopify + hold ≤ now);
 *  - within the S-12 daily cutoff, evaluated in shop-local time (§5.2);
 *  - never while the account is RESTRICTED (§3.11) and never a rebook of a
 *    shipment with an active AWB.
 *
 * Up to the S-13 per-sweep cap (500) is booked; above-cap waits for the next
 * sweep (reported as SWEEP_CAP_REACHED). The per-shop summary is stored in
 * Redis (24h) and returned; one audit row per sweep (§12, sparingly).
 */

/** §3.11: auto-ship never runs in these account states. */
const BLOCKED_ACCOUNT_STATES = new Set(['RESTRICTED', 'READ_ONLY', 'UNINSTALLED']);

interface ShopSweepRow {
  shop_id: string;
}

interface SweepSettingsRow {
  auto_ship_hold_minutes: number;
  auto_ship_cutoff_time: string | null; // 'HH:MM[:SS]'
  auto_ship_sweep_cap: number;
  account_state: string;
  timezone: string;
}

interface CandidateRow {
  order_id: string;
  shipment_id: string;
  service_id: string | null;
  created_at_shopify: string | null;
  payment_mode: string;
  risk_flag: string | null;
  awb_normalized: string | null;
}

/** Shop-local 'HH:MM' (§5.2: scheduled work runs in shop-local time). */
export function shopLocalHHMM(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}

@Injectable()
export class AutoShipService {
  private readonly logger = new Logger(AutoShipService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly audit: AuditService,
    private readonly booking: BookingService,
    private readonly routeResolver: RouteResolver,
  ) {}

  /** The sweep entry point — invoked ONLY by the repeatable BullMQ job. */
  async runSweep(now: Date = new Date()): Promise<AutoShipSweepSummary[]> {
    const { rows: shops } = await this.pool.query<ShopSweepRow>(
      `SELECT s.shop_id
         FROM shop s
         JOIN order_sync_settings os ON os.shop_id = s.shop_id
        WHERE os.auto_ship_enabled
          AND s.uninstalled_at IS NULL
          AND s.account_state NOT IN ('RESTRICTED', 'READ_ONLY', 'UNINSTALLED')`,
    );
    const summaries: AutoShipSweepSummary[] = [];
    for (const shop of shops) {
      // Overlap guard: a slow sweep never runs twice for the same shop.
      const lockKey = `booking-ops:auto-ship:lock:${shop.shop_id}`;
      const acquired = await this.redis.set(
        lockKey,
        String(now.getTime()),
        'PX',
        AUTO_SHIP_SWEEP_INTERVAL_MS,
        'NX',
      );
      if (!acquired) continue;
      try {
        summaries.push(await this.runShopSweep(shop.shop_id, now));
      } catch (err) {
        // §5.7 control 4: IDs and error class only.
        this.logger.warn(`auto-ship sweep failed for shop ${shop.shop_id}: ${(err as Error).name}`);
      }
    }
    return summaries;
  }

  /** One shop's sweep. Returns the summary — also persisted to Redis. */
  async runShopSweep(shopId: string, now: Date = new Date()): Promise<AutoShipSweepSummary> {
    const outcomes: AutoShipOrderOutcome[] = [];
    const summary = (): AutoShipSweepSummary => ({
      shopId,
      sweptAt: now.toISOString(),
      booked: outcomes.filter((o) => o.booked).length,
      skipped: outcomes.filter((o) => !o.booked).length,
      outcomes,
    });

    const { rows: settingsRows } = await this.pool.query<SweepSettingsRow>(
      `SELECT os.auto_ship_hold_minutes, os.auto_ship_cutoff_time::text AS auto_ship_cutoff_time,
              os.auto_ship_sweep_cap, s.account_state,
              COALESCE(ss.timezone, s.iana_timezone) AS timezone
         FROM shop s
         JOIN order_sync_settings os ON os.shop_id = s.shop_id
         LEFT JOIN store_settings ss ON ss.shop_id = s.shop_id
        WHERE s.shop_id = $1`,
      [shopId],
    );
    const settings = settingsRows[0];
    if (!settings || BLOCKED_ACCOUNT_STATES.has(settings.account_state)) {
      // §9.5.3: never while RESTRICTED (§3.11).
      const s = summary();
      await this.persistSummary(shopId, s);
      return s;
    }

    const candidates = await this.loadCandidates(shopId);

    // S-12 (shop-local, §5.2): after the daily cutoff nothing auto-books —
    // every candidate waits, with the reason visible.
    const afterCutoff =
      settings.auto_ship_cutoff_time !== null &&
      shopLocalHHMM(now, settings.timezone) > settings.auto_ship_cutoff_time.slice(0, 5);

    let bookedCount = 0;
    for (const candidate of candidates) {
      const base = { orderId: candidate.order_id, shipmentId: candidate.shipment_id };
      if (afterCutoff) {
        outcomes.push({ ...base, booked: false, reason: 'AFTER_CUTOFF' });
        continue;
      }
      if (candidate.awb_normalized) {
        // §9.5.3: never rebook an active AWB (defensive — the query excludes).
        outcomes.push({ ...base, booked: false, reason: 'ACTIVE_AWB' });
        continue;
      }
      if (candidate.payment_mode !== 'PREPAID' && candidate.payment_mode !== 'COD') {
        outcomes.push({ ...base, booked: false, reason: 'PAYMENT_MODE_UNRESOLVED' });
        continue;
      }
      if (candidate.risk_flag) {
        outcomes.push({ ...base, booked: false, reason: 'SHOPIFY_RISK_FLAG' });
        continue;
      }
      // S-11 (A3-03): the order must be older than the hold window.
      const createdAt = candidate.created_at_shopify ? Date.parse(candidate.created_at_shopify) : null;
      if (createdAt === null || createdAt + settings.auto_ship_hold_minutes * 60_000 > now.getTime()) {
        outcomes.push({ ...base, booked: false, reason: 'WITHIN_HOLD_WINDOW' });
        continue;
      }
      // The route seam: §9.4 rules (S-22 default chain is their fallback).
      const serviceId = await this.routeResolver.resolveServiceId(shopId, {
        serviceId: candidate.service_id,
        shipmentId: candidate.shipment_id,
      });
      if (!serviceId) {
        outcomes.push({ ...base, booked: false, reason: 'NO_ROUTE' });
        continue;
      }
      // S-13 (A3-03): above the per-sweep cap waits for the next sweep.
      if (bookedCount >= settings.auto_ship_sweep_cap) {
        outcomes.push({ ...base, booked: false, reason: 'SWEEP_CAP_REACHED' });
        continue;
      }
      const result = await this.booking.queueBooking({
        shopId,
        shipmentId: candidate.shipment_id,
        actorId: null, // §9.5.3: the auto-ship system actor
      });
      if (result.queued) {
        bookedCount += 1;
        outcomes.push({ ...base, booked: true, bookingIntentId: result.bookingIntentId });
      } else {
        // The exact structured reason stays visible (INV-20) — e.g.
        // NO_BOOKABLE_SERVICE with its §3.30 manualAssignmentReason.
        outcomes.push({
          ...base,
          booked: false,
          reason: 'BOOKING_BLOCKED',
          detail: result.manualAssignmentReason
            ? `${result.code}:${result.manualAssignmentReason}`
            : result.code,
        });
      }
    }

    const s = summary();
    await this.persistSummary(shopId, s);
    // §12, sparingly: one audit row per sweep with counts — never per-order
    // PII, and nothing here gates the business action (INV-21).
    await this.audit.record({
      shopId,
      actorKind: 'SYSTEM',
      action: 'auto_ship.sweep_completed',
      objectType: 'shop',
      objectId: shopId,
      after: { booked: s.booked, skipped: s.skipped },
    });
    return s;
  }

  /**
   * Sweep candidates: READY orders (machine A ⇒ every INV-7 condition met)
   * with a DRAFT shipment, no active AWB, and no manual booking in progress.
   * The single-order rules (payment, risk, hold window) are evaluated in JS
   * so each produces its own visible skip reason.
   */
  private async loadCandidates(shopId: string): Promise<CandidateRow[]> {
    const { rows } = await this.pool.query<CandidateRow>(
      `SELECT o.order_id, sh.shipment_id, sh.service_id,
              o.created_at_shopify, o.payment_mode, o.risk_flag, sh.awb_normalized
         FROM "order" o
         JOIN shipment sh ON sh.shop_id = o.shop_id AND sh.order_id = o.order_id
        WHERE o.shop_id = $1
          AND o.order_state = 'READY'
          AND sh.booking_state = 'DRAFT'
          AND sh.awb_normalized IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM shipment s2
             WHERE s2.shop_id = o.shop_id AND s2.order_id = o.order_id
               AND s2.booking_state IN ('QUEUED', 'SUBMITTED', 'OUTCOME_UNKNOWN'))
          -- ADD-28: an unanswered COD confirmation holds the order out of
          -- auto-ship until the window resolves (respects S-11, not fights it).
          AND NOT EXISTS (
            SELECT 1 FROM cod_confirmation cc
             WHERE cc.shop_id = o.shop_id AND cc.order_id = o.order_id
               AND cc.state = 'PENDING')
        ORDER BY o.created_at_shopify NULLS LAST, o.order_id`,
      [shopId],
    );
    return rows;
  }

  /** The last sweep summary per shop — the "reason visible" surface. */
  private async persistSummary(shopId: string, summary: AutoShipSweepSummary): Promise<void> {
    await this.redis.set(
      `booking-ops:auto-ship:last:${shopId}`,
      JSON.stringify(summary),
      'EX',
      24 * 3600,
    );
  }

  async lastSummary(shopId: string): Promise<AutoShipSweepSummary | null> {
    const raw = await this.redis.get(`booking-ops:auto-ship:last:${shopId}`);
    return raw ? (JSON.parse(raw) as AutoShipSweepSummary) : null;
  }
}
