import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import { AuditService } from '../../audit/audit.service';
import {
  CustomerScope,
  PrivacyRedactionService,
} from '../order-derivation/privacy-redaction.service';
import { TrackTokenService } from '../track-page/track-token.service';
import { MessageDispatcherService } from '../notifications/message-dispatcher.service';
import { OBJECT_ERASE, ObjectEraseStore } from './object-erase';

/**
 * §5.5 GDPR completion — the phase-2 sweep that finishes what
 * order-derivation's PrivacyRedactionService (phase 1: order.recipient_snapshot
 * + mutable shipment working-values recipients + track-token revocation)
 * deliberately deferred. This service COMPOSES phase 1 (delegates, never
 * duplicates its SQL) and then completes the §5.5 store list:
 *
 *  - primary tables (remainder): frozen shipment snapshots and issued
 *    gst_invoice buyer snapshots are pseudonymized. This is the §5.5 legal
 *    erasure overriding INV-10 / the gst_invoice append-only rule for the
 *    recipient PII subset only — financial facts (amounts, invoice numbers,
 *    tax totals, a buyer GSTIN where one exists) are retained as
 *    "specifically justified non-PII financial facts" (§5.5, §5.4 7-FY tax
 *    horizon). Pseudonymization never regresses: UPDATEs only match rows
 *    still carrying PII, so a replayed webhook is a no-op.
 *  - ndr_action payloads: ADD-27 buyer address corrections carry recipient
 *    PII in payload.address — stripped for the customer's shipments.
 *  - search indexes: NONE EXIST in v1 (verified — no search infrastructure
 *    in the schema or code); recorded as verified-no-action in the evidence.
 *  - rollup tables: rollup_hourly_stats contains NO PII (verified against
 *    dashboard/rollup.service.ts — dimensions are card names, service ids,
 *    state enums; metrics are counts/paise sums); no action.
 *  - object storage: label/manifest/packing-slip/bulk-label PDFs embed
 *    recipient PII. Object bytes are deleted through the OBJECT_ERASE seam
 *    and the document row's object_key is TOMBSTONED (redacted/<id>) — the
 *    row stays for counts and retention audit (§5.4), the content is gone.
 *    Customer scope: documents of the customer's shipments. Shop scope:
 *    every document of the shop, which also covers report-export CSVs
 *    (report_job.result_document_id → document rows).
 *  - exports (report CSVs): covered for shop redact by the document sweep
 *    above. For customer redact, an already-exported CSV is an immutable
 *    as-of snapshot (§5.2) and cannot be selectively edited; it expires on
 *    the 30-day report-export retention horizon (§5.4). Noted in evidence.
 *  - caches (Redis): verified key patterns — track-page throttle/failure
 *    counters (`track:thr:ip:{shop}:{ipHash}`, `track:fail:{shop}:{ipHash}`),
 *    notification throttles (`notif:thr:{shop}:…`), digests
 *    (`notif:digest:{shop}:…`) and COD/NDR response throttles are keyed by
 *    salted IP hash or member id — NO buyer PII is stored in any cache key
 *    or value, so per-customer eviction is a verified no-op. Shop redact
 *    evicts the shop-scoped patterns wholesale.
 *  - message_log.recipient_ref: salted hash only (verified —
 *    message-dispatcher.service.ts hashes via saltedPiiHash before insert);
 *    pseudonymous by construction, nothing to redact.
 *  - track tokens: revoked by phase 1 (per shipment); shop scope
 *    additionally calls revokeAllForShop to close any gap.
 *  - later-expiring backups: an ops procedure, not code — see OPS.md.
 *
 * Deletion evidence is one §12 audit row per run: scope + counts per store
 * type, never the PII itself.
 *
 * customers/data_request: produceFullDataRequest assembles the FULL held
 * record (orders + shipments + tracking events + messages + tickets) and
 * delivers it through the notifications dispatcher (with the dev-log sender
 * this is record-only — the send is a message_log row). INV-21: delivery
 * never gates; a dispatch failure is logged, not thrown.
 */

/** Tombstone marker replacing a deleted object's key on its document row. */
export const REDACTED_KEY_PREFIX = 'redacted/';

export interface StoreCounts {
  ordersRedacted: number;
  workingValuesTouched: number;
  snapshotsPseudonymized: number;
  gstBuyerSnapshotsStripped: number;
  ndrPayloadsStripped: number;
  objectsDeleted: number;
  documentsTombstoned: number;
  cacheKeysEvicted: number;
  trackTokensRevoked: number;
}

