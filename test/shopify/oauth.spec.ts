import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCallbackMessage,
  ShopifyOAuthError,
  ShopifyOAuthService,
  resolveStaffIdentity,
} from '../../src/modules/shopify/oauth.service';
import { EntryTokenService } from '../../src/modules/shopify/entry-token.service';
import { hmacSha256Hex } from '../../src/common/crypto';
import {
  createMockRedis,
  jsonResponse,
  mockConfig,
  MockPool,
  stubFetch,
  TEST_MASTER_KEY_HEX,
} from './helpers';

const SECRET = 'test_api_secret';
const DOMAIN = 'test-store.myshopify.com';
const SHOP_GID = 'gid://shopify/Shop/12345';

function signedQuery(params: Record<string, string>): Record<string, string> {
  return { ...params, hmac: hmacSha256Hex(SECRET, buildCallbackMessage(params)) };
}

const SHOP_INFO = {
  data: {
    shop: {
      id: SHOP_GID,
      myshopifyDomain: DOMAIN,
      ianaTimezone: 'Asia/Kolkata',
      currencyCode: 'INR',
    },
  },
};

const TOKEN_RESPONSE = {
  access_token: 'shpat_test_token',
  scope: 'read_orders,write_orders',
  associated_user_scope: 'read_orders',
  associated_user: { id: 777, first_name: 'A', last_name: 'B', email: 'a@b.c' },
};

function setup(opts: { currency?: string; withUser?: boolean; memberCount?: number } = {}) {
  const { currency = 'INR', withUser = true, memberCount = 0 } = opts;
  const pool = new MockPool();
  const redis = createMockRedis();
  const config = mockConfig();
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const entryTokens = new EntryTokenService(redis as never, config);
  const graphql = {
    queryWithToken: vi.fn().mockResolvedValue({
      shop: { ...SHOP_INFO.data.shop, currencyCode: currency },
    }),
    queryForShop: vi.fn(),
  };
  const tokenResp = withUser
    ? TOKEN_RESPONSE
    : { access_token: 'shpat_test_token', scope: 'read_orders' };
  stubFetch(vi.fn().mockResolvedValue(jsonResponse(tokenResp)));

  pool
    .on(/INSERT INTO shop\b/, [{ shop_id: 'shop-1' }])
    .on(/INSERT INTO store_settings/, [])
    .on(/SELECT member_id FROM shop_member/, [])
    .on(/count\(\*\)::int AS n FROM shop_member/, [{ n: memberCount }])
    .on(/INSERT INTO shop_member/, [{ member_id: 'member-1' }]);

  const service = new ShopifyOAuthService(
    pool as never,
    redis as never,
    config,
    entryTokens,
    audit as never,
    graphql as never,
  );
  return { pool, redis, config, audit, entryTokens, graphql, service };
}

async function beginAndGetState(service: ShopifyOAuthService): Promise<string> {
  const url = await service.beginInstall(DOMAIN);
  const state = new URL(url).searchParams.get('state');
  expect(state).toBeTruthy();
  return state!;
}

afterEach(() => vi.unstubAllGlobals());

describe('ShopifyOAuthService.beginInstall (§9.1.1)', () => {
  it('rejects an invalid shop domain', async () => {
    const { service } = setup();
    await expect(service.beginInstall('evil.com')).rejects.toMatchObject({
      code: 'INVALID_SHOP_DOMAIN',
    });
    await expect(service.beginInstall('')).rejects.toMatchObject({
      code: 'INVALID_SHOP_DOMAIN',
    });
  });

  it('stores a state nonce in Redis and builds the authorize URL', async () => {
    const { service, redis } = setup();
    const url = await service.beginInstall(DOMAIN);
    const parsed = new URL(url);
    expect(parsed.hostname).toBe(DOMAIN);
    expect(parsed.pathname).toBe('/admin/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('test_api_key');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://app.jsyxi.test/shopify/callback',
    );
    expect(parsed.searchParams.get('grant_options[]')).toBe('per-user');
    const state = parsed.searchParams.get('state')!;
    // nonce stored, bound to the domain, 10-minute TTL
    expect(redis.store.get(`shopify:oauth_state:${state}`)?.value).toBe(DOMAIN);
  });
});

