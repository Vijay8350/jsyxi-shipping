import { describe, expect, it, vi } from 'vitest';
import { ShopifyEntryService } from '../../src/modules/shopify/entry.service';
import { EntryTokenService } from '../../src/modules/shopify/entry-token.service';
import { createMockRedis, mockConfig, MockPool } from './helpers';

const SHOP_GID = 'gid://shopify/Shop/12345';
const STAFF_ID = '777';

const SHOP_ROW = {
  shop_id: 'shop-1',
  account_state: 'TRIALING',
  myshopify_domain: 'test-store.myshopify.com',
};
const MEMBER_ROW = {
  member_id: 'member-1',
  role: 'OWNER',
  auth_source: 'SHOPIFY_STAFF',
  revoked_at: null,
};

function setup(opts: {
  shopRow?: object | null;
  memberRow?: object | null;
  pendingRequest?: boolean;
  staffCheck?: 'FOUND' | 'GONE' | 'THROWS';
  staffCacheWarm?: boolean;
} = {}) {
  const {
    shopRow = SHOP_ROW,
    memberRow = MEMBER_ROW,
    pendingRequest = false,
    staffCheck = 'FOUND',
    staffCacheWarm = false,
  } = opts;
  const pool = new MockPool();
  pool
    .on(/FROM shop WHERE shopify_shop_gid/, shopRow ? [shopRow] : [])
    .on(/FROM shop_member\s+WHERE shop_id/, memberRow ? [memberRow] : [])
    .on(/FROM access_request/, pendingRequest ? [{ x: 1 }] : []);
  const redis = createMockRedis();
  const config = mockConfig();
  const entryTokens = new EntryTokenService(redis as never, config);
  const sessions = {
    create: vi.fn((input: { shopId: string; memberId: string; role: string; authSource: string; ipHash?: string | null }) =>
      Promise.resolve({
        token: 'sess-token',
        context: {
          sessionId: 'sess-1',
          shopId: input.shopId,
          memberId: input.memberId,
          role: input.role,
          authSource: input.authSource,
        },
      }),
    ),
    invalidateMember: vi.fn().mockResolvedValue(undefined),
    invalidateShop: vi.fn().mockResolvedValue(undefined),
    invalidateSession: vi.fn().mockResolvedValue(undefined),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const graphql = {
    queryWithToken: vi.fn(),
    queryForShop: vi.fn(() => {
      if (staffCheck === 'THROWS') return Promise.reject(new Error('shopify down'));
      return Promise.resolve({ user: staffCheck === 'FOUND' ? { id: `gid://shopify/User/${STAFF_ID}` } : null });
    }),
  };
  const service = new ShopifyEntryService(
    pool as never,
    redis as never,
    config,
    entryTokens,
    sessions as never,
    audit as never,
    graphql as never,
  );
  if (staffCacheWarm) {
    redis.store.set(`shopify:staff_valid:shop-1:${STAFF_ID}`, { value: '1' });
  }
  return { pool, redis, entryTokens, sessions, audit, graphql, service };
}

async function mintToken(entryTokens: EntryTokenService): Promise<string> {
  const { token } = await entryTokens.issue(SHOP_GID, STAFF_ID);
  return token;
}

describe('ShopifyEntryService.exchange (§9.1.1, §9.1.2)', () => {
  it('denies by default when no shop_member row exists, exposing access-request status', async () => {
    const { service, entryTokens, sessions } = setup({ memberRow: null, pendingRequest: false });
    const result = await service.exchange(await mintToken(entryTokens), '1.2.3.4');
    expect(result).toEqual({ status: 'NO_ACCESS', reason: 'NO_MEMBER', accessRequest: 'NONE' });
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('reports a PENDING access request when one exists', async () => {
    const { service, entryTokens } = setup({ memberRow: null, pendingRequest: true });
    const result = await service.exchange(await mintToken(entryTokens), null);
    expect(result).toEqual({ status: 'NO_ACCESS', reason: 'NO_MEMBER', accessRequest: 'PENDING' });
  });

  it('denies a revoked member row without calling Shopify', async () => {
    const { service, entryTokens, graphql, sessions } = setup({
      memberRow: { ...MEMBER_ROW, revoked_at: new Date() },
    });
    const result = await service.exchange(await mintToken(entryTokens), null);
    expect(result.status).toBe('NO_ACCESS');
    expect((result as { reason: string }).reason).toBe('MEMBER_REVOKED');
    expect(graphql.queryForShop).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('denies entry to an uninstalled shop', async () => {
    const { service, entryTokens } = setup({
      shopRow: { ...SHOP_ROW, account_state: 'UNINSTALLED' },
    });
    const result = await service.exchange(await mintToken(entryTokens), null);
    expect((result as { reason: string }).reason).toBe('SHOP_UNINSTALLED');
  });

  it('creates a session on success (SHOPIFY_STAFF, staff check passes)', async () => {
    const { service, entryTokens, sessions, pool, redis } = setup();
    const result = await service.exchange(await mintToken(entryTokens), '1.2.3.4');
    expect(result.status).toBe('OK');
    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: 'shop-1',
        memberId: 'member-1',
        role: 'OWNER',
        authSource: 'SHOPIFY_STAFF',
      }),
    );
    // ip stored only as a salted hash (§5.7 control 4)
    const ipHash = sessions.create.mock.calls[0][0].ipHash as string;
    expect(ipHash).toBeTruthy();
    expect(ipHash).not.toContain('1.2.3.4');
    // positive staff check cached for 15 minutes (fail-open window)
    expect(redis.store.has(`shopify:staff_valid:shop-1:${STAFF_ID}`)).toBe(true);
    // last_active_at touched, shop-scoped (INV-1)
    expect(pool.matching(/UPDATE shop_member SET last_active_at/)[0].params).toEqual([
      'shop-1',
      'member-1',
    ]);
  });

  it('revokes member + invalidates sessions + audits when Shopify says the staff user is gone (§9.1.2)', async () => {
    const { service, entryTokens, sessions, audit, pool } = setup({ staffCheck: 'GONE' });
    const result = await service.exchange(await mintToken(entryTokens), null);
    expect(result).toEqual({
      status: 'NO_ACCESS',
      reason: 'STAFF_REVOKED_IN_SHOPIFY',
      accessRequest: 'NONE',
    });
    expect(pool.matching(/UPDATE shop_member SET revoked_at = now\(\)/)[0].params).toEqual([
      'shop-1',
      'member-1',
    ]);
    expect(sessions.invalidateMember).toHaveBeenCalledWith('member-1', 'SHOPIFY_ACCESS_REVOKED');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'MEMBER_ACCESS_REVOKED',
        objectType: 'shop_member',
        objectId: 'member-1',
      }),
    );
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('fails open when Shopify is unreachable — an outage never locks a merchant out', async () => {
    const { service, entryTokens, sessions } = setup({ staffCheck: 'THROWS' });
    const result = await service.exchange(await mintToken(entryTokens), null);
    expect(result.status).toBe('OK');
    expect(sessions.create).toHaveBeenCalled();
  });

  it('skips the Shopify call entirely while the positive cache is warm', async () => {
    const { service, entryTokens, graphql } = setup({ staffCacheWarm: true, staffCheck: 'GONE' });
    const result = await service.exchange(await mintToken(entryTokens), null);
    expect(result.status).toBe('OK');
    expect(graphql.queryForShop).not.toHaveBeenCalled();
  });

  it('does not re-validate NATIVE members against Shopify (OVR-1)', async () => {
    const { service, entryTokens, graphql } = setup({
      memberRow: { ...MEMBER_ROW, role: 'OPERATOR', auth_source: 'NATIVE' },
      staffCheck: 'GONE',
    });
    const result = await service.exchange(await mintToken(entryTokens), null);
    expect(result.status).toBe('OK');
    expect(graphql.queryForShop).not.toHaveBeenCalled();
  });
});
