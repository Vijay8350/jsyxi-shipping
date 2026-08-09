import { describe, expect, it } from 'vitest';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { tokenHash } from '../../src/common/crypto';
import {
  ADMIN_ID,
  auditStrings,
  cipher,
  makeAdminAuth,
  poolCalls,
} from './helpers';

/**
 * §10.3 admin auth: argon2 password + mandatory TOTP, every login audited
 * (§12), no secrets or raw emails in the audit trail (INV-18, §5.7 c4).
 */

const EMAIL = 'root@jsyxi.com';
const PASSWORD = 'correct horse battery';

async function adminRow(opts: { totpSecret?: string; totpConfirmed?: boolean } = {}) {
  return {
    admin_id: ADMIN_ID,
    role: 'PLATFORM_ADMIN',
    password_hash: await argon2.hash(PASSWORD),
    totp_secret_encrypted: opts.totpSecret ? cipher.encrypt(opts.totpSecret) : null,
    totp_confirmed: opts.totpConfirmed ?? false,
  };
}

describe('AdminAuthService.login (§10.3 MFA-backed RBAC)', () => {
  it('rejects an unknown email with timing equalization and audits the failure', async () => {
    const { service, audit } = makeAdminAuth();
    await expect(service.login({ email: EMAIL, password: PASSWORD }, null)).rejects.toThrow(
      'invalid email or password',
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin_login.failure',
        actorKind: 'SYSTEM',
        reason: 'invalid_credentials',
      }),
    );
    // §5.7 control 4: the raw email never reaches the audit row.
    expect(auditStrings(audit)).not.toContain(EMAIL);
  });

  it('rejects a bad password and audits it', async () => {
    const row = await adminRow();
    const { service, audit } = makeAdminAuth((sql) => {
      if (sql.includes('FROM admin_user')) return { rows: [row], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(service.login({ email: EMAIL, password: 'wrong password' }, null)).rejects.toThrow(
      'invalid email or password',
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin_login.failure', reason: 'invalid_credentials', actorId: ADMIN_ID }),
    );
  });

  it('blocks password login until TOTP is confirmed (mandatory MFA, §10.3)', async () => {
    const row = await adminRow({ totpConfirmed: false });
    const { service, audit } = makeAdminAuth((sql) => {
      if (sql.includes('FROM admin_user')) return { rows: [row], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(service.login({ email: EMAIL, password: PASSWORD }, null)).rejects.toThrow(
      'TOTP enrollment required',
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin_login.failure', reason: 'totp_not_enrolled' }),
    );
  });

  it('requires the TOTP code once enrolled', async () => {
    const secret = authenticator.generateSecret();
    const row = await adminRow({ totpSecret: secret, totpConfirmed: true });
    const { service, audit } = makeAdminAuth((sql) => {
      if (sql.includes('FROM admin_user')) return { rows: [row], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(service.login({ email: EMAIL, password: PASSWORD }, null)).rejects.toThrow(
      'TOTP code required',
    );
    await expect(
      service.login({ email: EMAIL, password: PASSWORD, totpCode: '000000' }, null),
    ).rejects.toThrow('invalid TOTP code');
    expect(auditStrings(audit)).toContain('totp_required');
    expect(auditStrings(audit)).toContain('totp_invalid');
  });

  it('issues a 12h admin_session on password+TOTP success and audits it', async () => {
    const secret = authenticator.generateSecret();
    const row = await adminRow({ totpSecret: secret, totpConfirmed: true });
    const inserts: Array<{ sql: string; params: unknown[] }> = [];
    const { service, pool, audit } = makeAdminAuth((sql, params) => {
      if (sql.includes('FROM admin_user')) return { rows: [row], rowCount: 1 };
      if (sql.includes('INSERT INTO admin_session')) {
        inserts.push({ sql, params });
        return { rows: [{ session_id: 'sess-1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const code = authenticator.generate(secret);
    const result = await service.login({ email: EMAIL, password: PASSWORD, totpCode: code }, null);
    expect(result.context).toEqual({ sessionId: 'sess-1', adminId: ADMIN_ID, role: 'PLATFORM_ADMIN' });
    // RW-04: 12-hour TTL on the session row.
    expect(inserts[0].sql).toContain("' hours')::interval");
    expect(inserts[0].params[2]).toBe('12');
    // The raw token is never stored — only its hash.
    expect(inserts[0].params[1]).toBe(tokenHash(result.sessionToken));
    expect(inserts[0].params[1]).not.toBe(result.sessionToken);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin_login.success', actorKind: 'ADMIN', actorId: ADMIN_ID }),
    );
    // INV-18: the TOTP code and password never appear in any audit row.
    expect(auditStrings(audit)).not.toContain(code);
    expect(auditStrings(audit)).not.toContain(PASSWORD);
    expect(poolCalls(pool).some((c) => c.sql.includes('last_login_at'))).toBe(true);
  });
});

describe('AdminAuthService TOTP enrollment (password-gated, pre-session)', () => {
  it('enroll requires a valid email+password and stores the secret encrypted', async () => {
    const row = await adminRow();
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    const { service } = makeAdminAuth((sql, params) => {
      if (sql.includes('FROM admin_user')) return { rows: [row], rowCount: 1 };
      if (sql.includes('totp_secret_encrypted')) {
        updates.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const { otpauthUri } = await service.enrollTotp({ email: EMAIL, password: PASSWORD });
    expect(otpauthUri).toContain('otpauth://totp/');
    const stored = updates[0].params[1] as Buffer;
    expect(Buffer.isBuffer(stored)).toBe(true);
    // §5.7 control 1: envelope-encrypted at rest; round-trips via the cipher.
    const secret = cipher.decrypt(stored).toString('utf8');
    expect(secret.length).toBeGreaterThan(10);
    // A re-enroll forces re-confirmation.
    expect(updates[0].sql).toContain('totp_confirmed = false');
  });

  it('confirm flips totp_confirmed only for a valid code', async () => {
    const secret = authenticator.generateSecret();
    const row = await adminRow({ totpSecret: secret });
    const updates: string[] = [];
    const { service, audit } = makeAdminAuth((sql) => {
      if (sql.includes('FROM admin_user')) return { rows: [row], rowCount: 1 };
      if (sql.includes('UPDATE admin_user SET totp_confirmed = true')) updates.push(sql);
      return { rows: [], rowCount: 1 };
    });
    await expect(
      service.confirmTotp({ email: EMAIL, password: PASSWORD, code: '123456' }, null),
    ).rejects.toThrow('invalid TOTP code');
    await service.confirmTotp(
      { email: EMAIL, password: PASSWORD, code: authenticator.generate(secret) },
      null,
    );
    expect(updates).toHaveLength(1);
    expect(auditStrings(audit)).toContain('admin_totp.confirmed');
  });
});

describe('AdminAuthService.resolveSession / logout', () => {
  it('resolves a live session for an active admin; null otherwise', async () => {
    const { service } = makeAdminAuth((sql) => {
      if (sql.includes('FROM admin_session')) {
        return { rows: [{ session_id: 's1', admin_id: ADMIN_ID, role: 'SUPPORT_AGENT' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const ctx = await service.resolveSession('raw-token');
    expect(ctx).toEqual({ sessionId: 's1', adminId: ADMIN_ID, role: 'SUPPORT_AGENT' });

    const dead = makeAdminAuth();
    expect(await dead.service.resolveSession('raw-token')).toBeNull();
  });

  it('deactivation kills every live admin session (RW-04 stance)', async () => {
    const { service, pool } = makeAdminAuth(() => ({ rows: [], rowCount: 1 }));
    await service.setAdminActive(
      { sessionId: 's', adminId: 'boss', role: 'PLATFORM_ADMIN' },
      ADMIN_ID,
      false,
    );
    const calls = poolCalls(pool);
    expect(calls.some((c) => c.sql.includes('UPDATE admin_session SET invalidated_at'))).toBe(true);
  });
});
