import { Injectable, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../../audit/audit.service';
import {
  ShopifyWebhookDispatcher,
  ShopifyWebhookHandler,
  ShopifyWebhookMessage,
} from '../../shopify/webhook-dispatcher.service';
import { OrderIngestService } from '../order-ingest.service';
import { OrderUpsertService } from '../order-upsert.service';
import { AllocationService } from '../allocation.service';
import { ShopifyRestOrderPayload } from '../shopify-order-payload.types';

/**
 * §8.1 orders/* topic handlers, registered on the Shopify webhook
 * dispatcher exactly like AppUninstalledHandler. All handlers are safe to
 * re-run from a replayed inbox row:
 *  - create/updated → the upsert is keyed on (shop_id, shopify_order_gid),
 *    so a replay just rewrites the same values (INV-22 versioned);
 *  - cancelled → guarded on the current state (terminal never regresses,
 *    INV-17);
 *  - fulfilled → guarded on allocation state='OPEN' (INV-20).
 */

/** orders/create → mapper upsert (§9.2.1: new orders land IMPORTED). */
@Injectable()
export class OrdersCreateHandler implements ShopifyWebhookHandler, OnModuleInit {
  readonly topic = 'orders/create';

  constructor(
    private readonly dispatcher: ShopifyWebhookDispatcher,
    private readonly ingest: OrderIngestService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(message: ShopifyWebhookMessage): Promise<void> {
    await this.ingest.ingest(message.shopId, message.payload as ShopifyRestOrderPayload);
  }
}

/** orders/updated → same upsert; terminal states are never regressed and
 *  lines/allocations are rewritten only while unbooked (§9.2.5, INV-17). */
@Injectable()
export class OrdersUpdatedHandler implements ShopifyWebhookHandler, OnModuleInit {
  readonly topic = 'orders/updated';

  constructor(
    private readonly dispatcher: ShopifyWebhookDispatcher,
    private readonly ingest: OrderIngestService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(message: ShopifyWebhookMessage): Promise<void> {
    await this.ingest.ingest(message.shopId, message.payload as ShopifyRestOrderPayload);
  }
}

/** orders/cancelled → CANCELLED_IN_SHOPIFY (terminal, §3.1). The order is
 *  upserted first so an out-of-order cancel still lands the row; the state
 *  transition itself is guarded, so replays are no-ops. */
@Injectable()
export class OrdersCancelledHandler implements ShopifyWebhookHandler, OnModuleInit {
  readonly topic = 'orders/cancelled';

  constructor(
    private readonly dispatcher: ShopifyWebhookDispatcher,
    private readonly ingest: OrderIngestService,
    private readonly upserts: OrderUpsertService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(message: ShopifyWebhookMessage): Promise<void> {
    const result = await this.ingest.ingest(
      message.shopId,
      message.payload as ShopifyRestOrderPayload,
    );
    const transitioned = await this.upserts.markCancelledInShopify(
      message.shopId,
      result.upsert.orderId,
    );
    if (transitioned) {
      await this.audit.record({
        shopId: message.shopId,
        actorKind: 'SYSTEM',
        action: 'ORDER_CANCELLED_IN_SHOPIFY',
        objectType: 'order',
        objectId: result.upsert.orderId,
        after: { order_state: 'CANCELLED_IN_SHOPIFY' },
        reason: 'orders/cancelled webhook (§3.1)',
      });
    }
  }
}

/** orders/fulfilled → the externally-fulfilled quantities are never
 *  bookable (§9.2.5): affected OPEN allocations become EXCLUDED with the
 *  reason stored (§9.2.3, INV-20). */
@Injectable()
export class OrdersFulfilledHandler implements ShopifyWebhookHandler, OnModuleInit {
  readonly topic = 'orders/fulfilled';

  constructor(
    private readonly dispatcher: ShopifyWebhookDispatcher,
    private readonly ingest: OrderIngestService,
    private readonly allocations: AllocationService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(message: ShopifyWebhookMessage): Promise<void> {
    const payload = message.payload as ShopifyRestOrderPayload;
    const result = await this.ingest.ingest(message.shopId, payload);
    const fos = await this.allocations.fetchFulfillmentOrders(
      message.shopId,
      result.mapped.shopifyOrderGid,
    );
    const closedGids = fos.filter((fo) => fo.status === 'CLOSED').map((fo) => fo.gid);
    // fulfillment_status='fulfilled' with no resolvable fulfillment orders
    // still means: the whole order was fulfilled outside Jsyxi (null = all).
    const gids =
      closedGids.length > 0 ? closedGids : payload.fulfillment_status === 'fulfilled' ? null : [];
    if (gids === null || gids.length > 0) {
      await this.allocations.markExternallyFulfilled(
        message.shopId,
        result.upsert.orderId,
        gids,
      );
    }
  }
}
