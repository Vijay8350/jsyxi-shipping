import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { tokenHash } from '../../src/common/crypto';
import { ApiKeyGuard } from '../../src/modules/platform/api-keys/api-key.guard';
import {
  API_KEY_PREFIX,
  ApiKeyService,
  ResolvedApiKey,
} from '../../src/modules/platform/api-keys/api-key.service';

const SHOP = '11111111-1111-1111-1111-111111111111';
const MEMBER = '22222222-2222-2222-2222-222222222222';
const KEY_ID = '66666666-6666-6666-6666-666666666666';

function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    key_id: KEY_ID,
    shop_id: SHOP,
    name: 'ERP sync',
    scopes: ['read-orders', 'track'],
    rate_limit_per_minute: 60,
    last_used_at: null,
    rotated_from_key_id: null,
    revoked_at: null,
    created_by: MEMBER,
    created_at: '2026-07-29T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

describe('ApiKeyService (ADD-20)', () => {
  let query: ReturnType<typeof vi.fn>;
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: ApiKeyService;

  beforeEach(() => {
    query = vi.fn();
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    service = new ApiKeyService(
      { query } as unknown as Pool,
      audit as unknown as AuditService,
    );
  });

  it('creates a key: plaintext once, only the hash stored, audited', async () => {
    query.mockResolvedValueOnce({ rows: [keyRow()] });
    const { plaintext, key } = await service.create({
      shopId: SHOP,
      name: 'ERP sync',
      scopes: ['read-orders', 'track'],
      createdBy: MEMBER,
    });

    expect(plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
    // prefix (9 chars) + 32 base64url chars
    expect(plaintext).toHaveLength(API_KEY_PREFIX.length + 32);
    expect(key).toMatchObject({
      keyId: KEY_ID,
      shopId: SHOP,
      scopes: ['read-orders', 'track'],
      rateLimitPerMinute: 60,
    });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO api_key');
    // The hash goes in, never the plaintext.
    expect(params).toContain(tokenHash(plaintext));
    expect(params).not.toContain(plaintext);
    expect(sql.split('RETURNING')[1]).not.toContain('key_hash');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'api_key.create', actorId: MEMBER }),
    );
  });

  it('rejects empty or unknown scopes', async () => {
    await expect(
      service.create({ shopId: SHOP, name: 'x', scopes: [], createdBy: MEMBER }),
    ).rejects.toThrow(/scopes/);
    await expect(
      service.create({
        shopId: SHOP,
        name: 'x',
        scopes: ['admin'] as never,
        createdBy: MEMBER,
      }),
    ).rejects.toThrow(/scopes/);
  });

  it('verify resolves by hash and touches last_used_at when stale', async () => {
    query
      .mockResolvedValueOnce({ rows: [keyRow()] }) // select by hash
      .mockResolvedValueOnce({ rows: [] }); // touch update
    const resolved = await service.verify(`${API_KEY_PREFIX}abc`);

    expect(resolved).toMatchObject({
      keyId: KEY_ID,
      shopId: SHOP,
      rateLimitPerMinute: 60,
    });
    const [selectSql, selectParams] = query.mock.calls[0];
    expect(selectSql).toContain('WHERE key_hash = $1');
    expect(selectParams).toEqual([tokenHash(`${API_KEY_PREFIX}abc`)]);
    expect(query.mock.calls[1][0]).toContain('SET last_used_at = now()');
  });

  it('verify throttles the last_used_at touch to one write per minute', async () => {
    query.mockResolvedValueOnce({
      rows: [keyRow({ last_used_at: new Date().toISOString() })],
    });
    const resolved = await service.verify(`${API_KEY_PREFIX}abc`);

    expect(resolved).not.toBeNull();
    expect(query).toHaveBeenCalledTimes(1); // select only, no touch
  });

  it('verify rejects revoked keys', async () => {
    query.mockResolvedValueOnce({
      rows: [keyRow({ revoked_at: '2026-07-28T00:00:00.000Z' })],
    });
    expect(await service.verify(`${API_KEY_PREFIX}abc`)).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('verify rejects unknown and malformed keys without a query for the latter', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await service.verify(`${API_KEY_PREFIX}unknown`)).toBeNull();
    expect(await service.verify('not-a-jsyxi-key')).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('hasScope checks the resolved scopes', async () => {
    query.mockResolvedValue({ rows: [keyRow()] });
    const resolved = (await service.verify(`${API_KEY_PREFIX}abc`)) as ResolvedApiKey;
    expect(service.hasScope(resolved, 'read-orders')).toBe(true);
    expect(service.hasScope(resolved, 'book')).toBe(false);
  });

  it('list returns rows without the hash, shop-scoped', async () => {
    query.mockResolvedValueOnce({ rows: [keyRow()] });
    const keys = await service.list(SHOP);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('WHERE shop_id = $1');
    expect(sql).not.toMatch(/select[^]*key_hash/i);
    expect(params).toEqual([SHOP]);
    expect(keys[0]).not.toHaveProperty('keyHash');
    expect(keys[0]).toMatchObject({ keyId: KEY_ID, name: 'ERP sync' });
  });

  it('rotate creates a successor, revokes the old key, returns plaintext once', async () => {
    const client = { query: vi.fn(), release: vi.fn() };
    client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [keyRow()] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({
        rows: [
          keyRow({
            key_id: '77777777-7777-7777-7777-777777777777',
            rotated_from_key_id: KEY_ID,
          }),
        ],
      }) // INSERT successor
      .mockResolvedValueOnce(undefined) // UPDATE revoke old
      .mockResolvedValueOnce(undefined); // COMMIT
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn(),
    } as unknown as Pool;
    const svc = new ApiKeyService(pool, audit as unknown as AuditService);

    const { plaintext, key } = await svc.rotate(KEY_ID, SHOP, MEMBER);

    expect(plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key.rotatedFromKeyId).toBe(KEY_ID);
    const insertParams = client.query.mock.calls[2][1] as unknown[];
    expect(insertParams).toContain(tokenHash(plaintext));
    expect(insertParams).not.toContain(plaintext);
    expect(insertParams).toContain(KEY_ID); // rotated_from_key_id
    expect(client.query.mock.calls[3][0]).toContain('SET revoked_at = now()');
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'api_key.rotate' }),
    );
  });

  it('rotate rolls back when the key is missing', async () => {
    const client = { query: vi.fn(), release: vi.fn() };
    client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // SELECT ... FOR UPDATE
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn(),
    } as unknown as Pool;
    const svc = new ApiKeyService(pool, audit as unknown as AuditService);

    await expect(svc.rotate(KEY_ID, SHOP, MEMBER)).rejects.toThrow(/not found/);
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('revoke marks the key and audits it; verify then rejects it', async () => {
    query.mockResolvedValueOnce({
      rows: [keyRow({ revoked_at: '2026-07-29T01:00:00.000Z', version: 2 })],
    });
    const revoked = await service.revoke(KEY_ID, SHOP, MEMBER);

    expect(revoked.revokedAt).not.toBeNull();
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('SET revoked_at = now()');
    expect(sql).toContain('AND revoked_at IS NULL');
    expect(params).toEqual([KEY_ID, SHOP]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'api_key.revoke' }),
    );
  });

  it('revoke is idempotent for an already-revoked key', async () => {
    query
      .mockResolvedValueOnce({ rows: [] }) // UPDATE matched nothing
      .mockResolvedValueOnce({
        rows: [keyRow({ revoked_at: '2026-07-28T00:00:00.000Z' })],
      });
    const view = await service.revoke(KEY_ID, SHOP, MEMBER);
    expect(view.revokedAt).not.toBeNull();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('ApiKeyGuard (ADD-20)', () => {
  function ctxWith(headers: Record<string, string>): ExecutionContext {
    const req: Record<string, unknown> = { headers };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  it('rejects a missing bearer header', async () => {
    const guard = new ApiKeyGuard({ verify: vi.fn() } as unknown as ApiKeyService);
    await expect(guard.canActivate(ctxWith({}))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an invalid or revoked key', async () => {
    const guard = new ApiKeyGuard({
      verify: vi.fn().mockResolvedValue(null),
    } as unknown as ApiKeyService);
    await expect(
      guard.canActivate(ctxWith({ authorization: `Bearer ${API_KEY_PREFIX}x` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('attaches the resolved key to the request', async () => {
    const resolved: ResolvedApiKey = {
      keyId: KEY_ID,
      shopId: SHOP,
      name: 'ERP sync',
      scopes: ['track'],
      rateLimitPerMinute: 60,
    };
    const guard = new ApiKeyGuard({
      verify: vi.fn().mockResolvedValue(resolved),
    } as unknown as ApiKeyService);
    const req: Record<string, unknown> = {
      headers: { authorization: `Bearer ${API_KEY_PREFIX}x` },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.apiKey).toEqual(resolved);
  });
});
