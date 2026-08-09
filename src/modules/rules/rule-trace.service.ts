import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import type { RuleEvaluationTraceRow } from './rules.types';

/**
 * §9.4.5 trace reads. The trace behind a Shipment's routing decision —
 * shown on the shipment and in the simulator (RW-18).
 */
@Injectable()
export class RuleTraceService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Every trace for the Shipment, newest first (re-evaluation while
   *  DRAFT / NEEDS_MANUAL_ASSIGNMENT appends a new row each time). */
  async forShipment(shopId: string, shipmentId: string): Promise<RuleEvaluationTraceRow[]> {
    // Verify the Shipment belongs to this Shop first (INV-1) so a foreign
    // id is indistinguishable from an untraced one.
    const { rows: shipment } = await this.pool.query<{ shipment_id: string }>(
      `SELECT shipment_id FROM shipment WHERE shop_id = $1 AND shipment_id = $2`,
      [shopId, shipmentId],
    );
    if (!shipment[0]) throw new NotFoundException('shipment not found');
    const { rows } = await this.pool.query<RuleEvaluationTraceRow>(
      `SELECT trace_id, shop_id, shipment_id, rule_id, rule_version,
              condition_results, candidate_results, selected_service_id,
              fallback_chain, evaluated_at
         FROM rule_evaluation_trace
        WHERE shop_id = $1 AND shipment_id = $2
        ORDER BY evaluated_at DESC`,
      [shopId, shipmentId],
    );
    return rows;
  }
}
