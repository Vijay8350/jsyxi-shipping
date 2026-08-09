import { describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { authenticator } from 'otplib';
import { cipher, makeHarness, makeSession, MEMBER_ID, SHOP_ID } from './helpers';

const NATIVE_SESSION = makeSession({ memberId: MEMBER_ID, role: 'OPERATOR', authSource: 'NATIVE' });

describe('TOTP enrollment (mandatory 2FA, OVR-1)', () => {
  it('refuses enrollment for SHOPIFY_STAFF sessions (credentials are NATIVE-only)', async () => {
    const h = makeHarness();
    await expect(
      h.service.enrollTotp(makeSession({ authSource: 'SHOPIFY_STAFF' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.pool.query).not.toHaveBeenCalled();
  });

  it('stores the secret envelope-encrypted with totp_confirmed=false and returns the otpauth URI', async () => {
    let storedSecret: Buffer | null = null;
    const h = makeHarness((sql, params) => {
      if (sql.includes('SELECT email FROM shop_member')) {
        return { rows: [{ email: 'm@example.com' }], rowCount: 1 };
      }
      if (sql.includes('totp_secret_encrypted')) {
        expect(sql).toContain('totp_confirmed = false');
        storedSecret = params[1] as Buffer;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const { otpauthUri } = await h.service.enrollTotp(NATIVE_SESSION);
    expect(otpauthUri).toContain('otpauth://totp/Jsyxi:');
    expect(storedSecret).toBeInstanceOf(Buffer);

    // §5.7 control 1: at rest it is envelope ciphertext, not the base32 secret
    const secret = cipher.decrypt(storedSecret as unknown as Buffer).toString('utf8');
    expect(otpauthUri).toContain(`secret=${secret}`);
    expect((storedSecret as unknown as Buffer).toString('utf8')).not.toBe(secret);

    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'native_totp.enrolled', actorId: MEMBER_ID }),
    );
  });

  it('confirm flips totp_confirmed on the first valid code', async () => {
    const secret = authenticator.generateSecret();
    let confirmed = false;
    const h = makeHarness((sql) => {
      if (sql.includes('SELECT c.totp_secret_encrypted')) {
        return { rows: [{ totp_secret_encrypted: cipher.encrypt(secret) }], rowCount: 1 };
      }
      if (sql.includes('totp_confirmed = true')) {
        confirmed = true;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await h.service.confirmTotp(NATIVE_SESSION, authenticator.generate(secret), 'ip-hash');
    expect(confirmed).toBe(true);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'native_totp.confirmed', shopId: SHOP_ID }),
    );
  });

  it('confirm rejects a bad code and audits the failure', async () => {
    const secret = authenticator.generateSecret();
    const h = makeHarness((sql) => {
      if (sql.includes('SELECT c.totp_secret_encrypted')) {
        return { rows: [{ totp_secret_encrypted: cipher.encrypt(secret) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    await expect(h.service.confirmTotp(NATIVE_SESSION, '000000', null)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'native_totp.confirm_failure' }),
    );
    // confirm_failure must not contain the attempted code
    expect(JSON.stringify(h.audit.record.mock.calls)).not.toContain('000000');
  });

  it('confirm before enroll is a 400, not a crash', async () => {
    const h = makeHarness((sql) => {
      if (sql.includes('SELECT c.totp_secret_encrypted')) {
        return { rows: [{ totp_secret_encrypted: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    await expect(h.service.confirmTotp(NATIVE_SESSION, '123456', null)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
