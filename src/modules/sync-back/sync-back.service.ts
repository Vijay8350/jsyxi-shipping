import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { TrackTokenService } from '../track-page/track-token.service';
import { mapCarrierEventToShopify, fulfillmentEventMessage } from './fulfillment-event.map';
import type {
  AddFulfillmentEventPayload,
  CancelFulfillmentPayload,
  CarrierEventStatus,
  CreateFulfillmentPayload,
  FulfillmentOrderLineMapping,
  SetOrderTagsPayload,
  SyncOperation,
  SyncOutboxRow,
} from './sync-back.types';

/**
 * §8.4 sync-back outbox writer + §3.17 DEAD replay.
 *
 * Every write to Shopify enters `sync_outbox` here. Invariants enforced at
 * enqueue:
 *
 *  - INV-19: a test shipment writes NOTHING to Shopify — no fulfillment,
 *    tracking number, event, tag or customer notification. The skip is
 *    silent by design (§9.6); only the id is logged at debug (§5.7.4: ids
 *    only, never PII).
 *  - ADD-39: an order without a Shopify GID (manual/CSV source) has nothing
 *    to sync back to — skipped the same way.
 *  - INV-8: payloads are built from the frozen booking snapshot, never from
 *    current master data.
 *  - §8.4 idempotency: idempotency_key = (shop_id, shipment_id, operation,
 *    attempt-invariant digest); INSERT ... ON CONFLICT DO NOTHING makes a
 *    repeat enqueue a no-op, never a second fulfillment.
 */

interface ShipmentSyncRow {
  shipment_id: string;
  shop_id: string;
  order_id: string;
  is_test: boolean;
  awb_raw: string | null;
  awb_normalized: string | null;
  snapshot: {
    service?: { name?: string };
    courierAccount?: { courierAccountId?: string };
    shopify?: {
      orderGid?: string | null;
      lineGids?: string[];
      fulfillmentOrderGids?: string[];
    };
    lines?: Array<{ shopifyLineGid: string | null; quantity: number }>;
  } | null;
}

/** §8.4 tracking URL inputs — see resolveTrackingUrl. */
export interface TrackingUrlInput {
  /** S-37: replace the courier tracking link with the Track-Order page. */
  s37ReplaceTrackingLink: boolean;
  /** Track-Order page URL for this shipment (track-token link, §9.16). */
  trackPageUrl: string | null;
  /** The courier's own public tracking URL for this AWB. */
  courierTrackingUrl: string | null;
}

/** §8.4: Track-Order page URL when S-37 is on, else the courier's own URL. */
export function resolveTrackingUrl(input: TrackingUrlInput): string | null {
  if (input.s37ReplaceTrackingLink) return input.trackPageUrl;
  return input.courierTrackingUrl;
}

