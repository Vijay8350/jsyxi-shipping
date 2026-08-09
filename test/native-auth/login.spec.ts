import { describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import {
  LOCK_MINUTES,
  LOCK_THRESHOLD,
} from '../../src/modules/native-auth/native-auth.constants';
import { cipher, makeHarness, MEMBER_ID, SHOP_ID, TestHarness } from './helpers';

const PASSWORD = 'the-correct-password';
const GENERIC = 'invalid email or password';

interface FakeState {
  passwordHash: string;
  totpSecret: string;
  totpConfirmed: boolean;
  failedAttempts: number;
  lockedUntil: Date | null;
  memberFound: boolean;
}

/** Stateful fake over shop + shop_member + member_credential for login flows. */
function makeLoginHarness(state: FakeState): TestHarness {
  return makeHarness((sql, params) => {
    if (sql.includes('FROM shop WHERE')) return { rows: [{ shop_id: SHOP_ID }], rowCount: 1 };
    if (sql.includes('FROM shop_member m')) {
      if (!state.memberFound) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          member_id: MEMBER_ID,
          role: 'OPERATOR',
          password_hash: state.passwordHash,
          totp_secret_encrypted: cipher.encrypt(state.totpSecret),
          totp_confirmed: state.totpConfirmed,
          locked_until: state.lockedUntil,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes('failed_attempts = failed_attempts + 1')) {
      // mirror the SQL: increment, and lock when the threshold is crossed
      expect(params[1]).toBe(LOCK_THRESHOLD);
      expect(params[2]).toBe(String(LOCK_MINUTES));
      state.failedAttempts += 1;
      if (state.failedAttempts >= LOCK_THRESHOLD) {
        state.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('failed_attempts = 0')) {
      state.failedAttempts = 0;
      state.lockedUntil = null;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

async function freshState(overrides: Partial<FakeState> = {}): Promise<FakeState> {
  return {
    passwordHash: await argon2.hash(PASSWORD),
    totpSecret: authenticator.generateSecret(),
    totpConfirmed: true,
    failedAttempts: 0,
    lockedUntil: null,
    memberFound: true,
    ...overrides,
  };
}

function failureReasons(h: TestHarness): string[] {
  return h.audit.record.mock.calls
    .map((c) => c[0] as { action: string; reason?: string })
    .filter((e) => e.action === 'native_login.failure')
    .map((e) => e.reason ?? '');
}

describe('native login (OVR-1)', () => {
  it('succeeds with password + TOTP, resets the counter and audits success', async () => {
    const state = await freshState({ failedAttempts: 2 });
    const h = makeLoginHarness(state);
    const totpCode = authenticator.generate(state.totpSecret);

    const result = await h.service.login(
      { email: 'm@example.com', password: PASSWORD, totpCode, shopId: SHOP_ID },
      'ip-hash',
    );

    expect(result.sessionToken).toBe('sess-token');
    expect(h.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: SHOP_ID, memberId: MEMBER_ID, authSource: 'NATIVE' }),
    );
    expect(state.failedAttempts).toBe(0); // reset on full success
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'native_login.success',
        actorId: MEMBER_ID,
        after: { method: 'password' },
      }),
    );
    // never the password or the code in the audit trail (INV-18)
    expect(JSON.stringify(h.audit.record.mock.calls)).not.toContain(PASSWORD);
    expect(JSON.stringify(h.audit.record.mock.calls)).not.toContain(totpCode);
  });

  it('blocks password login until TOTP is confirmed (mandatory 2FA)', async () => {
    const state = await freshState({ totpConfirmed: false });
    const h = makeLoginHarness(state);
    await expect(
      h.service.login({ email: 'm@example.com', password: PASSWORD, shopId: SHOP_ID }, null),
    ).rejects.toThrow('TOTP enrollment required');
    expect(h.sessions.create).not.toHaveBeenCalled();
    expect(failureReasons(h)).toEqual(['totp_not_enrolled']);
  });

  it('asks for the TOTP code after a valid password', async () => {
    const state = await freshState();
    const h = makeLoginHarness(state);
    await expect(
      h.service.login({ email: 'm@example.com', password: PASSWORD, shopId: SHOP_ID }, null),
    ).rejects.toThrow('TOTP code required');
    expect(h.sessions.create).not.toHaveBeenCalled();
    expect(failureReasons(h)).toEqual(['totp_required']);
  });

  it('rejects a wrong TOTP code without creating a session', async () => {
    const state = await freshState();
    const h = makeLoginHarness(state);
    await expect(
      h.service.login(
        { email: 'm@example.com', password: PASSWORD, totpCode: '000000', shopId: SHOP_ID },
        null,
      ),
    ).rejects.toThrow('invalid TOTP code');
    expect(h.sessions.create).not.toHaveBeenCalled();
    expect(failureReasons(h)).toEqual(['totp_invalid']);
  });

  it(`locks after ${LOCK_THRESHOLD} bad passwords and rejects while locked`, async () => {
    const state = await freshState();
    const h = makeLoginHarness(state);
    const incrementsBefore = h.pool.query.mock.calls.filter((c) =>
      (c[0] as string).includes('failed_attempts = failed_attempts + 1'),
    ).length;

    for (let i = 0; i < LOCK_THRESHOLD; i++) {
      await expect(
        h.service.login({ email: 'm@example.com', password: 'wrong-password', shopId: SHOP_ID }, null),
      ).rejects.toThrow(GENERIC);
    }
    expect(state.failedAttempts).toBe(LOCK_THRESHOLD);
    expect(state.lockedUntil).not.toBeNull();

    // locked: even the CORRECT password is rejected before verification
    await expect(
      h.service.login({ email: 'm@example.com', password: PASSWORD, shopId: SHOP_ID }, null),
    ).rejects.toThrow(GENERIC);
    expect(failureReasons(h).filter((r) => r === 'locked')).toHaveLength(1);
    expect(h.sessions.create).not.toHaveBeenCalled();

    // the locked attempt did not run another increment (it never reached verify)
    const incrementsAfter = h.pool.query.mock.calls.filter((c) =>
      (c[0] as string).includes('failed_attempts = failed_attempts + 1'),
    ).length;
    expect(incrementsAfter - incrementsBefore).toBe(LOCK_THRESHOLD);
  });

  it('accepts logins again once the lock has expired', async () => {
    const state = await freshState({
      failedAttempts: LOCK_THRESHOLD,
      lockedUntil: new Date(Date.now() - 1000), // expired
    });
    const h = makeLoginHarness(state);
    const totpCode = authenticator.generate(state.totpSecret);
    const result = await h.service.login(
      { email: 'm@example.com', password: PASSWORD, totpCode, shopId: SHOP_ID },
      null,
    );
    expect(result.sessionToken).toBe('sess-token');
    expect(state.failedAttempts).toBe(0);
    expect(state.lockedUntil).toBeNull();
  });

  it('audits EVERY attempt — success and each failure kind', async () => {
    const state = await freshState();
    const h = makeLoginHarness(state);
    const totpCode = authenticator.generate(state.totpSecret);

    await h.service.login({ email: 'm@example.com', password: PASSWORD, totpCode, shopId: SHOP_ID }, null);
    await h.service
      .login({ email: 'm@example.com', password: 'nope-nope-nope', shopId: SHOP_ID }, null)
      .catch(() => undefined);

    const actions = h.audit.record.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toEqual(['native_login.success', 'native_login.failure']);
  });

  it('is timing-safe for unknown emails: same error, argon2 still runs, audited with no actor', async () => {
    const state = await freshState({ memberFound: false });
    const h = makeLoginHarness(state);

    const started = Date.now();
    const err = await h.service
      .login({ email: 'ghost@example.com', password: 'whatever-password', shopId: SHOP_ID }, null)
      .catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).message).toBe(GENERIC); // identical to a bad password
    // dummy argon2 verify keeps the unknown-email path in the same time class
    expect(elapsed).toBeGreaterThan(20);
    expect(h.sessions.create).not.toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'native_login.failure',
        actorKind: 'SYSTEM',
        actorId: null,
        reason: 'invalid_credentials',
      }),
    );
    // §5.7 control 4: raw email never audited, only its salted hash
    expect(JSON.stringify(h.audit.record.mock.calls)).not.toContain('ghost@example.com');
  });

  it('treats an unknown shop exactly like an unknown email', async () => {
    const h = makeHarness(() => ({ rows: [], rowCount: 0 })); // shop lookup misses
    await expect(
      h.service.login({ email: 'm@example.com', password: 'whatever-password', shopId: SHOP_ID }, null),
    ).rejects.toThrow(GENERIC);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'native_login.failure', shopId: null, actorId: null }),
    );
  });

  it('resolves the shop by myshopify domain too', async () => {
    const state = await freshState();
    const h = makeHarness((sql, params) => {
      if (sql.includes('myshopify_domain')) {
        expect(params[0]).toBe('Store.myshopify.com');
        return { rows: [{ shop_id: SHOP_ID }], rowCount: 1 };
      }
      if (sql.includes('FROM shop_member m')) {
        return {
          rows: [{
            member_id: MEMBER_ID,
            role: 'OPERATOR',
            password_hash: state.passwordHash,
            totp_secret_encrypted: cipher.encrypt(state.totpSecret),
            totp_confirmed: true,
            locked_until: null,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const totpCode = authenticator.generate(state.totpSecret);
    const result = await h.service.login(
      { email: 'm@example.com', password: PASSWORD, totpCode, shopDomain: 'Store.myshopify.com' },
      null,
    );
    expect(result.sessionToken).toBe('sess-token');
  });
});
