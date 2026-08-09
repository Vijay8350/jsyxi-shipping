import { describe, expect, it, vi } from 'vitest';
import {
  ShopifyWebhookRegistrationService,
  toGraphqlTopic,
} from '../../src/modules/shopify/webhook-registration.service';
import { ShopifyWebhookDispatcher } from '../../src/modules/shopify/webhook-dispatcher.service';
import { mockConfig } from './helpers';

const SHOP_ID = 'shop-1';
const CALLBACK = 'https://app.jsyxi.test/webhooks/shopify';

function handler(topic: string) {
  return { topic, handle: vi.fn().mockResolvedValue(undefined) };
}

/**
 * The dispatcher is real, not mocked: the point of the design is that the
 * handler registry drives the subscription set, so a mock would test nothing.
 */
function setup(
  opts: {
    topics?: string[];
    existing?: Array<{ topic: string; id: string; callbackUrl: string | null }>;
    createResult?: unknown;
  } = {},
) {
  const {
    topics = ['orders/create', 'app/uninstalled'],
    existing = [],
    createResult,
  } = opts;

  const dispatcher = new ShopifyWebhookDispatcher();
  for (const t of topics) dispatcher.register(handler(t));

  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const queryForShop = vi.fn(
    async (_shopId: string, query: string, variables: Record<string, unknown>) => {
      calls.push({ query, variables });
      if (query.includes('ExistingWebhooks')) {
        return {
          webhookSubscriptions: {
            edges: existing.map((e) => ({
              node: {
                id: e.id,
                topic: e.topic,
                endpoint: e.callbackUrl === null ? null : { callbackUrl: e.callbackUrl },
              },
            })),
          },
        };
      }
      if (createResult !== undefined) return createResult;
      const key = query.includes('WebhookCreate')
        ? 'webhookSubscriptionCreate'
        : 'webhookSubscriptionUpdate';
      return { [key]: { webhookSubscription: { id: 'gid://sub/1' }, userErrors: [] } };
    },
  );

  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new ShopifyWebhookRegistrationService(
    { queryForShop } as never,
    dispatcher,
    mockConfig(),
    audit as never,
  );
  return { service, dispatcher, audit, calls, queryForShop };
}

describe('toGraphqlTopic (§8.1 topic representation)', () => {
  it('converts REST-style topics to the GraphQL enum', () => {
    expect(toGraphqlTopic('orders/create')).toBe('ORDERS_CREATE');
    expect(toGraphqlTopic('app/uninstalled')).toBe('APP_UNINSTALLED');
    expect(toGraphqlTopic('app/subscriptions_update')).toBe('APP_SUBSCRIPTIONS_UPDATE');
    expect(toGraphqlTopic('orders/partially_fulfilled')).toBe('ORDERS_PARTIALLY_FULFILLED');
  });
});

describe('ShopifyWebhookRegistrationService.desiredTopics', () => {
  it('subscribes every handled topic — the dispatcher is the source of truth', () => {
    const { service } = setup({ topics: ['orders/create', 'orders/updated', 'app/uninstalled'] });
    expect(service.desiredTopics()).toEqual([
      'app/uninstalled',
      'orders/create',
      'orders/updated',
    ]);
  });

  it('excludes the compliance topics — Shopify manages those at app level', () => {
    const { service } = setup({
      topics: [
        'orders/create',
        'customers/redact',
        'shop/redact',
        'customers/data_request',
      ],
    });
    // Registering these per shop is an API error, so they must never be sent.
    expect(service.desiredTopics()).toEqual(['orders/create']);
  });
});

