import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { RuleRoutingService } from '../rules/rule-routing.service';

/**
 * §9.5.3 route seam. Auto-ship needs "a matching rule with a serviceable
 * candidate" before it books; the §9.4.4 rules engine answers that (its
 * evaluation falls back to the S-22 default chain itself, RW-22).
 * queueBooking re-evaluates idempotently at booking time, so a stale answer
 * here can never book the wrong Service. Callers must not grow their own
 * routing logic.
 */
@Injectable()
export class RouteResolver {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly rules: RuleRoutingService,
  ) {}

  /**
   * The Service auto-ship would book at, or null when no route resolves
   * (the order stays in the normal queue with NO_ROUTE visible).
   */
  async resolveServiceId(
    shopId: string,
    shipment: { serviceId: string | null; shipmentId?: string },
  ): Promise<string | null> {
    if (shipment.serviceId) return shipment.serviceId;
    // §9.4: rules evaluate first; the outcome carries the selected Service
    // or a manual-assignment reason (no route).
    if (shipment.shipmentId) {
      const routing = await this.rules.evaluateForShipment(shopId, shipment.shipmentId);
      if (routing.evaluated && routing.result.outcome.kind === 'SELECTED') {
        return routing.result.outcome.serviceId;
      }
      return null;
    }
    // S-22 (§7.3) fallback when no shipment id is supplied.
    const { rows: settings } = await this.pool.query<{ default_chain: string[] | null }>(
      `SELECT default_chain FROM order_sync_settings WHERE shop_id = $1`,
      [shopId],
    );
    const chain = settings[0]?.default_chain ?? null;
    if (!chain || chain.length === 0) return null;
    const { rows } = await this.pool.query<{
      merchant_service_id: string;
      service_id: string;
    }>(
      `SELECT ms.merchant_service_id, ms.service_id
         FROM merchant_service ms
         JOIN service s ON s.service_id = ms.service_id
         JOIN courier_account ca ON ca.courier_account_id = ms.courier_account_id
        WHERE ms.shop_id = $1 AND ms.merchant_service_id = ANY($2::uuid[])
          AND ms.enabled AND s.is_active AND ca.disabled_at IS NULL`,
      [shopId, chain],
    );
    const byId = new Map(rows.map((r) => [r.merchant_service_id, r.service_id]));
    for (const id of chain) {
      const serviceId = byId.get(id);
      if (serviceId) return serviceId;
    }
    return null;
  }
}
