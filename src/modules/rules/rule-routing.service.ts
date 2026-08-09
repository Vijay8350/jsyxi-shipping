import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { RuleEvaluationService } from './rule-evaluation.service';
import type { EvaluationResult } from './evaluate';

/**
 * §9.4.4 production routing path. The booking flow calls
 * evaluateForShipment BEFORE its stored-selection → S-22 fallback
 * (booking.service.ts resolveSelection reads shipment.service_id, which is
 * exactly what a SELECTED outcome writes here — so the booking module needs
 * no change to honour a rule's pick).
 *
 * One transaction: lock the Shipment (INV-22), evaluate on its working
 * values (INV-8 — the same values that freeze into the snapshot at
 * DRAFT → QUEUED), persist the §9.4.5 rule_evaluation_trace, then write the
 * outcome:
 *  - SELECTED → shipment.service_id + a `routing` block merged into the
 *    working values (additive — the shape is extend-never-restructure);
 *    a Shipment held in NEEDS_MANUAL_ASSIGNMENT returns to DRAFT (§3.2
 *    reverse row: the cause is fixed).
 *  - MANUAL → booking_state NEEDS_MANUAL_ASSIGNMENT with the §3.30 reason;
 *    per-Service failure detail lives in the trace's candidate_results
 *    (RV-03).
 *
 * Re-evaluation is idempotent while DRAFT / NEEDS_MANUAL_ASSIGNMENT: it
 * writes a new trace row and overwrites the same outcome fields. From
 * QUEUED onward evaluation is refused (working values are immutable, §10.4).
 */

export type RoutingResult =
  | { evaluated: true; traceId: string; result: EvaluationResult }
  | { evaluated: false; code: 'SHIPMENT_NOT_FOUND' | 'INVALID_STATE'; currentState?: string };

@Injectable()
export class RuleRoutingService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly evaluation: RuleEvaluationService,
    private readonly audit: AuditService,
  ) {}

  async evaluateForShipment(
    shopId: string,
    shipmentId: string,
    opts: { actorId?: string | null } = {},
  ): Promise<RoutingResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const loaded = await this.evaluation.loadForShipment(client, shopId, shipmentId, new Date(), true);
      if (!loaded) {
        await client.query('ROLLBACK');
        return { evaluated: false, code: 'SHIPMENT_NOT_FOUND' };
      }
      const { shipment } = loaded;
      // §10.4: working values are mutable only while DRAFT /
      // NEEDS_MANUAL_ASSIGNMENT; re-evaluation is idempotent in both.
      if (!['DRAFT', 'NEEDS_MANUAL_ASSIGNMENT'].includes(shipment.booking_state)) {
        await client.query('ROLLBACK');
        return {
          evaluated: false,
          code: 'INVALID_STATE',
          currentState: shipment.booking_state,
        };
      }

      const result = await this.evaluation.evaluateLoaded(loaded.input);

      // §9.4.5: every evaluation persists its trace (A1-03, RV-03).
      const { rows: traceRows } = await client.query<{ trace_id: string }>(
        `INSERT INTO rule_evaluation_trace
           (shop_id, shipment_id, rule_id, rule_version, condition_results,
            candidate_results, selected_service_id, fallback_chain)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING trace_id`,
        [
          shopId,
          shipmentId,
          result.matchedRuleId,
          result.matchedRuleVersion,
          JSON.stringify(result.ruleTraces),
          JSON.stringify(result.candidateResults),
          result.selectedServiceId,
          result.fallbackChain ? JSON.stringify(result.fallbackChain) : null,
        ],
      );
      const traceId = traceRows[0].trace_id;

      if (result.outcome.kind === 'SELECTED') {
        const routingBlock = {
          routing: {
            ruleId: result.matchedRuleId,
            ruleVersion: result.matchedRuleVersion,
            serviceId: result.outcome.serviceId,
            traceId,
            fallbackChain: result.fallbackChain?.kind ?? null,
            evaluatedAt: loaded.input.now.toISOString(),
          },
        };
        const { rowCount } = await client.query(
          `UPDATE shipment
              SET service_id = $3,
                  booking_state = 'DRAFT',
                  manual_assignment_reason = NULL,
                  working_values = COALESCE(working_values, '{}'::jsonb) || $4::jsonb,
                  version = version + 1
            WHERE shop_id = $1 AND shipment_id = $2 AND version = $5`,
          [
            shopId,
            shipmentId,
            result.outcome.serviceId,
            JSON.stringify(routingBlock),
            shipment.version,
          ],
        );
        if (rowCount !== 1) {
          throw new Error(`routing outcome write affected ${rowCount} rows (INV-22)`);
        }
      } else {
        // §3.2: NEEDS_MANUAL_ASSIGNMENT with the §3.30 reason; the
        // per-Service failure detail is in the trace (RV-03).
        const { rowCount } = await client.query(
          `UPDATE shipment
              SET booking_state = 'NEEDS_MANUAL_ASSIGNMENT',
                  manual_assignment_reason = $3,
                  version = version + 1
            WHERE shop_id = $1 AND shipment_id = $2 AND version = $4`,
          [shopId, shipmentId, result.outcome.reason, shipment.version],
        );
        if (rowCount !== 1) {
          throw new Error(`routing outcome write affected ${rowCount} rows (INV-22)`);
        }
      }

      await client.query('COMMIT');

      // §12: IDs and states only — no PII (§5.7 control 4).
      await this.audit.record({
        shopId,
        actorKind: opts.actorId ? 'MEMBER' : 'SYSTEM',
        actorId: opts.actorId ?? null,
        action: 'rule.evaluated',
        objectType: 'shipment',
        objectId: shipmentId,
        after: {
          traceId,
          matchedRuleId: result.matchedRuleId,
          matchedRuleVersion: result.matchedRuleVersion,
          selectedServiceId: result.selectedServiceId,
          outcome: result.outcome.kind === 'SELECTED' ? 'SELECTED' : result.outcome.reason,
        },
      });

      return { evaluated: true, traceId, result };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
