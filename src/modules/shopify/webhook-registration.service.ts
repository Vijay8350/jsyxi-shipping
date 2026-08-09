import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../../audit/audit.service';
import { ShopifyGraphqlClient } from './shopify-graphql.client';
import { ShopifyWebhookDispatcher } from './webhook-dispatcher.service';

/**
 * §8.1: subscribes each shop to the webhook topics this app handles.
 *
 * WHY PER SHOP. Shopify rejects app-specific (declarative) webhook
 * subscriptions whenever `use_legacy_install_flow` is enabled, and that flag is
 * required here: the app runs its own OAuth to obtain an ONLINE token carrying
 * `associated_user`, which is the only source of per-staff identity (§9.1.2).
 * Managed install would hand back an offline shop-level token and skip the
 * callback entirely. So the subscriptions are created against the Admin API
 * once per shop instead of being declared in shopify.app.toml.
 *
 * The topic list comes from ShopifyWebhookDispatcher, so a handler and its
 * subscription cannot drift apart — adding a handler is what subscribes a shop.
 *
 * Compliance topics are deliberately excluded: Shopify manages
 * customers/redact, shop/redact and customers/data_request at the APP level
 * (declared under [webhooks.privacy_compliance] and pushed with
 * `shopify app deploy`). Attempting to create them per shop is an error.
 *
 * Idempotent by construction — it reconciles observed state against desired
 * state, so it is safe to run at every install, on reinstall, or as a repair.
 */

/** Handled by the app-level configuration, never per shop. */
const COMPLIANCE_TOPICS = new Set([
  'customers/redact',
  'shop/redact',
  'customers/data_request',
]);

const SUBSCRIPTION_PAGE_SIZE = 100;

const EXISTING_QUERY = `query ExistingWebhooks($first: Int!) {
  webhookSubscriptions(first: $first) {
    edges {
      node {
        id
        topic
        endpoint { ... on WebhookHttpEndpoint { callbackUrl } }
      }
    }
  }
}`;

