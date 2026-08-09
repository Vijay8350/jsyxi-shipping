import { describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { MAGIC_LINK_TTL_MINUTES } from '../../src/modules/native-auth/native-auth.constants';
import { makeHarness, MEMBER_ID, SHOP_ID } from './helpers';

describe('magic link (single-use, OVR-1)', () => {
  it('issues a hashed 15-minute token for a known native member and audits it', async () => {
    const h = makeHarness((sql, params) => {
      if (sql.includes('FROM shop WHERE')) return { rows: [{ shop_id: SHOP_ID }], rowCount: 1 };
      if (sql.includes('SELECT member_id FROM shop_member')) {
        return { rows: [{ member_id: MEMBER_ID }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO magic_link_token')) {
        expect(params[0]).toBe(SHOP_ID);
        expect(params[1]).toBe(MEMBER_ID);
        expect(params[3]).toBe(String(MAGIC_LINK_TTL_MINUTES));
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const { devHandoffToken } = await h.service.requestMagicLink(
      { email: 'm@example.com', shopId: SHOP_ID },
      'ip-hash',
    );
    expect(devHandoffToken).toBeTruthy();

    const insert = h.pool.query.mock.calls.find((c) =>
      (c[0] as string).includes('INSERT INTO magic_link_token'),
    );
    // plaintext token is never stored — only its hash
    expect((insert![1] as unknown[])[2]).not.toBe(devHandoffToken);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'native_magic_link.requested', actorId: MEMBER_ID }),
    );
    expect(JSON.stringify(h.audit.record.mock.calls)).not.toContain('m@example.com');
  });

  it('returns the same shape for unknown emails and unknown shops (no enumeration)', async () => {
    const h = makeHarness((sql) => {
      if (sql.includes('FROM shop WHERE')) return { rows: [{ shop_id: SHOP_ID }], rowCount: 1 };
      return { rows: [], rowCount: 0 }; // member lookup misses
    });
    const res = await h.service.requestMagicLink({ email: 'ghost@example.com', shopId: SHOP_ID }, null);
    expect(res).toEqual({ devHandoffToken: null });
    expect(
      h.pool.query.mock.calls.some((c) => (c[0] as string).includes('INSERT INTO magic_link_token')),
    ).toBe(false);

    const h2 = makeHarness(() => ({ rows: [], rowCount: 0 })); // shop lookup misses
    const res2 = await h2.service.requestMagicLink({ email: 'm@example.com', shopId: SHOP_ID }, null);
    expect(res2).toEqual({ devHandoffToken: null });
  });

  it('consume creates a session and audits a native login; a second consume is rejected', async () => {
    let claimed = false;
    const h = makeHarness((sql) => {
      if (sql.includes('UPDATE magic_link_token')) {
        // first claim succeeds; the atomic UPDATE matches no row afterwards
        if (claimed) return { rows: [], rowCount: 0 };
        claimed = true;
        return {
          rows: [{ token_id: 'tok-1', shop_id: SHOP_ID, member_id: MEMBER_ID }],
          rowCount: 1,
        };
      }
      if (sql.includes('SELECT role FROM shop_member')) {
        return { rows: [{ role: 'VIEWER' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const first = await h.service.consumeMagicLink('plain-token', 'ip-hash');
    expect(first.sessionToken).toBe('sess-token');
    expect(h.sessions.create).toHaveBeenCalledTimes(1);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'native_login.success',
        actorId: MEMBER_ID,
        after: { method: 'magic_link' },
      }),
    );

    await expect(h.service.consumeMagicLink('plain-token', 'ip-hash')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(h.sessions.create).toHaveBeenCalledTimes(1); // no second session
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'native_login.failure', reason: 'magic_link_invalid' }),
    );
  });

  it('consume refuses a token whose member was revoked in between', async () => {
    const h = makeHarness((sql) => {
      if (sql.includes('UPDATE magic_link_token')) {
        return { rows: [{ token_id: 'tok-1', shop_id: SHOP_ID, member_id: MEMBER_ID }], rowCount: 1 };
      }
      if (sql.includes('SELECT role FROM shop_member')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    await expect(h.service.consumeMagicLink('plain-token', null)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(h.sessions.create).not.toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'native_login.failure', reason: 'member_revoked' }),
    );
  });
});