/** §8.4 attempt-invariant digest: stable across retries of one operation. */
function invariantDigest(fields: Record<string, unknown>): string {
  const canonical = JSON.stringify(fields, Object.keys(fields).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function idempotencyKey(
  shopId: string,
  scopeId: string,
  operation: SyncOperation,
  digest: string,
): string {
  // §8.4: (shop_id, shipment_id, operation, attempt-invariant digest).
  return `${shopId}:${scopeId}:${operation}:${digest}`;
}

@Injectable()
export class SyncBackService {
  private readonly logger = new Logger(SyncBackService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly trackTokens: TrackTokenService,
  ) {}

  /** On booking CONFIRMED (§8.4, §9.6): one fulfillment per Shipment. */
  async enqueueFulfillmentCreate(shopId: string, shipmentId: string): Promise<void> {
    const shipment = await this.loadShipment(shopId, shipmentId);
    if (!shipment || (await this.skipTest(shipment))) return;
    const orderGid = await this.loadOrderGid(shopId, shipment.order_id);
    if (!orderGid) return; // ADD-39 manual order — nothing to sync back to.

    const snapshot = shipment.snapshot;
    const foGids = snapshot?.shopify?.fulfillmentOrderGids ?? [];
    const lines = (snapshot?.lines ?? [])
      .filter(
        (l): l is { shopifyLineGid: string; quantity: number } => l.shopifyLineGid !== null,
      )
      .map((l) => ({ shopifyLineGid: l.shopifyLineGid, quantity: l.quantity }));
    const lineItemsByFulfillmentOrder: FulfillmentOrderLineMapping[] = foGids.map((gid) => ({
      fulfillmentOrderGid: gid,
      lines,
    }));
    const payload: CreateFulfillmentPayload = {
      shopifyOrderGid: orderGid,
      awb: shipment.awb_raw ?? shipment.awb_normalized ?? '',
      courierName: await this.loadCourierName(shopId, snapshot?.courierAccount?.courierAccountId),
      serviceName: snapshot?.service?.name ?? '',
      trackingUrl: await this.resolveTrackingUrlFor(shipment),
      notifyCustomer: await this.loadNotifyCustomer(shopId),
      lineItemsByFulfillmentOrder,
    };
    await this.insertOutbox(
      shopId,
      shipment.order_id,
      shipmentId,
      'CREATE_FULFILLMENT',
      payload,
      invariantDigest({ awb: payload.awb }),
    );
  }

  /** Per normalized carrier event (§8.4 fulfillment events, A3-06 mapping). */
  async enqueueFulfillmentEvent(
    shopId: string,
    shipmentId: string,
    carrierEventStatus: CarrierEventStatus,
  ): Promise<void> {
    const shipment = await this.loadShipment(shopId, shipmentId);
    if (!shipment || (await this.skipTest(shipment))) return;
    if (!(await this.loadOrderGid(shopId, shipment.order_id))) return;

    const payload: AddFulfillmentEventPayload = {
      carrierEventStatus,
      shopifyStatus: mapCarrierEventToShopify(carrierEventStatus),
      // §8.4: the exact Jsyxi status MUST be in the event message text.
      message: fulfillmentEventMessage(carrierEventStatus),
      fulfillmentGid: await this.loadSucceededFulfillmentGid(shopId, shipmentId),
    };
    await this.insertOutbox(
      shopId,
      shipment.order_id,
      shipmentId,
      'ADD_FULFILLMENT_EVENT',
      payload,
      invariantDigest({ carrierEventStatus }),
    );
  }

  /** On confirmed cancellation (§9.5.5 → §8.4). */
  async enqueueFulfillmentCancel(shopId: string, shipmentId: string): Promise<void> {
    const shipment = await this.loadShipment(shopId, shipmentId);
    if (!shipment || (await this.skipTest(shipment))) return;
    const orderGid = await this.loadOrderGid(shopId, shipment.order_id);
    if (!orderGid) return;

    const payload: CancelFulfillmentPayload = {
      shopifyOrderGid: orderGid,
      fulfillmentGid: await this.loadSucceededFulfillmentGid(shopId, shipmentId),
    };
    await this.insertOutbox(
      shopId,
      shipment.order_id,
      shipmentId,
      'CANCEL_FULFILLMENT',
      payload,
      invariantDigest({}),
    );
  }

  /** §8.4 optional order tags. Order-scoped; INV-19 checks the order flag. */
  async enqueueSetOrderTags(shopId: string, orderId: string, tags: string[]): Promise<void> {
    const { rows } = await this.pool.query<{
      shopify_order_gid: string | null;
      is_test_order: boolean;
    }>(
      `SELECT shopify_order_gid, is_test_order FROM "order"
        WHERE shop_id = $1 AND order_id = $2`,
      [shopId, orderId],
    );
    const order = rows[0];
    if (!order) throw new NotFoundException('order not found in this shop');
    if (order.is_test_order) {
      // INV-19: a test order gets no Shopify writes, including tags.
      this.logger.debug(`sync-back skipped for test order ${orderId}`);
      return;
    }
    if (!order.shopify_order_gid) return; // ADD-39.
    const payload: SetOrderTagsPayload = {
      shopifyOrderGid: order.shopify_order_gid,
      tags: [...tags].sort(),
    };
    await this.insertOutbox(
      shopId,
      orderId,
      null,
      'SET_ORDER_TAGS',
      payload,
      invariantDigest({ tags: payload.tags }),
    );
  }

  /**
   * §3.17 / §8.6: DEAD exits only via an authorized admin replay, which
   * returns the item to PENDING with attempts reset. Every replay is audited
   * (A1-10, §12). Admin-only — the controller guards the boundary.
   */
  async replay(outboxId: string, adminId: string): Promise<void> {
    const { rows } = await this.pool.query<SyncOutboxRow>(
      `SELECT outbox_id, shop_id, state, attempts, version
         FROM sync_outbox
        WHERE outbox_id = $1
        FOR UPDATE`,
      [outboxId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('sync outbox item not found');
    if (row.state !== 'DEAD') {
      throw new ConflictException(`only DEAD items can be replayed (state is ${row.state})`);
    }
    await this.pool.query(
      `UPDATE sync_outbox
          SET state = 'PENDING', attempts = 0, next_attempt_at = now(),
              version = version + 1
        WHERE outbox_id = $1 AND version = $2`,
      [outboxId, row.version],
    );
    // Close out the matching DLQ item (§2.8 dlq_item replay markers).
    await this.pool.query(
      `UPDATE dlq_item
          SET replayed_at = now(), replayed_by = $2
        WHERE queue = 'shopify-sync'
          AND payload ->> 'outbox_id' = $1
          AND replayed_at IS NULL`,
      [outboxId, adminId],
    );
    await this.audit.record({
      shopId: row.shop_id,
      actorKind: 'ADMIN',
      actorId: adminId,
      action: 'sync_outbox.replay',
      objectType: 'sync_outbox',
      objectId: outboxId,
      before: { state: 'DEAD', attempts: row.attempts },
      after: { state: 'PENDING', attempts: 0 },
    });
  }

  /** Test shipments write NOTHING to Shopify (INV-19); the skip is silent. */
  private async skipTest(shipment: ShipmentSyncRow): Promise<boolean> {
    if (!shipment.is_test) return false;
    this.logger.debug(`sync-back skipped for test shipment ${shipment.shipment_id}`);
    return true;
  }

  private async loadShipment(shopId: string, shipmentId: string): Promise<ShipmentSyncRow | null> {
    // Shop-scoped (INV-1); reads the frozen snapshot (INV-8).
    const { rows } = await this.pool.query<ShipmentSyncRow>(
      `SELECT shipment_id, shop_id, order_id, is_test, awb_raw, awb_normalized, snapshot
         FROM shipment
        WHERE shop_id = $1 AND shipment_id = $2`,
      [shopId, shipmentId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('shipment not found in this shop');
    return row;
  }

  private async loadOrderGid(shopId: string, orderId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ shopify_order_gid: string | null }>(
      `SELECT shopify_order_gid FROM "order" WHERE shop_id = $1 AND order_id = $2`,
      [shopId, orderId],
    );
    return rows[0]?.shopify_order_gid ?? null;
  }

  /** S-9 (notify customer on fulfillment; default on). */
  private async loadNotifyCustomer(shopId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ notify_customer: boolean }>(
      `SELECT notify_customer FROM order_sync_settings WHERE shop_id = $1`,
      [shopId],
    );
    return rows[0]?.notify_customer ?? true;
  }

  private async loadCourierName(
    shopId: string,
    courierAccountId: string | undefined,
  ): Promise<string> {
    if (!courierAccountId) return '';
    const { rows } = await this.pool.query<{ name: string }>(
      `SELECT c.name
         FROM courier_account ca
         JOIN courier c ON c.courier_id = ca.courier_id
        WHERE ca.shop_id = $1 AND ca.courier_account_id = $2`,
      [shopId, courierAccountId],
    );
    return rows[0]?.name ?? '';
  }

  /**
   * §8.4 tracking URL: the per-shipment Track-Order page link when S-37 is
   * on (§9.16, A2-12), else the courier's own URL — no courier URL template
   * exists in the courier master yet, so that side resolves to null and
   * Shopify renders the tracking number without a link.
   */
  private async resolveTrackingUrlFor(shipment: ShipmentSyncRow): Promise<string | null> {
    const { rows } = await this.pool.query<{ replace_tracking_link: boolean }>(
      `SELECT replace_tracking_link FROM track_page_config WHERE shop_id = $1`,
      [shipment.shop_id],
    );
    const s37 = rows[0]?.replace_tracking_link ?? false; // S-37 default: off
    let trackPageUrl: string | null = null;
    if (s37) {
      const issued = await this.trackTokens.issue(shipment.shop_id, shipment.shipment_id);
      trackPageUrl = issued.url;
    }
    return resolveTrackingUrl({
      s37ReplaceTrackingLink: s37,
      trackPageUrl,
      courierTrackingUrl: null,
    });
  }

  /** The fulfillment GID this shipment's SUCCEEDED create wrote back. */
  private async loadSucceededFulfillmentGid(
    shopId: string,
    shipmentId: string,
  ): Promise<string | null> {
    const { rows } = await this.pool.query<{ gid: string | null }>(
      `SELECT payload ->> 'fulfillmentGid' AS gid
         FROM sync_outbox
        WHERE shop_id = $1 AND shipment_id = $2
          AND operation = 'CREATE_FULFILLMENT' AND state = 'SUCCEEDED'
        ORDER BY updated_at DESC
        LIMIT 1`,
      [shopId, shipmentId],
    );
    return rows[0]?.gid ?? null;
  }

  /**
   * §8.4: ON CONFLICT (idempotency_key) DO NOTHING — a repeat enqueue is a
   * no-op, never a second fulfillment.
   */
  private async insertOutbox(
    shopId: string,
    orderId: string,
    shipmentId: string | null,
    operation: SyncOperation,
    payload: unknown,
    digest: string,
  ): Promise<boolean> {
    const key = idempotencyKey(shopId, shipmentId ?? orderId, operation, digest);
    const { rowCount } = await this.pool.query(
      `INSERT INTO sync_outbox
         (shop_id, order_id, shipment_id, operation, payload, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [shopId, orderId, shipmentId, operation, JSON.stringify(payload), key],
    );
    return (rowCount ?? 0) > 0;
  }
}

/**
 * The seam the booking flow injects — the canonical token and interface live
 * in `booking-ops/sync-back-publisher.ts` (defined there first as the seam);
 * re-exported here so this module's providers use the SAME DI token.
 */
export { SYNC_BACK_PUBLISHER, SyncBackPublisher } from '../booking-ops/sync-back-publisher';
import type { SyncBackPublisher } from '../booking-ops/sync-back-publisher';

@Injectable()
export class ShopifySyncBackPublisher implements SyncBackPublisher {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly syncBack: SyncBackService,
  ) {}

  /** §9.6: on booking CONFIRMED, enqueue the fulfillment create. */
  async enqueueFulfillmentCreate(shipmentId: string): Promise<void> {
    const { rows } = await this.pool.query<{ shop_id: string }>(
      `SELECT shop_id FROM shipment WHERE shipment_id = $1`,
      [shipmentId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('shipment not found');
    await this.syncBack.enqueueFulfillmentCreate(row.shop_id, shipmentId);
  }
}
