import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { hmacSha256Base64, safeEqualBase64 } from '../../common/crypto';
import { ShopifyWebhookDispatcher } from './webhook-dispatcher.service';

/**
 * §8.1 inbound Shopify webhook ingest tier.
 *
 * Contract: verify HMAC over the RAW body → durably INSERT a webhook_inbox
 * row in RECEIVED → then 2xx, fast (within 5 s). Dedupe on
 * (shop_id, topic, external_id); a repeat is a no-op 200. A failed HMAC is
 * rejected 401 and audited, never processed.
 *
 * Processing currently runs inline AFTER the durable write, but handlers see
 * only the inbox-row message (see ShopifyWebhookDispatcher), so this can
 * move to a queue worker without handler changes.
 */

export interface WebhookIngestInput {
  rawBody: Buffer | undefined;
  hmacHeader: string | undefined;
  shopDomain: string | undefined;
  topic: string | undefined;
  webhookId: string | undefined;
}

export interface WebhookIngestResult {
  status: number;
  body: Record<string, unknown>;
}

@Injectable()
export class ShopifyWebhookIngestService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly dispatcher: ShopifyWebhookDispatcher,
  ) {}

  async ingest(input: WebhookIngestInput): Promise<WebhookIngestResult> {
    if (!input.rawBody || !Buffer.isBuffer(input.rawBody)) {
      // Fail closed: without the raw body HMAC cannot be verified. This means
      // the raw-body parser was not wired for this route (see module README
      // note in the PR summary / main.ts `rawBody: true`).
      return {
        status: 500,
        body: { status: 'RAW_BODY_UNAVAILABLE', message: 'raw body parser not registered for this route' },
      };
    }
    const { hmacHeader, shopDomain, topic, webhookId } = input;
    if (!hmacHeader || !shopDomain || !topic || !webhookId) {
      return { status: 400, body: { status: 'HEADERS_MISSING' } };
    }

    // §8.1: base64 HMAC-SHA256 over the raw body, constant-time compare.
    const secret = this.config.get<string>('shopify.apiSecret') ?? '';
    const expected = hmacSha256Base64(secret, input.rawBody);
    if (!safeEqualBase64(expected, hmacHeader)) {
      await this.audit.record({
        shopId: null,
        actorKind: 'SYSTEM',
        action: 'SHOPIFY_WEBHOOK_HMAC_REJECTED',
        objectType: 'webhook_inbox',
        objectId: null,
        reason: `topic ${topic}`,
      });
      return { status: 401, body: { status: 'HMAC_REJECTED' } };
    }

    // Domain → internal shop_id (INV-1: everything downstream is shop-scoped).
    const shopRows = await this.pool.query<{ shop_id: string }>(
      `SELECT shop_id FROM shop WHERE myshopify_domain = $1`,
      [shopDomain],
    );
    const shop = shopRows.rows[0];
    if (!shop) {
      // INV-20: not dropped silently — audited; 200 so Shopify stops retrying
      // an event we can never attribute.
      await this.audit.record({
        shopId: null,
        actorKind: 'SYSTEM',
        action: 'SHOPIFY_WEBHOOK_UNKNOWN_SHOP',
        objectType: 'shop',
        objectId: shopDomain,
        reason: `topic ${topic}`,
      });
      return { status: 200, body: { status: 'IGNORED_UNKNOWN_SHOP' } };
    }

    // §8.1: durable RECEIVED row BEFORE the 2xx; dedupe on
    // (shop_id, topic, external_id) — a repeat is a no-op 200.
    const inserted = await this.pool.query<{ inbox_id: string }>(
      `INSERT INTO webhook_inbox (shop_id, source, topic, external_id, payload)
       VALUES ($1, 'SHOPIFY', $2, $3, $4)
       ON CONFLICT (shop_id, topic, external_id) DO NOTHING
       RETURNING inbox_id`,
      [shop.shop_id, topic, webhookId, input.rawBody.toString('utf8')],
    );
    const inboxId = inserted.rows[0]?.inbox_id;
    if (!inboxId) {
      return { status: 200, body: { status: 'DUPLICATE' } };
    }

    try {
      const outcome = await this.dispatcher.dispatch({
        inboxId,
        shopId: shop.shop_id,
        topic,
        externalId: webhookId,
        payload: JSON.parse(input.rawBody.toString('utf8')) as unknown,
      });
      if (outcome === 'HANDLED') {
        await this.pool.query(
          `UPDATE webhook_inbox
              SET state = 'PROCESSED', processed_at = now(), version = version + 1
            WHERE inbox_id = $1 AND shop_id = $2`,
          [inboxId, shop.shop_id],
        );
        return { status: 200, body: { status: 'RECEIVED', handled: true } };
      }
      // No handler for this topic yet (e.g. orders/* land with order sync) —
      // the durable row stays RECEIVED for its owning module.
      return { status: 200, body: { status: 'RECEIVED', handled: false } };
    } catch {
      // The durable row is safe; mark it FAILED for the §8.6 retry/replay
      // path and still ack — Shopify must not hammer us with retries.
      await this.pool.query(
        `UPDATE webhook_inbox
            SET state = 'FAILED', attempts = attempts + 1, version = version + 1
          WHERE inbox_id = $1 AND shop_id = $2`,
        [inboxId, shop.shop_id],
      );
      return { status: 200, body: { status: 'RECEIVED', handled: false, processing: 'FAILED' } };
    }
  }
}
