import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../database/database.module';
import { AuditService } from '../../../audit/audit.service';
import {
  ShopifyWebhookDispatcher,
  ShopifyWebhookHandler,
  ShopifyWebhookMessage,
} from '../../shopify/webhook-dispatcher.service';
import { BillingService } from '../billing.service';

/**
 * §3.11 / §9.14: app/subscriptions_update — a Shopify-side subscription
 * status change (DECLINED, FROZEN, CANCELLED, ACTIVE) drives the account
 * capability ladder via BillingService.applyExternalStatus. §8.1's durable
 * inbox makes a replayed delivery idempotent (the service guards on state).
 */
@Injectable()
export class SubscriptionsUpdateHandler implements ShopifyWebhookHandler, OnModuleInit {
  readonly topic = 'app/subscriptions_update';

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly dispatcher: ShopifyWebhookDispatcher,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(message: ShopifyWebhookMessage): Promise<void> {
    const status = (message.payload as { app_subscription?: { status?: string } })
      ?.app_subscription?.status;
    if (!status) return; // nothing to apply — stored in the inbox regardless
    const result = await this.billing.applyExternalStatus(message.shopId, status);
    if (result.applied) {
      await this.audit.record({
        shopId: message.shopId,
        actorKind: 'SYSTEM',
        action: 'billing.subscription_status_applied',
        objectType: 'shop',
        objectId: message.shopId,
        after: { status, mapped: result.mapped },
        reason: 'app/subscriptions_update webhook (§3.11)',
      });
    }
  }
}