describe('ShopifyWebhookRegistrationService.syncForShop (§8.1)', () => {
  it('creates every missing subscription against the single callback URL', async () => {
    const { service, calls } = setup({ topics: ['orders/create', 'app/uninstalled'] });

    const result = await service.syncForShop(SHOP_ID);

    expect(result.created.sort()).toEqual(['app/uninstalled', 'orders/create']);
    expect(result.failed).toEqual([]);
    expect(result.callbackUrl).toBe(CALLBACK);

    const creates = calls.filter((c) => c.query.includes('WebhookCreate'));
    expect(creates).toHaveLength(2);
    expect(creates.map((c) => c.variables.topic).sort()).toEqual([
      'APP_UNINSTALLED',
      'ORDERS_CREATE',
    ]);
    for (const c of creates) {
      expect(c.variables.subscription).toEqual({ callbackUrl: CALLBACK, format: 'JSON' });
    }
  });

  it('is idempotent: an already-correct subscription is left alone', async () => {
    const { service, calls } = setup({
      topics: ['orders/create'],
      existing: [{ topic: 'ORDERS_CREATE', id: 'gid://sub/9', callbackUrl: CALLBACK }],
    });

    const result = await service.syncForShop(SHOP_ID);

    expect(result.unchanged).toEqual(['orders/create']);
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    // Reinstall must not duplicate subscriptions.
    expect(calls.filter((c) => c.query.includes('WebhookCreate'))).toHaveLength(0);
  });

  it('repoints a subscription aimed at a stale callback URL', async () => {
    const { service, calls } = setup({
      topics: ['orders/create'],
      existing: [
        { topic: 'ORDERS_CREATE', id: 'gid://sub/9', callbackUrl: 'https://old.example/webhooks/shopify' },
      ],
    });

    const result = await service.syncForShop(SHOP_ID);

    expect(result.updated).toEqual(['orders/create']);
    expect(result.created).toEqual([]);
    const updates = calls.filter((c) => c.query.includes('WebhookUpdate'));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.variables.id).toBe('gid://sub/9');
    expect(updates[0]?.variables.subscription).toEqual({
      callbackUrl: CALLBACK,
      format: 'JSON',
    });
  });

  it('treats userErrors as failure — Shopify returns them with HTTP 200', async () => {
    const { service, audit } = setup({
      topics: ['orders/create'],
      createResult: {
        webhookSubscriptionCreate: {
          webhookSubscription: null,
          userErrors: [{ field: ['topic'], message: 'Topic is invalid' }],
        },
      },
    });

    const result = await service.syncForShop(SHOP_ID);

    // A silent success here would leave the shop never receiving orders.
    expect(result.created).toEqual([]);
    expect(result.failed).toEqual([{ topic: 'orders/create', reason: 'Topic is invalid' }]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SHOPIFY_WEBHOOKS_SYNC_PARTIAL', shopId: SHOP_ID }),
    );
  });

  it('one failing topic does not abandon the others', async () => {
    const dispatcher = new ShopifyWebhookDispatcher();
    dispatcher.register(handler('orders/create'));
    dispatcher.register(handler('app/uninstalled'));

    const queryForShop = vi.fn(async (_s: string, query: string, vars: Record<string, unknown>) => {
      if (query.includes('ExistingWebhooks')) {
        return { webhookSubscriptions: { edges: [] } };
      }
      if (vars.topic === 'ORDERS_CREATE') throw new Error('Shopify GraphQL throttled');
      return { webhookSubscriptionCreate: { webhookSubscription: { id: 'x' }, userErrors: [] } };
    });
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const service = new ShopifyWebhookRegistrationService(
      { queryForShop } as never,
      dispatcher,
      mockConfig(),
      audit as never,
    );

    const result = await service.syncForShop(SHOP_ID);

    expect(result.created).toEqual(['app/uninstalled']);
    expect(result.failed).toEqual([
      { topic: 'orders/create', reason: 'Shopify GraphQL throttled' },
    ]);
  });

  it('audits a clean sync so the subscribed set is provable after the fact', async () => {
    const { service, audit } = setup({ topics: ['orders/create'] });

    await service.syncForShop(SHOP_ID);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: SHOP_ID,
        actorKind: 'SYSTEM',
        action: 'SHOPIFY_WEBHOOKS_SYNCED',
        objectType: 'shop',
        after: expect.objectContaining({
          callback_url: CALLBACK,
          created: ['orders/create'],
          failed: [],
        }),
      }),
    );
  });
});
