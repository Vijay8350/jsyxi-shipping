import { Injectable } from '@nestjs/common';

/**
 * §8.1 webhook dispatch. Topic handlers self-register by topic string
 * (orders/* topics register the same way when the order-sync module lands).
 *
 * The dispatch unit is the DURABLE inbox row, so the call site can move from
 * inline processing (today) to a BullMQ worker (later) without any handler
 * changes — a worker would load the row and call dispatch() with it.
 */

export interface ShopifyWebhookMessage {
  inboxId: string;
  shopId: string;
  topic: string;
  externalId: string;
  payload: unknown;
}

export interface ShopifyWebhookHandler {
  readonly topic: string;
  handle(message: ShopifyWebhookMessage): Promise<void>;
}

export type DispatchOutcome = 'HANDLED' | 'UNHANDLED';

@Injectable()
export class ShopifyWebhookDispatcher {
  private readonly handlers = new Map<string, ShopifyWebhookHandler>();

  register(handler: ShopifyWebhookHandler): void {
    if (this.handlers.has(handler.topic)) {
      throw new Error(`duplicate Shopify webhook handler for topic ${handler.topic}`);
    }
    this.handlers.set(handler.topic, handler);
  }

  /** UNHANDLED means no registered topic handler — the inbox row stays RECEIVED for its owning module. */
  async dispatch(message: ShopifyWebhookMessage): Promise<DispatchOutcome> {
    const handler = this.handlers.get(message.topic);
    if (!handler) return 'UNHANDLED';
    await handler.handle(message);
    return 'HANDLED';
  }
}
