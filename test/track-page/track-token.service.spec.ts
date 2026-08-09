import { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenHash } from '../../src/common/crypto';
import { TrackTokenService } from '../../src/modules/track-page/track-token.service';
import { APP_URL, SHOP, fakeConfig, shipmentRow } from './helpers';

const SHIPMENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('TrackTokenService (§9.16 path 1, A1-07/A2-12)', () => {
  let query: ReturnType<typeof vi.fn>;
  let service: TrackTokenService;

  beforeEach(() => {
    query = vi.fn();
    service = new TrackTokenService(
      { query } as unknown as Pool,
      fakeConfig() as never,
    );
  });

  it('issue stores only the token hash and returns the full link', async () => {
    query.mockResolvedValueOnce({ rows: [{ token_id: 'tid-1' }] });

    const link = await service.issue(SHOP, SHIPMENT);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO track_token');
    expect(params[0]).toBe(SHOP);
    expect(params[1]).toBe(SHIPMENT);
    // ≥128-bit token: base64url of 32 bytes, stored as sha256 hex only.
    expect(params[2]).toMatch(/^[0-9a-f]{64}$/);
    const token = link.url.split('/track/t/')[1];
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(link.url).toBe(`${APP_URL}/track/t/${token}`);
    // The raw token never touches the database params.
    expect(JSON.stringify(params)).not.toContain(token);
    expect(params[2]).toBe(tokenHash(token));
  });

  it('resolve returns the shipment for a live token', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          token_id: 'tid-1',
          revoked_at: null,
          account_state: 'ACTIVE',
          ...shipmentRow(),
        },
      ],
    });

    const resolved = await service.resolve('raw-token');

    expect(resolved?.tokenId).toBe('tid-1');
    expect(resolved?.shipment.shipment_id).toBe(SHIPMENT);
    // Looked up by hash, never by raw token (A1-07).
    expect(query.mock.calls[0][1]).toEqual([tokenHash('raw-token')]);
  });

  it('resolve rejects a revoked token (§5.5)', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          token_id: 'tid-1',
          revoked_at: '2026-08-01T00:00:00Z',
          account_state: 'ACTIVE',
          ...shipmentRow(),
        },
      ],
    });
    expect(await service.resolve('raw-token')).toBeNull();
  });

  it('resolve rejects a token whose shop is UNINSTALLED (§9.16)', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          token_id: 'tid-1',
          revoked_at: null,
          account_state: 'UNINSTALLED',
          ...shipmentRow(),
        },
      ],
    });
    expect(await service.resolve('raw-token')).toBeNull();
  });

  it('resolve returns null for an unknown token', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await service.resolve('nope')).toBeNull();
  });

  it('revokeForShipment revokes only that shipment’s live tokens', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    const count = await service.revokeForShipment(SHOP, SHIPMENT);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('UPDATE track_token SET revoked_at = now()');
    expect(sql).toContain('shipment_id = $2');
    expect(sql).toContain('revoked_at IS NULL');
    expect(params).toEqual([SHOP, SHIPMENT]);
    expect(count).toBe(2);
  });

  it('revokeAllForShop revokes every live token (uninstall scope, §5.5)', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 17 });
    const count = await service.revokeAllForShop(SHOP);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('UPDATE track_token SET revoked_at = now()');
    expect(sql).not.toContain('shipment_id');
    expect(params).toEqual([SHOP]);
    expect(count).toBe(17);
  });
});
