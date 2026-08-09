import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import type { payment_mode } from '../courier-framework/adapter.enum-types';
import { evaluate, type EvaluationResult } from './evaluate';
import { RuleEvaluationService } from './rule-evaluation.service';

/**
 * §9.4.6 simulator + ADD-17 test-fire. Both run the SAME pure evaluate core
 * as production routing; neither persists anything — no trace row, no
 * shipment write, no booking (ADD-17: read-only, books nothing).
 */

export interface SimulateInput {
  destinationPincode: string;
  deadWeightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  paymentMode: payment_mode;
  collectible: string;
  orderAmount: string | null;
  codAmount: string | null;
  skus: string[];
  tags: string[];
  checkoutShippingTitle: string | null;
  checkoutShippingAmount: string | null;
  itemCount: number | null;
  riskFlag: string | null;
}

export interface TestFireRow {
  orderId: string;
  shipmentId: string;
  /** The rule that would match NOW (null = no rule → S-22 path). */
  wouldMatchRuleId: string | null;
  wouldMatchRuleName: string | null;
  /** The Service the evaluation would select now (null = manual). */
  selectedServiceId: string | null;
  outcome: EvaluationResult['outcome'];
  /** The Service actually used on the Shipment (null when never routed). */
  actualServiceId: string | null;
  changed: boolean;
}

@Injectable()
export class RuleSimulatorService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly evaluation: RuleEvaluationService,
  ) {}

  /** §9.4.6: sample order in → the full trace, NOTHING persisted. */
  async simulate(shopId: string, sample: SimulateInput): Promise<EvaluationResult> {
    const input = await this.evaluation.loadForSample(shopId, sample, new Date());
    return evaluate(input);
  }

  /**
   * ADD-17: the last N real Orders (default 100, test shipments excluded,
   * INV-19). Per order: which rule would match now + which Service it would
   * select, versus the Service actually used. Read-only — no trace rows, no
   * shipment writes, no booking.
   */
  async testFire(shopId: string, count = 100): Promise<TestFireRow[]> {
    const { rows: shipments } = await this.pool.query<{
      shipment_id: string;
      order_id: string;
      service_id: string | null;
    }>(
      `SELECT shipment_id, order_id, service_id
         FROM shipment
        WHERE shop_id = $1 AND is_test = false
        ORDER BY created_at DESC
        LIMIT $2`,
      [shopId, count],
    );

    const out: TestFireRow[] = [];
    for (const s of shipments) {
      const loaded = await this.evaluation.loadForShipment(
        this.pool,
        shopId,
        s.shipment_id,
        new Date(),
      );
      if (!loaded) continue;
      const result = evaluate(loaded.input);
      const selected =
        result.outcome.kind === 'SELECTED' ? result.outcome.serviceId : null;
      const matchedTrace = result.ruleTraces.find((t) => t.status === 'MATCHED') ?? null;
      out.push({
        orderId: s.order_id,
        shipmentId: s.shipment_id,
        wouldMatchRuleId: result.matchedRuleId,
        wouldMatchRuleName: matchedTrace?.name ?? null,
        selectedServiceId: selected,
        outcome: result.outcome,
        actualServiceId: s.service_id,
        changed: selected !== s.service_id,
      });
    }
    return out;
  }
}
