import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { TrackTokenService } from '../track-page/track-token.service';
import { WorkingRecipient } from '../order-sync/working-values.types';

/**
 * §5.5 privacy redaction (customers/redact, shop/redact,
 * customers/data_request) — phase 1 scope: `order.recipient_snapshot` (the
 * RV-13 protected set) plus the `recipient` block inside mutable DRAFT /
 * NEEDS_MANUAL_ASSIGNMENT shipments' working values (§10.4). Frozen booking
 * snapshots (INV-10) and shipped parcels are NOT touched in phase 1 — the
 * §5.5 sweep of object storage, exports, caches and backups is a
 * later-module concern (labels/documents/reports don't exist yet).
 *
 * Rules honoured here:
 *  - redaction REMOVES PII (recipient_snapshot → NULL) and never regresses:
 *    the UPDATEs only touch rows where the snapshot is still present, so a
 *    replay is a no-op and nothing is ever restored;
 *  - deletion evidence is an audit row per §12 naming scope + COUNTS — never
 *    the PII itself;
 *  - customers/data_request produces the record of what is held and audits
 *    the request with counts only; buyer-facing delivery is the
 *    notifications module's concern (INV-21 — it never gates this flow).
 */

export interface CustomerScope {
  /** Shopify numeric order IDs (orders_to_redact / orders_requested). */
  shopifyOrderIds: number[];
  email: string | null;
  phone: string | null;
}

export interface RedactionResult {
  ordersRedacted: number;
  shipmentsTouched: number;
}

export interface DataRequestRecord {
  orders: Array<{
    orderId: string;
    shopifyOrderGid: string | null;
    shopifyOrderNumber: string | null;
    recipientSnapshot: WorkingRecipient | null;
  }>;
}

/** Shopify GDPR payloads carry numeric IDs; our key is the GID (§8.1). */
function toGids(shopifyOrderIds: number[]): string[] {
  return shopifyOrderIds.map((id) => `gid://shopify/Order/${id}`);
}

