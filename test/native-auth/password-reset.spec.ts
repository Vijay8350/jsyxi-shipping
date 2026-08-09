import { describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { PASSWORD_RESET_TTL_HOURS } from '../../src/modules/native-auth/native-auth.constants';
import { makeHarness, makeSession, MEMBER_ID, SHOP_ID } from './helpers';

const NEW_PASSWORD = 'a-brand-new-password';

describe('password reset (OVR-1 + RW-04)', () => {
  it('stores a hashed 1h token on the credential and audits the request', async () => {
    const h = makeHarness((sql, params) => {
      if (sql.includes('FROM shop WHERE')) return { rows: [{ shop_id: SHOP_ID }], rowCount: 1 };
      if (sql.includes('SELECT member_id FROM shop_member')) {
        return { rows: [{ member_id: MEMBER_ID }], rowCount: 1 };
      }
      if (sql.includes('password_reset_token_hash = $2')) {
        expect(params[0]).toBe(MEMBER_ID);
        expect(params[2]).toBe(String(PASSWORD_RESET_TTL_HOURS));
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const { devHandoffToken } = await h.service.requestPasswordReset(
      { email: 'm@example.com', shopId: SHOP_ID },
      null,
    );
    expect(devHandoffToken).toBeTruthy();
    const update = h.pool.query.mock.calls.find((c) =>
      (c[0] as string).includes('password_reset_token_hash = $2'),
    );
    expect((update![1] as unknown[])[1]).not.toBe(devHandoffToken); // hashed only
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'native_password_reset.requested', actorId: MEMBER_ID }),
    );
  });

  it('unknown email gets the same response shape and writes nothing', async () => {
    const h = makeHarness((sql) => {
      if (sql.includes('FROM shop WHERE')) return { rows: [{ shop_id: SHOP_ID }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const res = await h.service.requestPasswordReset({ email: 'ghost@example.com', shopId: SHOP_ID }, null);
    expect(res).toEqual({ devHandoffToken: null });
    expect(
      h.pool.query.mock.calls.some((c) => (c[0] as string).includes('password_reset_token_hash = $2')),
    ).toBe(false);
  });

  it('consume rehashes, clears the token and kills every session', async () => {
    const h = makeHarness((sql, params) => {
      if (sql.includes('FROM member_credential c')) {
        return { rows: [{ member_id: MEMBER_ID, shop_id: SHOP_ID }], rowCount: 1 };
      }
      if (sql.includes('SET password_hash = $2')) {
        expect(params[0]).toBe(MEMBER_ID);
        expect(params[1]).toMatch(/^\$argon2id\$/);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await h.service.consumePasswordReset({ token: 'plain-token', newPassword: NEW_PASSWORD }, 'ip-hash');

    // RW-04 / OVR-1: every existing session dies on password reset
    expect(h.sessions.invalidateMember).toHaveBeenCalledWith(MEMBER_ID, 'PASSWORD_RESET');
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'native_password_reset.consumed', objectId: MEMBER_ID }),
    );
    // the new password never touches the audit trail or the SQL params raw
    expect(JSON.stringify(h.audit.record.mock.calls)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(h.pool.query.mock.calls)).not.toContain(NEW_PASSWORD);
  });

  it('consume rejects an invalid/expired token and invalidates nothing', async () => {
    const h = makeHarness(() => ({ rows: [], rowCount: 0 }));
    await expect(
      h.service.consumePasswordReset({ token: 'bad', newPassword: NEW_PASSWORD }, null),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.sessions.invalidateMember).not.toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'native_password_reset.consume_failed' }),
    );
  });
});

describe('logout (both auth sources)', () => {
  it('invalidates the current session and audits', async () => {
    const h = makeHarness();
    const session = makeSession({ memberId: MEMBER_ID, authSource: 'NATIVE' });
    await h.service.logout(session, 'ip-hash');
    expect(h.sessions.invalidateSession).toHaveBeenCalledWith(session.sessionId, 'LOGOUT');
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.logout', objectId: session.sessionId }),
    );
  });
});
