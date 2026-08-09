import { describe, expect, it } from 'vitest';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { INVITE_TTL_HOURS } from '../../src/modules/native-auth/native-auth.constants';
import {
  auditArgStrings,
  makeHarness,
  makeSession,
  MEMBER_ID,
  OWNER_ID,
  SHOP_ID,
} from './helpers';

const INVITE_ID = '44444444-4444-4444-4444-444444444444';

describe('native invites (OVR-1)', () => {
  it('rejects invite creation by a non-Owner', async () => {
    const h = makeHarness();
    await expect(
      h.service.createInvite(makeSession({ role: 'OPERATOR' }), { email: 'a@b.com', role: 'VIEWER' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.pool.query).not.toHaveBeenCalled();
  });

  it('never issues an Owner invite (service-level guard before the DB CHECK)', async () => {
    const h = makeHarness();
    await expect(
      // The DTO whitelist normally blocks this; the service must not trust it.
      h.service.createInvite(makeSession(), { email: 'a@b.com', role: 'OWNER' as 'VIEWER' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.pool.query).not.toHaveBeenCalled();
  });

  it('creates an invite with hashed token, 72h expiry, dev-handoff token and audit', async () => {
    const h = makeHarness((sql) => {
      if (sql.includes('INSERT INTO member_invite')) {
        return { rows: [{ invite_id: INVITE_ID, expires_at: new Date() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const result = await h.service.createInvite(makeSession(), {
      email: 'New@Example.com',
      role: 'OPERATOR',
    });
    expect(result.inviteId).toBe(INVITE_ID);
    expect(result.devHandoffToken).toBeTruthy();

    const insert = h.pool.query.mock.calls.find((c) => (c[0] as string).includes('INSERT INTO member_invite'));
    expect(insert).toBeDefined();
    const params = insert![1] as unknown[];
    expect(params[0]).toBe(SHOP_ID); // INV-1 shop scope
    expect(params[1]).toBe('New@Example.com');
    expect(params[2]).toBe('OPERATOR');
    // token is stored hashed only — the plaintext is not an INSERT param
    expect(params[3]).not.toBe(result.devHandoffToken);
    expect(params[4]).toBe(OWNER_ID);
    expect(params[5]).toBe(String(INVITE_TTL_HOURS));

    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'native_invite.created', shopId: SHOP_ID }),
    );
    // §5.7 control 4: the raw email never reaches the audit row
    expect(auditArgStrings(h)).not.toContain('New@Example.com');
    expect(auditArgStrings(h)).not.toContain('new@example.com');
  });

  it('accept creates member + credential + invite-accept in ONE transaction', async () => {
    const h = makeHarness((sql) => {
      if (sql.includes('FROM member_invite')) {
        return {
          rows: [{
            invite_id: INVITE_ID,
            shop_id: SHOP_ID,
            email: 'new@example.com',
            role: 'FINANCE',
            invited_by: OWNER_ID,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    h.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO shop_member')) return { rows: [{ member_id: MEMBER_ID }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const result = await h.service.acceptInvite(
      { token: 'plain-token', password: 'a-very-long-password' },
      'ip-hash',
    );

    expect(h.pool.connect).toHaveBeenCalledTimes(1);
    const clientSql = h.client.query.mock.calls.map((c) => (c[0] as string).trim());
    expect(clientSql[0]).toBe('BEGIN');
    expect(clientSql.some((s) => s.includes('INSERT INTO shop_member'))).toBe(true);
    expect(clientSql.some((s) => s.includes('INSERT INTO member_credential'))).toBe(true);
    expect(clientSql.some((s) => s.includes('UPDATE member_invite'))).toBe(true);
    expect(clientSql[clientSql.length - 1]).toBe('COMMIT');
    expect(clientSql).not.toContain('ROLLBACK');
    expect(h.client.release).toHaveBeenCalled();

    const memberInsert = h.client.query.mock.calls.find((c) =>
      (c[0] as string).includes('INSERT INTO shop_member'),
    );
    expect(memberInsert![0] as string).toContain(`'NATIVE'`); // auth_source literal
    const memberParams = memberInsert![1] as unknown[];
    expect(memberParams).toContain(SHOP_ID);
    expect(memberParams).toContain('FINANCE');

    const credInsert = h.client.query.mock.calls.find((c) =>
      (c[0] as string).includes('INSERT INTO member_credential'),
    );
    const credParams = credInsert![1] as unknown[];
    expect(credParams[0]).toBe(MEMBER_ID);
    // argon2id hash stored, never the plaintext password
    expect(credParams[1]).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(h.client.query.mock.calls)).not.toContain('a-very-long-password');

    expect(h.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: SHOP_ID, memberId: MEMBER_ID, authSource: 'NATIVE' }),
    );
    expect(result.sessionToken).toBe('sess-token');
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'native_invite.accepted', objectId: MEMBER_ID }),
    );
  });

  it('accept rejects an invalid/expired/revoked token without touching the client', async () => {
    const h = makeHarness(() => ({ rows: [], rowCount: 0 }));
    await expect(
      h.service.acceptInvite({ token: 'bad', password: 'a-very-long-password' }, null),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.pool.connect).not.toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'native_invite.accept_failed', reason: 'invite_invalid' }),
    );
  });

  it('accept refuses an OWNER-role invite even if one somehow exists', async () => {
    const h = makeHarness((sql) => {
      if (sql.includes('FROM member_invite')) {
        return {
          rows: [{
            invite_id: INVITE_ID, shop_id: SHOP_ID, email: 'x@y.z',
            role: 'OWNER', invited_by: OWNER_ID,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    await expect(
      h.service.acceptInvite({ token: 't', password: 'a-very-long-password' }, null),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.pool.connect).not.toHaveBeenCalled();
  });

  it('accept rolls back and maps a duplicate email to 409', async () => {
    const h = makeHarness((sql) => {
      if (sql.includes('FROM member_invite')) {
        return {
          rows: [{
            invite_id: INVITE_ID, shop_id: SHOP_ID, email: 'dup@example.com',
            role: 'VIEWER', invited_by: OWNER_ID,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    h.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO shop_member')) {
        const err = new Error('duplicate key') as Error & { code: string };
        err.code = '23505';
        throw err;
      }
      return { rows: [], rowCount: 0 }; // BEGIN / ROLLBACK / COMMIT
    });
    await expect(
      h.service.acceptInvite({ token: 't', password: 'a-very-long-password' }, null),
    ).rejects.toBeInstanceOf(ConflictException);
    const clientSql = h.client.query.mock.calls.map((c) => (c[0] as string).trim());
    expect(clientSql).toContain('ROLLBACK');
    expect(clientSql).not.toContain('COMMIT');
    expect(h.client.release).toHaveBeenCalled();
  });

  it('resend revokes the old invite and issues a new token in one transaction', async () => {
    const h = makeHarness((sql) => {
      if (sql.includes('SELECT email, role FROM member_invite')) {
        return { rows: [{ email: 'new@example.com', role: 'OPERATOR' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    h.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO member_invite')) {
        return { rows: [{ invite_id: 'new-invite-id', expires_at: new Date() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const result = await h.service.resendInvite(makeSession(), INVITE_ID);
    expect(result.inviteId).toBe('new-invite-id');
    expect(result.devHandoffToken).toBeTruthy();

    const clientSql = h.client.query.mock.calls.map((c) => (c[0] as string).trim());
    expect(clientSql[0]).toBe('BEGIN');
    expect(clientSql.some((s) => s.includes('UPDATE member_invite SET revoked_at'))).toBe(true);
    expect(clientSql.some((s) => s.includes('INSERT INTO member_invite'))).toBe(true);
    expect(clientSql[clientSql.length - 1]).toBe('COMMIT');
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'native_invite.resent' }),
    );
  });

  it('revoke marks the invite and audits; missing invite is 404', async () => {
    const h = makeHarness(() => ({ rows: [], rowCount: 1 }));
    await h.service.revokeInvite(makeSession(), INVITE_ID);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'native_invite.revoked', objectId: INVITE_ID }),
    );

    const h2 = makeHarness(() => ({ rows: [], rowCount: 0 }));
    await expect(h2.service.revokeInvite(makeSession(), INVITE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
