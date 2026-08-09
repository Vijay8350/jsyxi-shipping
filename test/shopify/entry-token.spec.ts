import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENTRY_TOKEN_TTL_SECONDS,
  EntryTokenError,
  EntryTokenService,
} from '../../src/modules/shopify/entry-token.service';
import { createMockRedis, mockConfig } from './helpers';

function setup() {
  const redis = createMockRedis();
  const service = new EntryTokenService(redis as never, mockConfig());
  return { redis, service };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('EntryTokenService (§9.1.1, §5.7 control 6)', () => {
  it('issues and verifies a token round-trip', async () => {
    const { service } = setup();
    const { token, expiresInSeconds } = await service.issue('gid://shopify/Shop/1', '777');
    expect(expiresInSeconds).toBe(ENTRY_TOKEN_TTL_SECONDS);
    const payload = await service.verify(token);
    expect(payload.sg).toBe('gid://shopify/Shop/1');
    expect(payload.su).toBe('777');
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects a tampered signature', async () => {
    const { service } = setup();
    const { token } = await service.issue('gid://shopify/Shop/1', '777');
    const dot = token.lastIndexOf('.');
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const bad = `${body}.${sig.endsWith('0') ? sig.slice(0, -1) + '1' : sig.slice(0, -1) + '0'}`;
    await expect(service.verify(bad)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
  });

  it('rejects a tampered payload', async () => {
    const { service } = setup();
    const { token } = await service.issue('gid://shopify/Shop/1', '777');
    const forged = Buffer.from(
      JSON.stringify({ sg: 'gid://shopify/Shop/1', su: '999', exp: 9999999999, nonce: 'x' }),
      'utf8',
    ).toString('base64url');
    const dot = token.lastIndexOf('.');
    await expect(service.verify(`${forged}.${token.slice(dot + 1)}`)).rejects.toMatchObject({
      code: 'BAD_SIGNATURE',
    });
  });

  it('rejects malformed tokens', async () => {
    const { service } = setup();
    await expect(service.verify('no-dot-here')).rejects.toMatchObject({ code: 'MALFORMED' });
    await expect(service.verify('.sig')).rejects.toMatchObject({ code: 'MALFORMED' });
  });

  it('rejects an expired token', async () => {
    vi.useFakeTimers();
    const { service } = setup();
    const { token } = await service.issue('gid://shopify/Shop/1', '777');
    vi.setSystemTime(Date.now() + (ENTRY_TOKEN_TTL_SECONDS + 1) * 1000);
    await expect(service.verify(token)).rejects.toMatchObject({ code: 'EXPIRED' });
  });

  it('consumes the nonce on first use — a replay is rejected', async () => {
    const { service } = setup();
    const { token } = await service.issue('gid://shopify/Shop/1', '777');
    await service.verify(token);
    await expect(service.verify(token)).rejects.toMatchObject({ code: 'REPLAYED' });
  });

  it('rejects a token whose nonce lapsed with its TTL', async () => {
    vi.useFakeTimers();
    const { service } = setup();
    const { token } = await service.issue('gid://shopify/Shop/1', '777');
    vi.setSystemTime(Date.now() + (ENTRY_TOKEN_TTL_SECONDS - 10) * 1000);
    await service.verify(token); // still valid
    await expect(service.verify(token)).rejects.toMatchObject({ code: 'REPLAYED' });
  });

  it('throws EntryTokenError instances', async () => {
    const { service } = setup();
    await expect(service.verify('x')).rejects.toBeInstanceOf(EntryTokenError);
  });
});
