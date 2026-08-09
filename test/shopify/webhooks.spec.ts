import { describe, expect, it, vi } from 'vitest';
import { ShopifyWebhookIngestService } from '../../src/modules/shopify/webhook-ingest.service';
import { ShopifyWebhookDispatcher } from '../../src/modules/shopify/webhook-dispatcher.service';
import { AppUninstalledHandler } from '../../src/modules/shopify/handlers/app-uninstalled.handler';
import { hmacSha256Base64 } from '../../src/common/crypto';
import { mockConfig, MockPool } from './helpers';

const SECRET = 'test_api_secret';
const DOMAIN = 'test-store.myshopify.com';
const RAW = Buffer.from(JSON.stringify({ id: 123456, note: 'x' }), 'utf8');

function validHmac(raw: Buffer): string {
  return hmacSha256Base64(SECRET, raw);
}

function baseInput(overrides: Partial<Parameters<ShopifyWebhookIngestService['ingest']>[0]> = {}) {
  return {
    rawBody: RAW,
    hmacHeader: validHmac(RAW),
    shopDomain: DOMAIN,
    topic: 'orders/create',
    webhookId: 'wh-evt-1',
    ...overrides,
  };
}

function setup(opts: { shopRow?: object | null; insertedRow?: object | null } = {}) {
  const { shopRow = { shop_id: 'shop-1' }, insertedRow = { inbox_id: 'inbox-1' } } = opts;
  const pool = new MockPool();
  pool
    .on(/SELECT shop_id FROM shop WHERE myshopify_domain/, shopRow ? [shopRow] : [])
    .on(/INSERT INTO webhook_inbox/, insertedRow ? [insertedRow] : []);
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const sessions = {
    create: vi.fn(),
    invalidateMember: vi.fn().mockResolvedValue(undefined),
    invalidateShop: vi.fn().mockResolvedValue(undefined),
    invalidateSession: vi.fn().mockResolvedValue(undefined),
  };
  const dispatcher = new ShopifyWebhookDispatcher();
  const service = new ShopifyWebhookIngestService(
    pool as never,
    mockConfig(),
    audit as never,
    dispatcher,
  );
  return { pool, audit, sessions, dispatcher, service };
}

describe('ShopifyWebhookIngestService (§8.1)', () => {
  it('fails closed when no raw body is available', async () => {
    const { service, pool } = setup();
    const result = await service.ingest(baseInput({ rawBody: undefined }));
    expect(result.status).toBe(500);
    expect(pool.matching(/INSERT INTO webhook_inbox/)).toHaveLength(0);
  });

  it('rejects a bad HMAC with 401, audits, and never processes', async () => {
    const { service, pool, audit } = setup();
    const result = await service.ingest(baseInput({ hmacHeader: validHmac(Buffer.from('tampered')) }));
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ status: 'HMAC_REJECTED' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SHOPIFY_WEBHOOK_HMAC_REJECTED' }),
    );
    expect(pool.matching(/INSERT INTO webhook_inbox/)).toHaveLength(0);
  });

  it('durably inserts RECEIVED before acking, then dispatches inline', async () => {
    const { service, pool, dispatcher } = setup();
    const handle = vi.fn().mockResolvedValue(undefined);
    dispatcher.register({ topic: 'orders/create', handle });
    const result = await service.ingest(baseInput());
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'RECEIVED', handled: true });

    const insert = pool.matching(/INSERT INTO webhook_inbox/)[0];
    expect(insert.params[0]).toBe('shop-1'); // INV-1 shop scoping
    expect(insert.params[1]).toBe('orders/create');
    expect(insert.params[2]).toBe('wh-evt-1');
    expect(insert.params[3]).toBe(RAW.toString('utf8'));
    expect(insert.sql).toContain('ON CONFLICT (shop_id, topic, external_id) DO NOTHING');

    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxId: 'inbox-1',
        shopId: 'shop-1',
        topic: 'orders/create',
        externalId: 'wh-evt-1',
        payload: { id: 123456, note: 'x' },
      }),
    );
    expect(pool.matching(/SET state = 'PROCESSED'/)).toHaveLength(1);
  });

  it('treats a unique-violation repeat as a no-op 200 (dedupe)', async () => {
    const { service, dispatcher } = setup({ insertedRow: null });
    const handle = vi.fn();
    dispatcher.register({ topic: 'orders/create', handle });
    const result = await service.ingest(baseInput());
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'DUPLICATE' });
    expect(handle).not.toHaveBeenCalled();
  });

  it('acks and audits webhooks for unknown shops without inserting', async () => {
    const { service, pool, audit } = setup({ shopRow: null });
    const result = await service.ingest(baseInput());
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'IGNORED_UNKNOWN_SHOP' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SHOPIFY_WEBHOOK_UNKNOWN_SHOP' }),
    );
    expect(pool.matching(/INSERT INTO webhook_inbox/)).toHaveLength(0);
  });

  it('leaves rows with no registered topic handler in RECEIVED for their owning module', async () => {
    const { service, pool } = setup();
    const result = await service.ingest(baseInput({ topic: 'orders/updated' }));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'RECEIVED', handled: false });
    expect(pool.matching(/SET state = 'PROCESSED'/)).toHaveLength(0);
    expect(pool.matching(/SET state = 'FAILED'/)).toHaveLength(0);
  });

  it('marks the row FAILED but still acks when a handler throws', async () => {
    const { service, pool, dispatcher } = setup();
    dispatcher.register({
      topic: 'orders/create',
      handle: () => Promise.reject(new Error('boom')),
    });
    const result = await service.ingest(baseInput());
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'RECEIVED', handled: false, processing: 'FAILED' });
    expect(pool.matching(/SET state = 'FAILED'/)).toHaveLength(1);
  });
});

describe('app/uninstalled handler (§5.5, §9.1.5)', () => {
  it('destroys the credential, marks UNINSTALLED, invalidates all shop sessions, audits', async () => {
    const { pool, audit, sessions, dispatcher, service } = setup();
    const trackTokens = { revokeAllForShop: vi.fn(async () => 1), revokeForShipment: vi.fn(async () => 1) };
    const handler = new AppUninstalledHandler(pool as never, dispatcher, sessions as never, audit as never, trackTokens as never);
    handler.onModuleInit();

    const result = await service.ingest(baseInput({ topic: 'app/uninstalled' }));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'RECEIVED', handled: true });

    const update = pool.matching(/UPDATE shop\s+SET account_state = 'UNINSTALLED'/)[0];
    expect(update.sql).toContain('shopify_access_token_encrypted = NULL');
    expect(update.sql).toContain('uninstalled_at = now()');
    expect(update.params).toEqual(['shop-1']);

    expect(sessions.invalidateShop).toHaveBeenCalledWith('shop-1', 'UNINSTALL');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SHOP_UNINSTALLED',
        objectType: 'shop',
        objectId: 'shop-1',
      }),
    );
    // durable inbox row marked processed
    expect(pool.matching(/SET state = 'PROCESSED'/)).toHaveLength(1);
  });
});