@Injectable()
export class PrivacyRedactionService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly trackTokens: TrackTokenService,
  ) {}

  /** §5.5: "Redaction revokes buyer track access." */
  private async revokeTrackAccess(shopId: string, orderIds: string[]): Promise<void> {
    if (orderIds.length === 0) return;
    const { rows } = await this.pool.query<{ shipment_id: string }>(
      `SELECT shipment_id FROM shipment WHERE shop_id = $1 AND order_id = ANY($2::uuid[])`,
      [shopId, orderIds],
    );
    for (const row of rows) {
      await this.trackTokens.revokeForShipment(shopId, row.shipment_id);
    }
  }

  /** WHERE fragment shared by redact + data-request: the order belongs to
   *  the customer when its GID is listed OR its snapshot carries the
   *  customer's email/phone. Null criteria never match. */
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

  /** Nulls the recipient block in mutable shipments' working values for the
   *  given orders (§10.4 — frozen snapshots are INV-10 immutable). */
  private async redactWorkingValueRecipients(
    shopId: string,
    orderIds: string[],
  ): Promise<number> {
    if (orderIds.length === 0) return 0;
    const { rowCount } = await this.pool.query(
      `UPDATE shipment
          SET working_values = jsonb_set(working_values, '{recipient}', 'null'::jsonb),
              version = version + 1
        WHERE shop_id = $1
          AND order_id = ANY($2::uuid[])
          AND booking_state IN ('DRAFT', 'NEEDS_MANUAL_ASSIGNMENT')
          AND working_values ? 'recipient'
          AND working_values -> 'recipient' <> 'null'::jsonb`,
      [shopId, orderIds],
    );
    return rowCount ?? 0;
  }

  /** §5.5 customers/redact: remove the protected recipient set for one
   *  customer across the shop's orders. */
  async redactCustomer(shopId: string, scope: CustomerScope): Promise<RedactionResult> {
    const filter = this.customerFilter(scope);
    // Never regresses: rows already redacted (recipient_snapshot IS NULL) do
    // not match, so a replayed webhook is a no-op.
    const { rows } = await this.pool.query<{ order_id: string }>(
      `UPDATE "order"
          SET recipient_snapshot = NULL, version = version + 1
        WHERE shop_id = $1
          AND recipient_snapshot IS NOT NULL
          ${filter.sql}
        RETURNING order_id`,
      [shopId, ...filter.params],
    );
    const orderIds = rows.map((r) => r.order_id);
    await this.revokeTrackAccess(shopId, orderIds);
    const shipmentsTouched = await this.redactWorkingValueRecipients(shopId, orderIds);
    // §12: deletion evidence — scope + counts, never the PII.
    await this.audit.record({
      shopId,
      actorKind: 'SYSTEM',
      action: 'PRIVACY_REDACT_CUSTOMER',
      objectType: 'shop',
      objectId: shopId,
      after: {
        scope: 'customer',
        ordersRedacted: orderIds.length,
        shipmentsTouched,
        fieldsRemoved: ['order.recipient_snapshot', 'shipment.working_values.recipient'],
      },
      reason: 'customers/redact webhook (§5.5)',
    });
    return { ordersRedacted: orderIds.length, shipmentsTouched };
  }

  /** §5.5 shop/redact: remove the protected recipient set across ALL of the
   *  shop's orders. */
  async redactShop(shopId: string): Promise<RedactionResult> {
    const { rows } = await this.pool.query<{ order_id: string }>(
      `UPDATE "order"
          SET recipient_snapshot = NULL, version = version + 1
        WHERE shop_id = $1
          AND recipient_snapshot IS NOT NULL
        RETURNING order_id`,
      [shopId],
    );
    const orderIds = rows.map((r) => r.order_id);
    await this.revokeTrackAccess(shopId, orderIds);
    const shipmentsTouched = await this.redactWorkingValueRecipients(shopId, orderIds);
    await this.audit.record({
      shopId,
      actorKind: 'SYSTEM',
      action: 'PRIVACY_REDACT_SHOP',
      objectType: 'shop',
      objectId: shopId,
      after: {
        scope: 'shop',
        ordersRedacted: orderIds.length,
        shipmentsTouched,
        fieldsRemoved: ['order.recipient_snapshot', 'shipment.working_values.recipient'],
      },
      reason: 'shop/redact webhook (§5.5)',
    });
    return { ordersRedacted: orderIds.length, shipmentsTouched };
  }

  /** §5.5 customers/data_request: the record of what is held for the
   *  customer. Returned to the caller; buyer-facing delivery is the
   *  notifications module's concern (INV-21). The audit row carries counts
   *  only — the record itself contains PII by nature and is not logged. */
  async produceDataRequest(shopId: string, scope: CustomerScope): Promise<DataRequestRecord> {
    const filter = this.customerFilter(scope);
    const { rows } = await this.pool.query<{
      order_id: string;
      shopify_order_gid: string | null;
      shopify_order_number: string | null;
      recipient_snapshot: WorkingRecipient | null;
    }>(
      `SELECT order_id, shopify_order_gid, shopify_order_number, recipient_snapshot
         FROM "order"
        WHERE shop_id = $1
          ${filter.sql}
        ORDER BY created_at_shopify`,
      [shopId, ...filter.params],
    );
    await this.audit.record({
      shopId,
      actorKind: 'SYSTEM',
      action: 'PRIVACY_DATA_REQUEST',
      objectType: 'shop',
      objectId: shopId,
      after: { scope: 'customer', orderCount: rows.length },
      reason: 'customers/data_request webhook (§5.5, INV-21)',
    });
    return {
      orders: rows.map((r) => ({
        orderId: r.order_id,
        shopifyOrderGid: r.shopify_order_gid,
        shopifyOrderNumber: r.shopify_order_number,
        recipientSnapshot: r.recipient_snapshot,
      })),
    };
  }
}
