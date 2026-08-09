import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { ShopifyGraphqlClient } from '../shopify/shopify-graphql.client';
import { MappedOrder } from './order-mapper';
import { UNBOOKED_ORDER_STATES } from './order-upsert.service';
import { LocationService } from './location.service';
import {
  AllocationExclusionReason,
  AllocationPlanItem,
  FulfillmentOrderInfo,
  buildAllocationPlan,
} from './allocation-plan';
import {
  ORDER_FULFILLMENT_ORDERS_QUERY,
  OrderFulfillmentOrdersData,
} from './shopify-order.queries';
import { ShipmentWorkingValues, WorkingLine } from './working-values.types';

/**
 * §9.2.3 consolidation — the writing half. On order ingest (while the order
 * is unbooked) the order's fulfillment orders are fetched, its locations
 * auto-discovered, and its allocations + DRAFT shipments rebuilt in one
 * transaction. Rebuild is a delete+insert of the order's OPEN/EXCLUDED
 * allocations and DRAFT/NEEDS_MANUAL_ASSIGNMENT shipments — reachable only
 * while unbooked (§9.2.5, §10.4), so no booked Shipment is ever touched.
 */
@Injectable()
export class AllocationService {
  private readonly logger = new Logger(AllocationService.name);

  /**
   * Week-0 verification seam (§9.2.3, §8.4): whether Shopify lets us treat
   * an order's in-house fulfillment orders as one dispatch (move/merge
   * capability). Defaults to true — the fallback path (one Shipment per
   * fulfillment order, RV-06's only multi-shipment route) is one flag away.
   */
  canMergeFulfillmentOrders: (fos: FulfillmentOrderInfo[]) => boolean = () => true;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly graphql: ShopifyGraphqlClient,
    private readonly locations: LocationService,
    private readonly audit: AuditService,
  ) {}

  async fetchFulfillmentOrders(
    shopId: string,
    shopifyOrderGid: string,
  ): Promise<FulfillmentOrderInfo[]> {
    const data = await this.graphql.queryForShop<OrderFulfillmentOrdersData>(
      shopId,
      ORDER_FULFILLMENT_ORDERS_QUERY,
      { orderId: shopifyOrderGid },
    );
    return (data.order?.fulfillmentOrders.nodes ?? []).map((n) => ({
      gid: n.id,
      status: n.status,
      locationGid: n.assignedLocation?.location?.id ?? null,
      locationName: n.assignedLocation?.location?.name ?? null,
    }));
  }

  /**
   * Rebuild allocations + DRAFT shipments for an unbooked order. No-op
   * (rebuilt=false) when the order is booked or terminal — a post-booking
   * Shopify edit is cancel-then-rebook (§9.2.5), owned elsewhere.
   */
  async rebuild(
    shopId: string,
    orderId: string,
    mapped: MappedOrder,
  ): Promise<{ rebuilt: boolean }> {
    // Fetch + discover BEFORE opening the transaction (INV-1 shop-scoped).
    const fos = await this.fetchFulfillmentOrders(shopId, mapped.shopifyOrderGid);
    const unknownLocations = fos
      .filter((fo) => fo.locationGid !== null)
      .map((fo) => ({ id: fo.locationGid as string, name: fo.locationName ?? 'Unknown location' }));
    if (unknownLocations.length > 0) {
      // §9.2.3: a new location is auto-discovered with ships_via_jsyxi=true
      // and NEVER causes the order to be skipped.
      await this.locations.ensureLocations(shopId, unknownLocations);
    }
    const flags = await this.locations.getShipsViaFlags(
      shopId,
      [...new Set(unknownLocations.map((l) => l.id))],
    );
    const inHouse = fos.filter((fo) => ['OPEN', 'SCHEDULED', 'ON_HOLD'].includes(fo.status));
    const plan = buildAllocationPlan(
      fos,
      // Unknown location (null gid or just discovered) defaults to true —
      // same "never skip" rule.
      (gid) => (gid === null ? true : (flags.get(gid) ?? true)),
      this.canMergeFulfillmentOrders(inHouse),
    );

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the order row and re-check bookability inside the transaction.
      const orderRes = await client.query<{ order_state: string }>(
        `SELECT order_state FROM "order"
          WHERE shop_id = $1 AND order_id = $2
          FOR UPDATE`,
        [shopId, orderId],
      );
      const orderState = orderRes.rows[0]?.order_state;
      if (!orderState || !(UNBOOKED_ORDER_STATES as readonly string[]).includes(orderState)) {
        await client.query('ROLLBACK');
        return { rebuilt: false };
      }

      // The Shop's single active pickup location (INV-3) — nullable before
      // onboarding completes; booking blocks on it later (INV-7).
      const pickupRes = await client.query<{ pickup_location_id: string }>(
        `SELECT pickup_location_id FROM pickup_location
          WHERE shop_id = $1 AND is_active`,
        [shopId],
      );
      const pickupLocationId = pickupRes.rows[0]?.pickup_location_id ?? null;

      // Current order lines (order-scoped through the parent for INV-1).
      const lineRes = await client.query<{
        order_line_id: string;
        shopify_line_gid: string | null;
        sku: string | null;
        title: string | null;
        variant: string | null;
        quantity: number;
        unit_price: string | null;
        tags: string[];
        hsn_code: string | null;
        weight_kg_override: string | null;
      }>(
        `SELECT ol.order_line_id, ol.shopify_line_gid, ol.sku, ol.title, ol.variant,
                ol.quantity, ol.unit_price, ol.tags, ol.hsn_code, ol.weight_kg_override
           FROM order_line ol
           JOIN "order" o ON o.order_id = ol.order_id
          WHERE ol.order_id = $1 AND o.shop_id = $2`,
        [orderId, shopId],
      );
      const workingLines: WorkingLine[] = lineRes.rows.map((r) => ({
        orderLineId: r.order_line_id,
        shopifyLineGid: r.shopify_line_gid,
        sku: r.sku,
        title: r.title,
        variant: r.variant,
        quantity: r.quantity,
        unitPrice: r.unit_price,
        tags: r.tags,
        hsnCode: r.hsn_code,
        weightKgPerUnit: r.weight_kg_override,
      }));

      // §9.2.5: pre-booking refresh — replace only this order's unbooked
      // allocations and their DRAFT shipments. Shipment is append-only per
      // §5.3 for BOOKED rows; DRAFT working rows are freely mutable (§10.4)
      // and rebuilt here.
      await client.query(
        `DELETE FROM shipment_line sl
          USING shipment s
          WHERE sl.shipment_id = s.shipment_id
            AND sl.shipment_created_at = s.created_at
            AND s.shop_id = $1 AND s.order_id = $2
            AND s.booking_state IN ('DRAFT', 'NEEDS_MANUAL_ASSIGNMENT')`,
        [shopId, orderId],
      );
      await client.query(
        `DELETE FROM shipment
          WHERE shop_id = $1 AND order_id = $2
            AND booking_state IN ('DRAFT', 'NEEDS_MANUAL_ASSIGNMENT')`,
        [shopId, orderId],
      );
      await client.query(
        `DELETE FROM allocation a
          USING "order" o
          WHERE a.order_id = o.order_id
            AND a.order_id = $1 AND o.shop_id = $2
            AND a.state IN ('OPEN', 'EXCLUDED')`,
        [orderId, shopId],
      );

      for (const item of plan) {
        await this.writePlanItem(client, {
          shopId,
          orderId,
          pickupLocationId,
          mapped,
          workingLines,
          item,
        });
      }

      await client.query('COMMIT');
      // §5.7 control 4: log IDs and counts, never recipient data.
      this.logger.log(
        `allocations rebuilt shop=${shopId} order=${orderId} items=${plan.length}`,
      );
      return { rebuilt: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async writePlanItem(
    client: { query: Pool['query'] },
    args: {
      shopId: string;
      orderId: string;
      pickupLocationId: string | null;
      mapped: MappedOrder;
      workingLines: WorkingLine[];
      item: AllocationPlanItem;
    },
  ): Promise<void> {
    const { shopId, orderId, pickupLocationId, mapped, workingLines, item } = args;
    const allocRes = await client.query<{ allocation_id: string }>(
      `INSERT INTO allocation (order_id, pickup_location_id, source_fulfillment_order_gids, state)
       VALUES ($1, $2, $3, $4)
       RETURNING allocation_id`,
      [
        orderId,
        item.state === 'OPEN' ? pickupLocationId : null,
        item.sourceFulfillmentOrderGids,
        item.state,
      ],
    );
    const allocationId = allocRes.rows[0]?.allocation_id;
    if (!allocationId) throw new Error('allocation insert returned no row');

    if (item.state === 'EXCLUDED') {
      // INV-20 / §3.22: excluded WITH its reason — recorded (audit trail) and
      // surfaced, never silently absent. NOTE: a dedicated
      // allocation.exclusion_reason column is flagged as a shared schema
      // change; the audit entry is the durable store until it lands.
      await this.audit.record({
        shopId,
        actorKind: 'SYSTEM',
        action: 'ALLOCATION_EXCLUDED',
        objectType: 'allocation',
        objectId: allocationId,
        after: { order_id: orderId, state: 'EXCLUDED' },
        reason: item.exclusionReason,
      });
      return;
    }

    const workingValues: ShipmentWorkingValues = {
      schemaVersion: 1,
      recipient: mapped.recipientSnapshot,
      lines: workingLines,
      payment: {
        // §3.5 derivation is week-4 scope; raw gateway names are the S-14 input.
        mode: 'UNRESOLVED',
        gatewayNames: mapped.gatewayNames,
        collectible: '0.00',
        totalOutstanding: mapped.totalOutstandingShopMoney,
      },
      fulfillment: {
        sourceFulfillmentOrderGids: item.sourceFulfillmentOrderGids,
        shopifyLocationGid: item.shopifyLocationGid,
        mergePath: item.mergePath ?? 'CONSOLIDATED',
      },
    };

    // shipment is partitioned by month on created_at — created_at comes from
    // its default now() and is RETURNed so child rows can name it.
    const shipRes = await client.query<{ shipment_id: string; created_at: string }>(
      `INSERT INTO shipment (
         shop_id, order_id, allocation_id, pickup_location_id, working_values
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING shipment_id, created_at`,
      [shopId, orderId, allocationId, pickupLocationId, JSON.stringify(workingValues)],
    );
    const shipment = shipRes.rows[0];
    if (!shipment) throw new Error('shipment insert returned no row');

    for (const line of workingLines) {
      await client.query(
        `INSERT INTO shipment_line (shipment_id, shipment_created_at, order_line_id, quantity)
         VALUES ($1, $2, $3, $4)`,
        [shipment.shipment_id, shipment.created_at, line.orderLineId, line.quantity],
      );
    }
  }

  /**
   * orders/fulfilled: quantities fulfilled outside Jsyxi are never bookable
   * (§9.2.5) — the affected OPEN allocations become EXCLUDED with the reason
   * (§9.2.3, INV-20). Guarded on state='OPEN', so a replay is a no-op.
   *
   * @param gids fulfilled fulfillment-order GIDs; null = the whole order was
   *             fulfilled externally (all OPEN allocations).
   */
  async markExternallyFulfilled(
    shopId: string,
    orderId: string,
    gids: string[] | null,
  ): Promise<string[]> {
    const { rows } = await this.pool.query<{ allocation_id: string }>(
      `UPDATE allocation a
          SET state = 'EXCLUDED', version = a.version + 1
         FROM "order" o
         WHERE a.order_id = o.order_id
           AND o.shop_id = $1
           AND a.order_id = $2
           AND a.state = 'OPEN'
           AND ($3::text[] IS NULL OR a.source_fulfillment_order_gids && $3::text[])
       RETURNING a.allocation_id`,
      [shopId, orderId, gids],
    );
    const allocationIds = rows.map((r) => r.allocation_id);
    if (allocationIds.length > 0) {
      // Excluded quantity is never bookable (§9.2.5): drop the unbooked
      // DRAFT shipments sitting on these allocations with their lines.
      await this.pool.query(
        `DELETE FROM shipment_line sl
          USING shipment s
          WHERE sl.shipment_id = s.shipment_id
            AND sl.shipment_created_at = s.created_at
            AND s.shop_id = $1
            AND s.allocation_id = ANY($2::uuid[])
            AND s.booking_state IN ('DRAFT', 'NEEDS_MANUAL_ASSIGNMENT')`,
        [shopId, allocationIds],
      );
      await this.pool.query(
        `DELETE FROM shipment
          WHERE shop_id = $1
            AND allocation_id = ANY($2::uuid[])
            AND booking_state IN ('DRAFT', 'NEEDS_MANUAL_ASSIGNMENT')`,
        [shopId, allocationIds],
      );
    }
    for (const row of rows) {
      await this.audit.record({
        shopId,
        actorKind: 'SYSTEM',
        action: 'ALLOCATION_EXCLUDED',
        objectType: 'allocation',
        objectId: row.allocation_id,
        after: { order_id: orderId, state: 'EXCLUDED' },
        reason: 'EXTERNALLY_FULFILLED' satisfies AllocationExclusionReason,
      });
    }
    return rows.map((r) => r.allocation_id);
  }
}