const CREATE_MUTATION = `mutation WebhookCreate($topic: WebhookSubscriptionTopic!, $subscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;

const UPDATE_MUTATION = `mutation WebhookUpdate($id: ID!, $subscription: WebhookSubscriptionInput!) {
  webhookSubscriptionUpdate(id: $id, webhookSubscription: $subscription) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;

interface ExistingResponse {
  webhookSubscriptions: {
    edges: Array<{
      node: {
        id: string;
        topic: string;
        endpoint: { callbackUrl?: string } | null;
      };
    }>;
  };
}

interface MutationResponse {
  webhookSubscriptionCreate?: MutationPayload;
  webhookSubscriptionUpdate?: MutationPayload;
}

interface MutationPayload {
  webhookSubscription: { id: string } | null;
  userErrors: Array<{ field?: string[] | null; message?: string }>;
}

export interface WebhookSyncResult {
  callbackUrl: string;
  created: string[];
  updated: string[];
  unchanged: string[];
  failed: Array<{ topic: string; reason: string }>;
}

/**
 * `orders/create` → `ORDERS_CREATE`. Shopify's REST-style topic strings (which
 * arrive on the x-shopify-topic header and key the dispatcher) differ from the
 * GraphQL WebhookSubscriptionTopic enum, so the two representations are
 * converted here rather than being duplicated across the codebase.
 */
export function toGraphqlTopic(topic: string): string {
  return topic.toUpperCase().replace(/[/-]/g, '_');
}

@Injectable()
export class ShopifyWebhookRegistrationService {
  private readonly logger = new Logger(ShopifyWebhookRegistrationService.name);

  constructor(
    private readonly graphql: ShopifyGraphqlClient,
    private readonly dispatcher: ShopifyWebhookDispatcher,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /** Topics subscribed per shop: everything with a handler, minus compliance. */
  desiredTopics(): string[] {
    return this.dispatcher.topics().filter((t) => !COMPLIANCE_TOPICS.has(t));
  }

  /** The single endpoint; webhooks.controller.ts routes on x-shopify-topic. */
  callbackUrl(): string {
    const appUrl = (this.config.get<string>('shopify.appUrl') ?? '').replace(/\/+$/, '');
    return `${appUrl}/webhooks/shopify`;
  }

  /**
   * Reconcile this shop's subscriptions with the desired set. Creates what is
   * missing and repoints anything aimed at a stale callback URL (which is what
   * a domain change looks like from here).
   *
   * Never throws for a single topic: one bad topic must not abandon the rest.
   * A topic that fails is reported in `failed` for the caller to audit.
   */
  async syncForShop(shopId: string): Promise<WebhookSyncResult> {
    const callbackUrl = this.callbackUrl();
    const result: WebhookSyncResult = {
      callbackUrl,
      created: [],
      updated: [],
      unchanged: [],
      failed: [],
    };

    const existing = await this.readExisting(shopId);

    for (const topic of this.desiredTopics()) {
      const graphqlTopic = toGraphqlTopic(topic);
      const current = existing.get(graphqlTopic);
      try {
        if (!current) {
          await this.mutate(shopId, 'create', { topic: graphqlTopic, callbackUrl });
          result.created.push(topic);
        } else if (current.callbackUrl !== callbackUrl) {
          // Same topic, wrong destination — repoint rather than duplicate.
          await this.mutate(shopId, 'update', { id: current.id, callbackUrl });
          result.updated.push(topic);
        } else {
          result.unchanged.push(topic);
        }
      } catch (err) {
        result.failed.push({ topic, reason: (err as Error).message });
      }
    }

    await this.audit.record({
      shopId,
      actorKind: 'SYSTEM',
      action: result.failed.length > 0 ? 'SHOPIFY_WEBHOOKS_SYNC_PARTIAL' : 'SHOPIFY_WEBHOOKS_SYNCED',
      objectType: 'shop',
      objectId: shopId,
      after: {
        callback_url: callbackUrl,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        failed: result.failed.map((f) => f.topic),
      },
      reason:
        result.failed.length > 0
          ? `${result.failed.length} topic(s) failed to subscribe; orders for those topics will not sync`
          : null,
    });

    if (result.failed.length > 0) {
      this.logger.error(
        `webhook sync incomplete for shop ${shopId}: ${result.failed
          .map((f) => `${f.topic} (${f.reason})`)
          .join(', ')}`,
      );
    }

    return result;
  }

  /** GraphQL topic → { id, callbackUrl } for what the shop already has. */
  private async readExisting(
    shopId: string,
  ): Promise<Map<string, { id: string; callbackUrl: string | null }>> {
    const data = await this.graphql.queryForShop<ExistingResponse>(shopId, EXISTING_QUERY, {
      first: SUBSCRIPTION_PAGE_SIZE,
    });
    const map = new Map<string, { id: string; callbackUrl: string | null }>();
    for (const edge of data?.webhookSubscriptions?.edges ?? []) {
      const node = edge?.node;
      if (!node?.topic) continue;
      map.set(node.topic, {
        id: node.id,
        callbackUrl: node.endpoint?.callbackUrl ?? null,
      });
    }
    return map;
  }

  /**
   * Shopify reports business failures in `userErrors` with HTTP 200, so a
   * non-empty userErrors is an error here — otherwise a shop silently ends up
   * with no subscription and the cause surfaces much later as "orders are not
   * syncing".
   */
  private async mutate(
    shopId: string,
    kind: 'create' | 'update',
    input: { topic?: string; id?: string; callbackUrl: string },
  ): Promise<void> {
    const subscription = { callbackUrl: input.callbackUrl, format: 'JSON' };
    const data = await this.graphql.queryForShop<MutationResponse>(
      shopId,
      kind === 'create' ? CREATE_MUTATION : UPDATE_MUTATION,
      kind === 'create'
        ? { topic: input.topic, subscription }
        : { id: input.id, subscription },
    );
    const payload =
      kind === 'create' ? data?.webhookSubscriptionCreate : data?.webhookSubscriptionUpdate;
    const userErrors = payload?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new Error(userErrors.map((e) => e.message ?? 'unknown').join('; '));
    }
    if (!payload?.webhookSubscription?.id) {
      throw new Error(`webhookSubscription${kind === 'create' ? 'Create' : 'Update'} returned no subscription`);
    }
  }
}
