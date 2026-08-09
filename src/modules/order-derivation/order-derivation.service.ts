import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import {
  OrderUpsertResult,
  UNBOOKED_ORDER_STATES,
} from '../order-sync/order-upsert.service';
import { WorkingRecipient } from '../order-sync/working-values.types';
import { deriveDeadWeight, DeadWeightResult } from './weight';
import {
  PackageProfileInput,
  selectPackageProfile,
  PackageSelectionResult,
} from './package-selection';
import { deriveCodOutstanding, derivePaymentMode, PaymentMode } from './payment';
import { deriveCodAssignmentState, CodAssignmentState } from './order-status';
import { evaluateEligibility, EligibilityResult } from './eligibility';
import { ShipmentWorkingValuesWeek4 } from './working-values-week4.types';

/**
 * §9.2.2 derivation + §9.2.1/§9.2.4 INV-7 eligibility — the persistence half.
 * All derivations are pure functions (weight.ts, package-selection.ts,
 * payment.ts, order-status.ts, eligibility.ts); this service loads the rows,
 * runs them, and writes the results in one transaction:
 *
 *  - "order": payment_mode (§3.5), cod_outstanding (F-15, §4.6),
 *    cod_assignment_state (§3.24) and order_state IMPORTED → INCOMPLETE ↔
 *    READY (§3.1) — guarded to the unbooked states so a booked or terminal
 *    order is never regressed (INV-17, §9.2.5).
 *  - each DRAFT / NEEDS_MANUAL_ASSIGNMENT shipment's working_values:
 *    additively (§2.9 contract) the payment, weight (F-24), packageProfile
 *    (F-20) and validation (INV-7 failures, §9.2.4) blocks.
 *
 * Gateway names (the S-14 input) are read from the DRAFT shipments' working
 * values, where the week-3 ingest stored them; the order row itself does not
 * carry them (shared-change note in the week-4 handoff).
 */

/** S-14 seed from migration 0004, used when the settings row is absent
 *  (pre-onboarding ingest): the same common Indian COD gateway names. */
const COD_GATEWAY_MAP_SEED = [
  'Cash on Delivery (COD)',
  'Cash on Delivery',
  'COD',
  'cod',
  'cash_on_delivery',
];

/** S-7 default (§7.1) when the store_settings row is absent. */
const DEFAULT_PARCEL_WEIGHT_KG = '0.500';

export interface OrderDerivationOutcome {
  orderId: string;
  /** False when the order is booked/terminal — nothing is re-derived (§9.2.5). */
  evaluated: boolean;
  orderState?: 'READY' | 'INCOMPLETE';
  paymentMode?: PaymentMode;
  codOutstanding?: string | null;
  codAssignmentState?: CodAssignmentState;
  eligibility?: EligibilityResult;
  shipmentsUpdated?: number;
}

interface OrderRow {
  order_id: string;
  shop_id: string;
  order_state: string;
  order_amount: string | null;
  recipient_snapshot: WorkingRecipient | null;
  cod_assignment_state: CodAssignmentState;
}

interface LineRow {
  order_line_id: string;
  sku: string | null;
  quantity: number;
  weight_kg_override: string | null;
}

interface ShipmentRow {
  shipment_id: string;
  booking_state: string;
  custody_state: string;
  movement_state: string;
  awb_normalized: string | null;
  collectible: string;
  pickup_location_id: string | null;
  working_values: ShipmentWorkingValuesWeek4 | null;
}

interface Queryable {
  query: Pool['query'];
}

