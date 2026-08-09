import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  ShopifyWebhookDispatcher,
  ShopifyWebhookHandler,
  ShopifyWebhookMessage,
} from '../../shopify/webhook-dispatcher.service';
import { FullRedactionService } from '../../health/full-redaction.service';

/**
 * §8.1 GDPR topics (§5.5): customers/redact, shop/redact,
 * customers/data_request. Registered on the dispatcher exactly like
 * AppUninstalledHandler; HMAC + inbox durability + (shop, topic, external_id)
 * dedupe happen upstream in the ingest tier.
 *
 * Payloads carry buyer PII (customer email/phone) — they are used as match
 * criteria only and are never logged or audited (§5.7 control 4, §12).
 */

interface GdprCustomerPayload {
  customer?: { id?: number | string | null; email?: string | null; phone?: string | null } | null;
  orders_to_redact?: Array<number | string> | null;
  orders_requested?: Array<number | string> | null;
}

function toIds(values: Array<number | string> | null | undefined): number[] {
  return (values ?? [])
    .map((v) => (typeof v === 'number' ? v : Number.parseInt(v, 10)))
    .filter((v) => Number.isFinite(v));
}

function scopeFrom(payload: unknown, key: 'orders_to_redact' | 'orders_requested') {
  const p = (payload ?? {}) as GdprCustomerPayload;
  return {
    shopifyOrderIds: toIds(p[key]),
    email: p.customer?.email ?? null,
    phone: p.customer?.phone ?? null,
  };
}

/** §5.5 customers/redact. */
@Injectable()
export class CustomersRedactHandler implements ShopifyWebhookHandler, OnModuleInit {
  readonly topic = 'customers/redact';

  constructor(
    private readonly dispatcher: ShopifyWebhookDispatcher,
    private readonly redaction: FullRedactionService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(message: ShopifyWebhookMessage): Promise<void> {
    // §5.5 completion: the full store sweep, not just primary tables.
    await this.redaction.redactCustomerFull(
      message.shopId,
      scopeFrom(message.payload, 'orders_to_redact'),
    );
  }
}

/** §5.5 shop/redact — the whole shop's orders, no customer filter. */
@Injectable()
export class ShopRedactHandler implements ShopifyWebhookHandler, OnModuleInit {
  readonly topic = 'shop/redact';

  constructor(
    private readonly dispatcher: ShopifyWebhookDispatcher,
    private readonly redaction: FullRedactionService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(message: ShopifyWebhookMessage): Promise<void> {
    await this.redaction.redactShopFull(message.shopId);
  }
}

/** §5.5 customers/data_request (INV-21: delivery never gates). */
@Injectable()
export class CustomersDataRequestHandler implements ShopifyWebhookHandler, OnModuleInit {
  readonly topic = 'customers/data_request';

  constructor(
    private readonly dispatcher: ShopifyWebhookDispatcher,
    private readonly redaction: FullRedactionService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(message: ShopifyWebhookMessage): Promise<void> {
    // The full record is produced and delivered via the notifications sender
    // (record-only in dev); INV-21 — delivery never gates.
    await this.redaction.produceFullDataRequest(
      message.shopId,
      scopeFrom(message.payload, 'orders_requested'),
    );
  }
}