export interface FullRedactionEvidence extends StoreCounts {
  scope: 'customer' | 'shop';
  verifiedNoAction: string[];
}

export interface FullDataRequestRecord {
  orders: Array<{
    orderId: string;
    shopifyOrderGid: string | null;
    shopifyOrderNumber: string | null;
    createdAtShopify: string | null;
    recipientSnapshot: unknown;
  }>;
  shipments: Array<{
    shipmentId: string;
    orderId: string;
    awb: string | null;
    bookingState: string;
    movementState: string;
    recipient: unknown;
    bookedAt: string | null;
    deliveredAt: string | null;
  }>;
  trackingEvents: Array<{
    shipmentId: string;
    status: string | null;
    rawStatus: string;
    occurredAt: string;
    locationText: string | null;
  }>;
  messages: Array<{
    event: string;
    channel: string;
    state: string;
    shipmentId: string | null;
    queuedAt: string;
    sentAt: string | null;
    deliveredAt: string | null;
  }>;
  tickets: Array<{
    ticketId: string;
    number: string;
    category: string;
    state: string;
    subject: string;
    createdAt: string;
  }>;
}

/** Shopify GDPR payloads carry numeric IDs; our key is the GID (§8.1). */
function toGids(shopifyOrderIds: number[]): string[] {
  return shopifyOrderIds.map((id) => `gid://shopify/Order/${id}`);
}

@Injectable()
export class FullRedactionService {
  private readonly logger = new Logger(FullRedactionService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly phase1: PrivacyRedactionService,
    private readonly trackTokens: TrackTokenService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly dispatcher: MessageDispatcherService,
    @Inject(OBJECT_ERASE) private readonly objects: ObjectEraseStore,
  ) {}

  /** WHERE fragment shared by every customer-scoped step (same semantics as
   *  phase 1: GID listed OR snapshot email/phone; null criteria never
   *  match). NOTE: once phase 1 has nulled recipient_snapshot, only the GID
   *  list still identifies the customer's orders — capture ids FIRST. */
  private customerFilter(scope: CustomerScope): { sql: string; params: unknown[] } {
    return {
      sql: `AND (
              shopify_order_gid = ANY($2::text[])
              OR recipient_snapshot ->> 'email' = $3
              OR recipient_snapshot ->> 'phone' = $4
            )`,
      params: [toGids(scope.shopifyOrderIds), scope.email, scope.phone],
    };
  }

  private async customerOrderIds(
    shopId: string,
    scope: CustomerScope,
  ): Promise<string[]> {
    const filter = this.customerFilter(scope);
    const { rows } = await this.pool.query<{ order_id: string }>(
      `SELECT order_id FROM "order" WHERE shop_id = $1 ${filter.sql}`,
      [shopId, ...filter.params],
    );
    return rows.map((r) => r.order_id);
  }

  private async shipmentIds(
    shopId: string,
    orderIds: string[],
  ): Promise<string[]> {
    if (orderIds.length === 0) return [];
    const { rows } = await this.pool.query<{ shipment_id: string }>(
      `SELECT shipment_id FROM shipment
        WHERE shop_id = $1 AND order_id = ANY($2::uuid[])`,
      [shopId, orderIds],
    );
    return rows.map((r) => r.shipment_id);
  }

  /** Frozen booking snapshots: §5.5 erasure of the recipient subset — the
   *  one sanctioned exception to INV-10 immutability. Never regresses. */
  private async pseudonymizeSnapshots(
    shopId: string,
    orderIds: string[],
  ): Promise<number> {
    if (orderIds.length === 0) return 0;
    const { rowCount } = await this.pool.query(
      `UPDATE shipment
          SET snapshot = jsonb_set(snapshot, '{recipient}', 'null'::jsonb)
        WHERE shop_id = $1
          AND order_id = ANY($2::uuid[])
          AND snapshot ? 'recipient'
          AND snapshot -> 'recipient' <> 'null'::jsonb`,
      [shopId, orderIds],
    );
    return rowCount ?? 0;
  }

