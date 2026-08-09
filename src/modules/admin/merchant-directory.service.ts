import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';

/**
 * §9.13 merchant list + detail and the ADD-31 health board.
 *
 * Platform-wide BY DESIGN (§10.3 admin surface) — but every row still carries
 * its shop_id so downstream consumers can scope per-Shop (INV-1 honoured at
 * the row level). Read-only and no PII: the shop row exposes identity
 * (domain, account state) and configuration facts only — never the encrypted
 * Shopify token, never member emails, never buyer data.
 *
 * ADD-31: the health column and detail panel READ the stored
 * setup_health_item rows (ADD-29) computed by the setup-health sibling
 * module — this service never computes health itself. "Most broken" sorts by
 * the count of non-OK items.
 */

export type MerchantSort = 'most_broken' | 'domain';

export interface MerchantListOptions {
  sort?: MerchantSort;
  limit?: number;
  offset?: number;
}

@Injectable()
export class MerchantDirectoryService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * §9.13 merchant list: plan, AWB usage this cycle (awb_entitlement_ledger
   * DEBITs in the current subscription cycle), courier count + health, account
   * state, and the ADD-31 broken-item count. Sortable by 'most broken'.
   */
  async listMerchants(options: MerchantListOptions = {}): Promise<unknown[]> {
    const sort: MerchantSort = options.sort ?? 'domain';
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    // ADD-31: 'most broken' = count of setup_health_item rows not OK, DESC.
    const orderBy =
      sort === 'most_broken'
        ? 'broken_health_count DESC, s.myshopify_domain ASC'
        : 's.myshopify_domain ASC';
    const { rows } = await this.pool.query(
      `SELECT s.shop_id, s.myshopify_domain, s.account_state, s.installed_at,
              p.code AS plan_code, p.name AS plan_name,
              sub.state AS subscription_state,
              sub.cycle_start_at, sub.cycle_end_at,
              COALESCE(usage.awb_used, 0)::int AS awb_used_this_cycle,
              COALESCE(couriers.courier_count, 0)::int AS courier_count,
              COALESCE(couriers.unhealthy_count, 0)::int AS unhealthy_courier_count,
              COALESCE(health.broken_health_count, 0)::int AS broken_health_count
         FROM shop s
         LEFT JOIN LATERAL (
           SELECT sub.plan_id, sub.state, sub.cycle_start_at, sub.cycle_end_at
             FROM subscription sub
            WHERE sub.shop_id = s.shop_id
            ORDER BY sub.created_at DESC
            LIMIT 1
         ) sub ON true
         LEFT JOIN plan p ON p.plan_id = sub.plan_id
         LEFT JOIN LATERAL (
           SELECT count(*) AS awb_used
             FROM awb_entitlement_ledger l
            WHERE l.shop_id = s.shop_id
              AND l.direction = 'DEBIT'
              AND sub.cycle_start_at IS NOT NULL
              AND l.cycle_start_at = sub.cycle_start_at
         ) usage ON true
         LEFT JOIN LATERAL (
           SELECT count(*) AS courier_count,
                  count(*) FILTER (WHERE ca.health_state <> 'HEALTHY') AS unhealthy_count
             FROM courier_account ca
            WHERE ca.shop_id = s.shop_id AND ca.disabled_at IS NULL
         ) couriers ON true
         LEFT JOIN LATERAL (
           SELECT count(*) AS broken_health_count
             FROM setup_health_item h
            WHERE h.shop_id = s.shop_id AND h.state <> 'OK'
         ) health ON true
        WHERE s.uninstalled_at IS NULL
        ORDER BY ${orderBy}
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows;
  }

  /**
   * §9.13 merchant detail + the ADD-31 detail panel: full setup_health_item
   * rows, courier accounts with health (never credential columns), plan and
   * AWB usage this cycle.
   */
  async merchantDetail(shopId: string): Promise<unknown> {
    const shop = await this.pool.query(
      `SELECT s.shop_id, s.myshopify_domain, s.shop_currency, s.iana_timezone,
              s.account_state, s.installed_at
         FROM shop s
        WHERE s.shop_id = $1`,
      [shopId],
    );
    if (shop.rows.length === 0) throw new NotFoundException('shop not found');

    const [subscription, usage, couriers, health] = await Promise.all([
      this.pool.query(
        `SELECT sub.subscription_id, sub.state, sub.cycle_start_at, sub.cycle_end_at,
                p.code AS plan_code, p.name AS plan_name, p.awb_allowance_per_cycle
           FROM subscription sub
           JOIN plan p ON p.plan_id = sub.plan_id
          WHERE sub.shop_id = $1
          ORDER BY sub.created_at DESC
          LIMIT 1`,
        [shopId],
      ),
      this.pool.query(
        `SELECT count(*)::int AS awb_used
           FROM awb_entitlement_ledger l
          WHERE l.shop_id = $1
            AND l.direction = 'DEBIT'
            AND l.cycle_start_at = (
                  SELECT sub.cycle_start_at FROM subscription sub
                   WHERE sub.shop_id = $1
                   ORDER BY sub.created_at DESC LIMIT 1
                )`,
        [shopId],
      ),
      // Courier identity + health only — credentials are never selected (INV-18).
      this.pool.query(
        `SELECT ca.courier_account_id, c.code AS courier_code, c.name AS courier_name,
                ca.mode, ca.health_state, ca.last_event_received_at, ca.disabled_at
           FROM courier_account ca
           JOIN courier c ON c.courier_id = ca.courier_id
          WHERE ca.shop_id = $1
          ORDER BY c.code`,
        [shopId],
      ),
      // ADD-31 detail panel: the stored ADD-29 rows, worst first.
      this.pool.query(
        `SELECT item_key, state, detail, first_detected_at, updated_at
           FROM setup_health_item
          WHERE shop_id = $1
          ORDER BY (state = 'OK') ASC, item_key ASC`,
        [shopId],
      ),
    ]);

    return {
      ...shop.rows[0],
      subscription: subscription.rows[0] ?? null,
      awb_used_this_cycle: usage.rows[0]?.awb_used ?? 0,
      courier_accounts: couriers.rows,
      setup_health_items: health.rows,
    };
  }
}