@Injectable()
export class OrderDerivationService {
  private readonly logger = new Logger(OrderDerivationService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  /**
   * Integration seam for order-sync (§9.2.1): called with the upsert result
   * after OrderIngestService.ingest (which includes the §9.2.3 allocation
   * rebuild, so the DRAFT shipments this writes to already exist).
   */
  async evaluateAfterUpsert(result: OrderUpsertResult): Promise<void> {
    // Booked/terminal orders are not re-derived by sync (§9.2.5, INV-17).
    if (!result.unbooked) return;
    await this.evaluateOrder(result.orderId);
  }

  async evaluateOrder(orderId: string): Promise<OrderDerivationOutcome> {
    const client = await this.pool.connect();
    let codAssignmentChange: {
      shopId: string;
      before: CodAssignmentState;
      after: CodAssignmentState;
    } | null = null;
    try {
      await client.query('BEGIN');

      // order_id is the PK; the row yields the shop scope (INV-1) every later
      // statement is constrained by. Lock it for the whole derivation (INV-22).
      const orderRes = await client.query<OrderRow>(
        `SELECT order_id, shop_id, order_state, order_amount,
                recipient_snapshot, cod_assignment_state
           FROM "order" WHERE order_id = $1 FOR UPDATE`,
        [orderId],
      );
      const order = orderRes.rows[0];
      if (!order || !(UNBOOKED_ORDER_STATES as readonly string[]).includes(order.order_state)) {
        await client.query('COMMIT');
        return { orderId, evaluated: false };
      }
      const shopId = order.shop_id;

      const [lineRes, profileRes, ruleRes, storeRes, syncRes, shipmentRes] = await Promise.all([
        client.query<LineRow>(
          `SELECT ol.order_line_id, ol.sku, ol.quantity, ol.weight_kg_override
             FROM order_line ol
             JOIN "order" o ON o.order_id = ol.order_id
            WHERE ol.order_id = $1 AND o.shop_id = $2`,
          [orderId, shopId],
        ),
        client.query<PackageProfileInput & { package_profile_id: string; length_cm: string; width_cm: string; height_cm: string; tare_kg: string; is_default: boolean }>(
          `SELECT package_profile_id, length_cm, width_cm, height_cm, tare_kg, is_default
             FROM package_profile WHERE shop_id = $1`,
          [shopId],
        ),
        client.query<{
          package_rule_id: string;
          position: number;
          min_dead_kg: string | null;
          max_dead_kg: string | null;
          min_items: number | null;
          max_items: number | null;
          package_profile_id: string;
        }>(
          `SELECT package_rule_id, position, min_dead_kg, max_dead_kg,
                  min_items, max_items, package_profile_id
             FROM package_selection_rule WHERE shop_id = $1 ORDER BY position`,
          [shopId],
        ),
        client.query<{ default_parcel_weight_kg: string }>(
          `SELECT default_parcel_weight_kg FROM store_settings WHERE shop_id = $1`,
          [shopId],
        ),
        client.query<{ cod_gateway_map: string[] }>(
          `SELECT cod_gateway_map FROM order_sync_settings WHERE shop_id = $1`,
          [shopId],
        ),
        client.query<ShipmentRow>(
          `SELECT shipment_id, booking_state, custody_state, movement_state,
                  awb_normalized, collectible, pickup_location_id, working_values
             FROM shipment WHERE shop_id = $1 AND order_id = $2`,
          [shopId, orderId],
        ),
      ]);

      const lines = lineRes.rows;
      const skus = [...new Set(lines.map((l) => l.sku).filter((s): s is string => s !== null))];
      const overrideRes =
        skus.length === 0
          ? { rows: [] as Array<{ sku: string; weight_kg: string | null; package_profile_id: string | null }> }
          : await client.query<{ sku: string; weight_kg: string | null; package_profile_id: string | null }>(
              `SELECT sku, weight_kg, package_profile_id
                 FROM sku_override WHERE shop_id = $1 AND sku = ANY($2::text[])`,
              [shopId, skus],
            );
      const overridesBySku = new Map(overrideRes.rows.map((r) => [r.sku, r]));

      const profiles: PackageProfileInput[] = profileRes.rows.map((p) => ({
        packageProfileId: p.package_profile_id,
        lengthCm: p.length_cm,
        widthCm: p.width_cm,
        heightCm: p.height_cm,
        tareKg: p.tare_kg,
        isDefault: p.is_default,
      }));
      const defaultParcelWeightKg =
        storeRes.rows[0]?.default_parcel_weight_kg ?? DEFAULT_PARCEL_WEIGHT_KG;
      const codGatewayMap = syncRes.rows[0]?.cod_gateway_map ?? COD_GATEWAY_MAP_SEED;

      // Mutable shipments carry the working values this derivation extends.
      const mutable = shipmentRes.rows.filter((s) =>
        ['DRAFT', 'NEEDS_MANUAL_ASSIGNMENT'].includes(s.booking_state),
      );
      // The S-14 input (§3.5): raw gateway names stored at ingest (week-3).
      const gatewayNames = [
        ...new Set(mutable.flatMap((s) => s.working_values?.payment?.gatewayNames ?? [])),
      ];

      // §3.5 + F-15 (§4.6). Basis: Shopify's total_outstanding when the
      // payload carried it (preferred — it IS F-17 − captured − refunds),
      // else the gateway heuristic (see payment.ts header).
      const totalOutstanding =
        mutable.map((s) => s.working_values?.payment?.totalOutstanding).find((v) => v != null) ??
        null;
      const hasCodMappedGateway = gatewayNames.some((g) => codGatewayMap.includes(g));
      const cod = deriveCodOutstanding({
        orderAmountF17: order.order_amount,
        totalOutstandingShopMoney: totalOutstanding,
        hasCodMappedGateway,
      });
      const paymentMode = derivePaymentMode({
        gatewayNames,
        codGatewayMap,
        codOutstanding: cod.codOutstanding,
      });

      // F-24 (§4.2) over the order's lines. NOTE: week-3 ingest merges the
      // Shopify per-unit weight into order_line.weight_kg_override, so the
      // column feeds the SHOPIFY rung here; the genuine merchant line-override
      // rung has no separate carrier yet (shared-change note in the handoff).
      const weightInputs = lines.map((l) => ({
        orderLineId: l.order_line_id,
        sku: l.sku,
        quantity: l.quantity,
        skuOverrideWeightKg: l.sku !== null ? (overridesBySku.get(l.sku)?.weight_kg ?? null) : null,
        shopifyWeightKg: l.weight_kg_override,
      }));
      // The rule-matching input (F-20) is the pre-tare parcel content weight —
      // tare depends on the profile being selected, so it cannot feed the
      // selection. A tare-free pass of the same pure ladder yields it; when no
      // line yielded weight the S-7 fallback IS the content weight.
      const preTare = deriveDeadWeight(weightInputs, '0.000', defaultParcelWeightKg);
      const contentWeightKg = preTare.usedDefaultParcelWeight
        ? defaultParcelWeightKg
        : preTare.lineWeightTotalKg;
      const totalItems = lines.reduce((acc, l) => acc + l.quantity, 0);

      // F-20 (§4.9). An unresolvable profile (INV-24 violation, or a shop
      // before onboarding seeds one) leaves weight/profile null → the order
      // is INCOMPLETE, never a guessed parcel (INV-7, §8.1).
      let selection: PackageSelectionResult | null = null;
      try {
        selection = selectPackageProfile({
          lineSkus: lines.map((l) => l.sku),
          skuOverrideProfiles: overrideRes.rows
            .filter((r) => r.package_profile_id !== null)
            .map((r) => ({
              sku: r.sku,
              profile: profiles.find((p) => p.packageProfileId === r.package_profile_id) as PackageProfileInput,
            }))
            .filter((o) => o.profile !== undefined),
          rules: ruleRes.rows.map((r) => ({
            packageRuleId: r.package_rule_id,
            position: r.position,
            minDeadKg: r.min_dead_kg,
            maxDeadKg: r.max_dead_kg,
            minItems: r.min_items,
            maxItems: r.max_items,
            packageProfileId: r.package_profile_id,
          })),
          profiles,
          contentWeightKg,
          totalItems,
        });
      } catch {
        selection = null;
      }

      const weight: DeadWeightResult | null =
        selection === null
          ? null
          : deriveDeadWeight(weightInputs, selection.profile.tareKg, defaultParcelWeightKg);

      // §3.24 / INV-9 across ALL of the order's shipments.
      const codAssignmentState = deriveCodAssignmentState({
        codOutstanding: cod.codOutstanding,
        shipments: shipmentRes.rows.map((s) => ({
          bookingState: s.booking_state,
          awbNormalized: s.awb_normalized,
          collectible: s.collectible,
        })),
      });

      // INV-7 (§3.1, §9.2.4). Order-level: allocated lines exist only while a
      // mutable shipment carries them (EXCLUDED allocations are never
      // bookable, §9.2.3); the pickup location is the shipment's (INV-3).
      const firstMutable = mutable[0];
      const eligibility = evaluateEligibility({
        recipient: order.recipient_snapshot,
        allocatedLineCount: mutable.length > 0 ? lines.filter((l) => l.quantity > 0).length : 0,
        deadWeightKg: weight?.deadWeightKg ?? null,
        dimensionsCm:
          selection === null
            ? null
            : {
                lengthCm: selection.profile.lengthCm,
                widthCm: selection.profile.widthCm,
                heightCm: selection.profile.heightCm,
              },
        pickupLocationId: firstMutable?.pickup_location_id ?? null,
        paymentMode,
        collectible: cod.codOutstanding,
      });

      // §3.1: IMPORTED → INCOMPLETE ↔ READY.
      const orderState = eligibility.ready ? 'READY' : 'INCOMPLETE';
      await client.query(
        `UPDATE "order"
            SET payment_mode = $3,
                cod_outstanding = $4,
                cod_assignment_state = $5,
                order_state = $6,
                version = version + 1
          WHERE shop_id = $1 AND order_id = $2
            AND order_state IN ('IMPORTED', 'INCOMPLETE', 'READY')`,
        [shopId, orderId, paymentMode, cod.codOutstanding, codAssignmentState, orderState],
      );

      // §2.9 additive working-values write on every mutable shipment.
      const evaluatedAt = new Date().toISOString();
      for (const shipment of mutable) {
        const current = shipment.working_values;
        const next: ShipmentWorkingValuesWeek4 = {
          schemaVersion: 1,
          recipient: current?.recipient ?? null,
          lines: current?.lines ?? [],
          payment: {
            mode: paymentMode,
            gatewayNames: current?.payment?.gatewayNames ?? gatewayNames,
            collectible: cod.codOutstanding ?? '0.00',
            totalOutstanding: current?.payment?.totalOutstanding ?? totalOutstanding,
          },
          fulfillment: current?.fulfillment ?? {
            sourceFulfillmentOrderGids: [],
            shopifyLocationGid: null,
            mergePath: 'CONSOLIDATED',
          },
          ...(weight !== null
            ? {
                weight: {
                  deadWeightKg: weight.deadWeightKg,
                  lineWeightTotalKg: weight.lineWeightTotalKg,
                  tareKg: weight.tareKg,
                  usedDefaultParcelWeight: weight.usedDefaultParcelWeight,
                  lines: weight.lines,
                },
              }
            : {}),
          ...(selection !== null
            ? {
                packageProfile: {
                  packageProfileId: selection.profile.packageProfileId,
                  source: selection.source,
                  matchedRuleId: selection.matchedRuleId,
                  lengthCm: selection.profile.lengthCm,
                  widthCm: selection.profile.widthCm,
                  heightCm: selection.profile.heightCm,
                  tareKg: selection.profile.tareKg,
                },
              }
            : {}),
          validation: {
            ready: eligibility.ready,
            failures: eligibility.failures,
            evaluatedAt,
          },
        };
        await client.query(
          `UPDATE shipment
              SET working_values = $3, version = version + 1
            WHERE shop_id = $1 AND shipment_id = $2
              AND booking_state IN ('DRAFT', 'NEEDS_MANUAL_ASSIGNMENT')`,
          [shopId, shipment.shipment_id, JSON.stringify(next)],
        );
      }

      await client.query('COMMIT');

      if (codAssignmentState !== order.cod_assignment_state) {
        codAssignmentChange = { shopId, before: order.cod_assignment_state, after: codAssignmentState };
      }

      // §5.7 control 4: IDs and states only — never recipient data.
      this.logger.log(
        `order derived shop=${shopId} order=${orderId} state=${orderState} ` +
          `payment=${paymentMode} cod=${codAssignmentState} shipments=${mutable.length}`,
      );
      return {
        orderId,
        evaluated: true,
        orderState,
        paymentMode,
        codOutstanding: cod.codOutstanding,
        codAssignmentState,
        eligibility,
        shipmentsUpdated: mutable.length,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
      // §12: every cod_assignment_state change is audited (post-commit, like
      // the order-sync module's own audit writes).
      if (codAssignmentChange) {
        const change = codAssignmentChange;
        await this.audit.record({
          shopId: change.shopId,
          actorKind: 'SYSTEM',
          action: 'COD_ASSIGNMENT_STATE_CHANGED',
          objectType: 'order',
          objectId: orderId,
          before: { cod_assignment_state: change.before },
          after: { cod_assignment_state: change.after },
          reason: '§3.24 / INV-9 derivation after order sync',
        });
      }
    }
  }

  /**
   * §3.24 / INV-9 persister for the booking and cancellation flows (weeks
   * 6–8): recompute cod_assignment_state after any shipment change on the
   * order. A change is persisted and audited; a no-change call is a no-op.
   */
  async recomputeCodAssignment(
    shopId: string,
    orderId: string,
  ): Promise<{ state: CodAssignmentState; changed: boolean }> {
    const orderRes = await this.pool.query<{
      cod_outstanding: string | null;
      cod_assignment_state: CodAssignmentState;
    }>(
      `SELECT cod_outstanding, cod_assignment_state
         FROM "order" WHERE shop_id = $1 AND order_id = $2`,
      [shopId, orderId],
    );
    const order = orderRes.rows[0];
    if (!order) throw new Error(`order ${orderId} not found in shop ${shopId}`);

    const shipmentRes = await this.pool.query<ShipmentRow>(
      `SELECT shipment_id, booking_state, custody_state, movement_state,
              awb_normalized, collectible, pickup_location_id, working_values
         FROM shipment WHERE shop_id = $1 AND order_id = $2`,
      [shopId, orderId],
    );
    const next = deriveCodAssignmentState({
      codOutstanding: order.cod_outstanding,
      shipments: shipmentRes.rows.map((s) => ({
        bookingState: s.booking_state,
        awbNormalized: s.awb_normalized,
        collectible: s.collectible,
      })),
    });
    if (next === order.cod_assignment_state) return { state: next, changed: false };

    await this.pool.query(
      `UPDATE "order"
          SET cod_assignment_state = $3, version = version + 1
        WHERE shop_id = $1 AND order_id = $2`,
      [shopId, orderId, next],
    );
    // §12: every cod_assignment_state change is audited.
    await this.audit.record({
      shopId,
      actorKind: 'SYSTEM',
      action: 'COD_ASSIGNMENT_STATE_CHANGED',
      objectType: 'order',
      objectId: orderId,
      before: { cod_assignment_state: order.cod_assignment_state },
      after: { cod_assignment_state: next },
      reason: '§3.24 / INV-9 derivation after shipment change',
    });
    return { state: next, changed: true };
  }
}