  /** Issued-invoice buyer PII strip (§5.5): keeps the buyer GSTIN (a tax
   *  fact) and every financial field; drops name/address. Never regresses —
   *  rows already stripped have legalName NULL and do not match. */
  private async stripGstBuyerSnapshots(
    shopId: string,
    orderIds: string[],
  ): Promise<number> {
    if (orderIds.length === 0) return 0;
    const { rowCount } = await this.pool.query(
      `UPDATE gst_invoice
          SET buyer_snapshot = jsonb_build_object(
                'legalName', NULL,
                'gstin', buyer_snapshot -> 'gstin',
                'addressLines', '[]'::jsonb,
                'city', NULL,
                'state', NULL,
                'pincode', NULL),
              version = version + 1
        WHERE shop_id = $1
          AND order_id = ANY($2::uuid[])
          AND buyer_snapshot ->> 'legalName' IS NOT NULL`,
      [shopId, orderIds],
    );
    return rowCount ?? 0;
  }

  /** ADD-27 buyer address corrections live in ndr_action.payload.address. */
  private async stripNdrPayloads(
    shopId: string,
    shipmentIds: string[],
  ): Promise<number> {
    if (shipmentIds.length === 0) return 0;
    const { rowCount } = await this.pool.query(
      `UPDATE ndr_action a
          SET payload = a.payload - 'address'
         FROM ndr_case c
        WHERE a.ndr_case_id = c.ndr_case_id
          AND c.shop_id = $1
          AND c.shipment_id = ANY($2::uuid[])
          AND a.payload ? 'address'`,
      [shopId, shipmentIds],
    );
    return rowCount ?? 0;
  }

  /** Delete object bytes and tombstone the document rows. Keys come from
   *  shop-scoped document rows (INV-1); erase is idempotent. */
  private async eraseDocuments(
    shopId: string,
    shipmentIds: string[] | null, // null = whole shop (shop/redact)
  ): Promise<{ objectsDeleted: number; documentsTombstoned: number }> {
    const { rows } = await this.pool.query<{
      document_id: string;
      object_key: string;
    }>(
      shipmentIds === null
        ? `SELECT document_id, object_key FROM document
            WHERE shop_id = $1 AND object_key NOT LIKE $2`
        : `SELECT document_id, object_key FROM document
            WHERE shop_id = $1 AND object_key NOT LIKE $2
              AND shipment_id = ANY($3::uuid[])`,
      shipmentIds === null
        ? [shopId, `${REDACTED_KEY_PREFIX}%`]
        : [shopId, `${REDACTED_KEY_PREFIX}%`, shipmentIds],
    );
    for (const row of rows) {
      await this.objects.delete(row.object_key);
    }
    if (rows.length === 0) {
      return { objectsDeleted: 0, documentsTombstoned: 0 };
    }
    const { rowCount } = await this.pool.query(
      `UPDATE document
          SET object_key = $2 || document_id::text
        WHERE shop_id = $1 AND document_id = ANY($3::uuid[])`,
      [shopId, REDACTED_KEY_PREFIX, rows.map((r) => r.document_id)],
    );
    return {
      objectsDeleted: rows.length,
      documentsTombstoned: rowCount ?? 0,
    };
  }