describe('ShopifyOAuthService.handleCallback (§9.1.1, INV-2)', () => {
  it('rejects a bad HMAC before anything else happens', async () => {
    const { service, pool } = setup();
    const state = await beginAndGetState(service);
    const query = signedQuery({ code: 'c', shop: DOMAIN, state, timestamp: '1' });
    query.hmac = query.hmac.replace(/.$/, query.hmac.endsWith('0') ? '1' : '0');
    await expect(service.handleCallback(query)).rejects.toMatchObject({ code: 'BAD_HMAC' });
    expect(pool.calls).toHaveLength(0);
  });

  it('consumes the state nonce exactly once (single use)', async () => {
    const { service } = setup();
    const state = await beginAndGetState(service);
    const query = signedQuery({ code: 'c', shop: DOMAIN, state, timestamp: '1' });
    await service.handleCallback(query); // first use succeeds
    await expect(service.handleCallback(query)).rejects.toMatchObject({ code: 'BAD_STATE' });
  });

  it('rejects a state nonce bound to a different shop', async () => {
    const { service } = setup();
    const state = await beginAndGetState(service);
    const query = signedQuery({ code: 'c', shop: 'other-store.myshopify.com', state, timestamp: '1' });
    await expect(service.handleCallback(query)).rejects.toMatchObject({ code: 'BAD_STATE' });
  });

  it('blocks onboarding when the shop currency is not INR and persists nothing (INV-2)', async () => {
    const { service, pool, audit } = setup({ currency: 'USD' });
    const state = await beginAndGetState(service);
    const query = signedQuery({ code: 'c', shop: DOMAIN, state, timestamp: '1' });
    await expect(service.handleCallback(query)).rejects.toMatchObject({
      code: 'CURRENCY_NOT_INR',
    });
    expect(pool.matching(/INSERT INTO shop\b/)).toHaveLength(0);
    expect(pool.matching(/INSERT INTO store_settings/)).toHaveLength(0);
    expect(pool.matching(/INSERT INTO shop_member/)).toHaveLength(0);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SHOP_INSTALL_BLOCKED' }),
    );
  });

  it('upserts the shop with an envelope-encrypted token, seeds settings, creates Owner, mints an entry token', async () => {
    const { service, pool, audit, entryTokens } = setup();
    const state = await beginAndGetState(service);
    const query = signedQuery({ code: 'c', shop: DOMAIN, state, timestamp: '1' });
    const result = await service.handleCallback(query);

    // shop upsert: gid, domain, tz, encrypted token (Buffer, not plaintext)
    const shopInsert = pool.matching(/INSERT INTO shop\b/)[0];
    expect(shopInsert.params[0]).toBe(SHOP_GID);
    expect(shopInsert.params[1]).toBe(DOMAIN);
    expect(shopInsert.params[2]).toBe('Asia/Kolkata');
    expect(Buffer.isBuffer(shopInsert.params[3])).toBe(true);
    expect((shopInsert.params[3] as Buffer).toString('utf8')).not.toContain('shpat_test_token');

    // store_settings seeded, shop-scoped (INV-1)
    const settings = pool.matching(/INSERT INTO store_settings/)[0];
    expect(settings.params[0]).toBe('shop-1');

    // first member becomes OWNER with SHOPIFY_STAFF auth source (§9.1.2, OVR-1)
    const member = pool.matching(/INSERT INTO shop_member/)[0];
    expect(member.params).toEqual(['shop-1', '777']);
    expect(member.sql).toContain("'SHOPIFY_STAFF'");
    expect(member.sql).toContain("'OWNER'");
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MEMBER_ROLE_GRANTED' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SHOP_INSTALLED' }),
    );

    // the returned entry token verifies and names this shop + staff user
    const payload = await entryTokens.verify(result.entryToken);
    expect(payload.sg).toBe(SHOP_GID);
    expect(payload.su).toBe('777');
    expect(result.expiresInSeconds).toBe(300);
  });

  it('creates no member row for a non-first staff user (deny-by-default, §9.1.2)', async () => {
    const { service, pool, entryTokens } = setup({ memberCount: 1 });
    const state = await beginAndGetState(service);
    const query = signedQuery({ code: 'c', shop: DOMAIN, state, timestamp: '1' });
    const result = await service.handleCallback(query);
    expect(pool.matching(/INSERT INTO shop_member/)).toHaveLength(0);
    // entry token is still minted; the exchange decides NO_ACCESS
    const payload = await entryTokens.verify(result.entryToken);
    expect(payload.su).toBe('777');
  });

  it('persists the shop but denies entry when associated_user is absent (§9.1.2, no shop-level fallback)', async () => {
    const { service, pool, audit } = setup({ withUser: false });
    const state = await beginAndGetState(service);
    const query = signedQuery({ code: 'c', shop: DOMAIN, state, timestamp: '1' });
    await expect(service.handleCallback(query)).rejects.toMatchObject({
      code: 'STAFF_IDENTITY_UNAVAILABLE',
    });
    // shop row persisted…
    expect(pool.matching(/INSERT INTO shop\b/)).toHaveLength(1);
    // …but no member and a clear audit trail to escalate
    expect(pool.matching(/INSERT INTO shop_member/)).toHaveLength(0);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STAFF_IDENTITY_UNAVAILABLE' }),
    );
  });
});

describe('resolveStaffIdentity (§9.1.2)', () => {
  it('reads associated_user.id and rejects its absence', () => {
    expect(resolveStaffIdentity(TOKEN_RESPONSE)).toEqual({ staffUserId: '777' });
    expect(resolveStaffIdentity({ access_token: 'x', scope: 'y' })).toBeNull();
  });
});