  /** Shop-scoped cache eviction (shop redact). Patterns verified against
   *  track-page / notifications / booking-ops key builders — all shop-scoped
   *  per INV-1. */
  private async evictShopCaches(shopId: string): Promise<number> {
    const patterns = [
      `track:thr:ip:${shopId}:*`,
      `track:fail:${shopId}:*`,
      `track:thr:shop:${shopId}`,
      `notif:thr:${shopId}:*`,
      `notif:digest:${shopId}:*`,
    ];
    let evicted = 0;
    for (const pattern of patterns) {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          200,
        );
        cursor = next;
        if (keys.length > 0) {
          await this.redis.del(...keys);
          evicted += keys.length;
        }
      } while (cursor !== '0');
    }
    return evicted;
  }

  private verifiedNoAction(): string[] {
    return [
      'search indexes: none exist in v1 — verified',
      'rollup_hourly_stats: no PII in dimension/metric keys — verified',
      'message_log.recipient_ref: salted hash only — verified',
      'later-expiring backups: ops procedure, see OPS.md',
    ];
  }

  /** §5.5 customers/redact — phase 1 plus the full store sweep. */
  async redactCustomerFull(
    shopId: string,
    scope: CustomerScope,
  ): Promise<FullRedactionEvidence> {
    // Capture identity BEFORE phase 1 nulls recipient_snapshot.
    const orderIds = await this.customerOrderIds(shopId, scope);
    const shipments = await this.shipmentIds(shopId, orderIds);

    const phase1Result = await this.phase1.redactCustomer(shopId, scope);

    const snapshotsPseudonymized = await this.pseudonymizeSnapshots(shopId, orderIds);
    const gstBuyerSnapshotsStripped = await this.stripGstBuyerSnapshots(shopId, orderIds);
    const ndrPayloadsStripped = await this.stripNdrPayloads(shopId, shipments);
    const { objectsDeleted, documentsTombstoned } = await this.eraseDocuments(
      shopId,
      shipments,
    );

    const evidence: FullRedactionEvidence = {
      scope: 'customer',
      ordersRedacted: phase1Result.ordersRedacted,
      workingValuesTouched: phase1Result.shipmentsTouched,
      snapshotsPseudonymized,
      gstBuyerSnapshotsStripped,
      ndrPayloadsStripped,
      objectsDeleted,
      documentsTombstoned,
      // Per-customer cache eviction is a verified no-op: no Redis key or
      // value holds buyer PII (all keyed by salted hash / member id).
      cacheKeysEvicted: 0,
      // Track tokens for these shipments were revoked by phase 1.
      trackTokensRevoked: 0,
      verifiedNoAction: this.verifiedNoAction(),
    };
    await this.audit.record({
      shopId,
      actorKind: 'SYSTEM',
      action: 'PRIVACY_REDACT_CUSTOMER_FULL',
      objectType: 'shop',
      objectId: shopId,
      after: evidence as unknown as Record<string, unknown>,
      reason: 'customers/redact completion sweep (§5.5)',
    });
    return evidence;
  }

  /** §5.5 shop/redact — phase 1 plus the full store sweep, shop-wide. */
  async redactShopFull(shopId: string): Promise<FullRedactionEvidence> {
    const phase1Result = await this.phase1.redactShop(shopId);

    // Shop-wide: every order and shipment of the shop.
    const { rows: orderRows } = await this.pool.query<{ order_id: string }>(
      `SELECT order_id FROM "order" WHERE shop_id = $1`,
      [shopId],
    );
    const orderIds = orderRows.map((r) => r.order_id);
    const shipments = await this.shipmentIds(shopId, orderIds);

    const snapshotsPseudonymized = await this.pseudonymizeSnapshots(shopId, orderIds);
    const gstBuyerSnapshotsStripped = await this.stripGstBuyerSnapshots(shopId, orderIds);
    const ndrPayloadsStripped = await this.stripNdrPayloads(shopId, shipments);
    // All shop documents — labels/manifests AND report-export CSVs.
    const { objectsDeleted, documentsTombstoned } = await this.eraseDocuments(
      shopId,
      null,
    );
    const cacheKeysEvicted = await this.evictShopCaches(shopId);
    // Belt-and-braces over phase 1's per-shipment revocation.
    const trackTokensRevoked = await this.trackTokens.revokeAllForShop(shopId);

    const evidence: FullRedactionEvidence = {
      scope: 'shop',
      ordersRedacted: phase1Result.ordersRedacted,
      workingValuesTouched: phase1Result.shipmentsTouched,
      snapshotsPseudonymized,
      gstBuyerSnapshotsStripped,
      ndrPayloadsStripped,
      objectsDeleted,
      documentsTombstoned,
      cacheKeysEvicted,
      trackTokensRevoked,
      verifiedNoAction: this.verifiedNoAction(),
    };
    await this.audit.record({
      shopId,
      actorKind: 'SYSTEM',
      action: 'PRIVACY_REDACT_SHOP_FULL',
      objectType: 'shop',
      objectId: shopId,
      after: evidence as unknown as Record<string, unknown>,
      reason: 'shop/redact completion sweep (§5.5)',
    });
    return evidence;
  }

  /**
   * §5.5 customers/data_request: the FULL held record — orders, shipments,
   * tracking events, messages and tickets for the customer. Delivered to
   * the customer's email through the notifications dispatcher (dev sender ⇒
   * record-only: a message_log row, no external send). INV-21: a delivery
   * failure never gates — it is logged and the record is still returned.
   * The audit row carries counts only; the record itself is PII by nature.
   */
  async produceFullDataRequest(
    shopId: string,
    scope: CustomerScope,
  ): Promise<FullDataRequestRecord> {
    const orderIds = await this.customerOrderIds(shopId, scope);
    const shipments = await this.shipmentIds(shopId, orderIds);

    const orders = orderIds.length
      ? (
          await this.pool.query(
            `SELECT order_id, shopify_order_gid, shopify_order_number,
                    created_at_shopify, recipient_snapshot
               FROM "order"
              WHERE shop_id = $1 AND order_id = ANY($2::uuid[])
              ORDER BY created_at_shopify`,
            [shopId, orderIds],
          )
        ).rows
      : [];

    const shipmentRows = shipments.length
      ? (
          await this.pool.query(
            `SELECT shipment_id, order_id, awb_raw, booking_state,
                    movement_state, snapshot -> 'recipient' AS recipient,
                    booked_at, delivered_at
               FROM shipment
              WHERE shop_id = $1 AND shipment_id = ANY($2::uuid[])
              ORDER BY created_at`,
            [shopId, shipments],
          )
        ).rows
      : [];

    const trackingRows = shipments.length
      ? (
          await this.pool.query(
            `SELECT shipment_id, carrier_event_status, raw_status,
                    occurred_at, location_text
               FROM tracking_event
              WHERE shop_id = $1 AND shipment_id = ANY($2::uuid[])
              ORDER BY occurred_at`,
            [shopId, shipments],
          )
        ).rows
      : [];

    const messageRows = shipments.length
      ? (
          await this.pool.query(
            `SELECT event, channel, state, shipment_id,
                    queued_at, sent_at, delivered_at
               FROM message_log
              WHERE shop_id = $1 AND shipment_id = ANY($2::uuid[])
              ORDER BY queued_at`,
            [shopId, shipments],
          )
        ).rows
      : [];

    const ticketRows = orderIds.length
      ? (
          await this.pool.query(
            `SELECT ticket_id, number, category, state, subject, created_at
               FROM ticket
              WHERE shop_id = $1 AND linked_order_id = ANY($2::uuid[])
              ORDER BY created_at`,
            [shopId, orderIds],
          )
        ).rows
      : [];

    const record: FullDataRequestRecord = {
      orders: orders.map((r) => ({
        orderId: r.order_id as string,
        shopifyOrderGid: r.shopify_order_gid as string | null,
        shopifyOrderNumber: r.shopify_order_number as string | null,
        createdAtShopify: r.created_at_shopify as string | null,
        recipientSnapshot: r.recipient_snapshot,
      })),
      shipments: shipmentRows.map((r) => ({
        shipmentId: r.shipment_id as string,
        orderId: r.order_id as string,
        awb: r.awb_raw as string | null,
        bookingState: r.booking_state as string,
        movementState: r.movement_state as string,
        recipient: r.recipient,
        bookedAt: r.booked_at as string | null,
        deliveredAt: r.delivered_at as string | null,
      })),
      trackingEvents: trackingRows.map((r) => ({
        shipmentId: r.shipment_id as string,
        status: r.carrier_event_status as string | null,
        rawStatus: r.raw_status as string,
        occurredAt: r.occurred_at as string,
        locationText: r.location_text as string | null,
      })),
      messages: messageRows.map((r) => ({
        event: r.event as string,
        channel: r.channel as string,
        state: r.state as string,
        shipmentId: r.shipment_id as string | null,
        queuedAt: r.queued_at as string,
        sentAt: r.sent_at as string | null,
        deliveredAt: r.delivered_at as string | null,
      })),
      tickets: ticketRows.map((r) => ({
        ticketId: r.ticket_id as string,
        number: r.number as string,
        category: r.category as string,
        state: r.state as string,
        subject: r.subject as string,
        createdAt: r.created_at as string,
      })),
    };

    if (scope.email) {
      try {
        await this.dispatcher.dispatch({
          shopId,
          channel: 'EMAIL',
          event: 'privacy.data_request',
          to: scope.email,
          subject: 'Your data held by this shop (Jsyxi Shipping)',
          body: JSON.stringify(record),
        });
      } catch (err) {
        // INV-21: delivery never gates the request flow.
        this.logger.error(
          `data_request delivery failed: ${err instanceof Error ? err.name : 'Error'}`,
        );
      }
    }

    await this.audit.record({
      shopId,
      actorKind: 'SYSTEM',
      action: 'PRIVACY_DATA_REQUEST_FULL',
      objectType: 'shop',
      objectId: shopId,
      after: {
        scope: 'customer',
        orderCount: record.orders.length,
        shipmentCount: record.shipments.length,
        trackingEventCount: record.trackingEvents.length,
        messageCount: record.messages.length,
        ticketCount: record.tickets.length,
        deliveredTo: scope.email !== null ? 'customer email on file' : 'not delivered (no email)',
      },
      reason: 'customers/data_request webhook (§5.5, INV-21)',
    });
    return record;
  }
}
