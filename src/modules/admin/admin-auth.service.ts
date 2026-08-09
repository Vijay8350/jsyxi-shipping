import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { randomToken, saltedPiiHash, tokenHash } from '../../common/crypto';
import { EnvelopeCipher } from '../../common/envelope';
import {
  ADMIN_PASSWORD_MIN_LENGTH,
  ADMIN_SESSION_TTL_HOURS,
  ADMIN_TOTP_ISSUER,
  ADMIN_TOTP_WINDOW,
} from './admin.constants';
import {
  AdminLoginDto,
  AdminTotpConfirmDto,
  AdminTotpEnrollDto,
  CreateAdminUserDto,
} from './admin-auth.dto';
import { AdminContext, AdminRole } from './admin.types';

/**
 * §10.3 admin authentication for admin.jsyxi.com: email + argon2id password
 * with mandatory TOTP (MFA-backed RBAC). Admin-local by design — this service
 * mirrors the OVR-1 native-auth pattern but never imports the merchant module:
 * admin staff are platform identities (admin_user), not shop members.
 *
 * Standing rules honoured throughout:
 * - §12 / INV-18: every admin login (success AND failure) is audited; no
 *   password, TOTP code or raw email is ever logged — emails enter audit rows
 *   only as salted hashes (§5.7 control 4).
 * - §5.7 control 1: the TOTP secret is envelope-encrypted at rest.
 * - Sessions live 12 hours (RW-04) and die on logout or admin deactivation.
 *
 * TOTP enrollment is password-gated (no session exists before first login):
 * enroll and confirm each re-verify email+password, so a leaked enrollment
 * link alone cannot attach an attacker's authenticator.
 */

const INVALID_CREDENTIALS = 'invalid email or password';

/** Timing equalization on the unknown-email path (same trick as OVR-1). */
const DUMMY_ARGON2_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$MTxPlYkdCiEQVeFWBkV5xg$I6eqb5OVBLhzbnom3FZr4ZS6Hdvm0M5o2rOVtjwWWhQ';

interface AdminUserRow {
  admin_id: string;
  role: AdminRole;
  password_hash: string;
  totp_secret_encrypted: Buffer | null;
  totp_confirmed: boolean;
}

@Injectable()
export class AdminAuthService {
  private readonly cipher: EnvelopeCipher;
  private readonly piiSalt: string;
  private readonly totp: typeof authenticator;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.cipher = EnvelopeCipher.fromHex(config.get<string>('crypto.masterKeyHex') ?? '');
    this.piiSalt = config.get<string>('crypto.piiHashSalt') ?? '';
    this.totp = authenticator.clone({ window: ADMIN_TOTP_WINDOW });
  }

  /** Salted IP hash for audit rows (§5.7 control 4). */
  hashIp(ip: string | undefined): string | null {
    if (!ip) return null;
    return saltedPiiHash(this.piiSalt, ip);
  }

  // ------------------------------------------------------------------
  // Provisioning (PLATFORM_ADMIN only — enforced at the controller)
  // ------------------------------------------------------------------

  async createAdminUser(
    actor: AdminContext,
    dto: CreateAdminUserDto,
  ): Promise<{ adminId: string }> {
    if (dto.password.length < ADMIN_PASSWORD_MIN_LENGTH) {
      throw new BadRequestException(
        `password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`,
      );
    }
    const passwordHash = await argon2.hash(dto.password);
    try {
      const { rows } = await this.pool.query<{ admin_id: string }>(
        `INSERT INTO admin_user (email, password_hash, role)
         VALUES (lower($1), $2, $3)
         RETURNING admin_id`,
        [dto.email, passwordHash, dto.role],
      );
      await this.audit.record({
        actorKind: 'ADMIN',
        actorId: actor.adminId,
        action: 'admin_user.created',
        objectType: 'admin_user',
        objectId: rows[0].admin_id,
        after: { email_hash: saltedPiiHash(this.piiSalt, dto.email), role: dto.role },
      });
      return { adminId: rows[0].admin_id };
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('an admin with this email exists');
      throw err;
    }
  }

  async listAdminUsers(): Promise<
    Array<{ admin_id: string; role: AdminRole; is_active: boolean; totp_confirmed: boolean; last_login_at: Date | null }>
  > {
    // No email column selected: the admin staff list does not need it and
    // least-exposure is the default on this surface (§10.3, INV-18).
    const { rows } = await this.pool.query(
      `SELECT admin_id, role, is_active, totp_confirmed, last_login_at
         FROM admin_user
        ORDER BY created_at ASC`,
    );
    return rows;
  }

  async setAdminActive(
    actor: AdminContext,
    adminId: string,
    active: boolean,
  ): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE admin_user SET is_active = $2 WHERE admin_id = $1`,
      [adminId, active],
    );
    if (!rowCount) throw new BadRequestException('admin user not found');
    if (!active) {
      // Deactivation kills every live session immediately (RW-04 stance).
      await this.pool.query(
        `UPDATE admin_session SET invalidated_at = now()
          WHERE admin_id = $1 AND invalidated_at IS NULL`,
        [adminId],
      );
    }
    await this.audit.record({
      actorKind: 'ADMIN',
      actorId: actor.adminId,
      action: active ? 'admin_user.reactivated' : 'admin_user.deactivated',
      objectType: 'admin_user',
      objectId: adminId,
    });
  }

  // ------------------------------------------------------------------
  // TOTP enrollment (mandatory MFA, §10.3) — password-gated, pre-session
  // ------------------------------------------------------------------

  async enrollTotp(dto: AdminTotpEnrollDto): Promise<{ otpauthUri: string }> {
    const admin = await this.verifyEmailPassword(dto.email, dto.password);
    const secret = this.totp.generateSecret();
    // A re-enroll replaces the secret and forces re-confirmation.
    await this.pool.query(
      `UPDATE admin_user
          SET totp_secret_encrypted = $2, totp_confirmed = false
        WHERE admin_id = $1`,
      [admin.admin_id, this.cipher.encrypt(secret)],
    );
    await this.audit.record({
      actorKind: 'ADMIN',
      actorId: admin.admin_id,
      action: 'admin_totp.enrolled',
      objectType: 'admin_user',
      objectId: admin.admin_id,
    });
    return { otpauthUri: this.totp.keyuri(dto.email, ADMIN_TOTP_ISSUER, secret) };
  }

  async confirmTotp(dto: AdminTotpConfirmDto, ipHash: string | null): Promise<void> {
    const admin = await this.verifyEmailPassword(dto.email, dto.password);
    if (!admin.totp_secret_encrypted) {
      throw new BadRequestException('TOTP is not enrolled');
    }
    const ok = this.totp.verify({
      token: dto.code,
      secret: this.cipher.decrypt(admin.totp_secret_encrypted).toString('utf8'),
    });
    if (!ok) {
      await this.audit.record({
        actorKind: 'ADMIN',
        actorId: admin.admin_id,
        action: 'admin_totp.confirm_failure',
        objectType: 'admin_user',
        objectId: admin.admin_id,
        ipHash,
      });
      throw new UnauthorizedException('invalid TOTP code');
    }
    await this.pool.query(
      `UPDATE admin_user SET totp_confirmed = true WHERE admin_id = $1`,
      [admin.admin_id],
    );
    await this.audit.record({
      actorKind: 'ADMIN',
      actorId: admin.admin_id,
      action: 'admin_totp.confirmed',
      objectType: 'admin_user',
      objectId: admin.admin_id,
      ipHash,
    });
  }

  // ------------------------------------------------------------------
  // Login (every attempt audited, §12) / logout / session resolution
  // ------------------------------------------------------------------

  async login(
    dto: AdminLoginDto,
    ipHash: string | null,
  ): Promise<{ sessionToken: string; context: AdminContext }> {
    const emailHash = saltedPiiHash(this.piiSalt, dto.email);
    const fail = async (reason: string, adminId: string | null): Promise<never> => {
      // §12: EVERY admin login attempt is audited — success and failure.
      await this.audit.record({
        actorKind: adminId ? 'ADMIN' : 'SYSTEM',
        actorId: adminId,
        action: 'admin_login.failure',
        objectType: 'admin_user',
        objectId: adminId,
        after: { email_hash: emailHash },
        reason,
        ipHash,
      });
      throw new UnauthorizedException(
        reason === 'totp_not_enrolled'
          ? 'TOTP enrollment required before login'
          : reason === 'totp_required'
            ? 'TOTP code required'
            : reason === 'totp_invalid'
              ? 'invalid TOTP code'
              : INVALID_CREDENTIALS,
      );
    };

    const { rows } = await this.pool.query<AdminUserRow>(
      `SELECT admin_id, role, password_hash, totp_secret_encrypted, totp_confirmed
         FROM admin_user
        WHERE lower(email) = lower($1) AND is_active = true`,
      [dto.email],
    );
    const admin = rows[0];
    if (!admin) {
      await argon2.verify(DUMMY_ARGON2_HASH, dto.password); // timing equalization
      return fail('invalid_credentials', null);
    }

    const passwordOk = await argon2.verify(admin.password_hash, dto.password);
    if (!passwordOk) return fail('invalid_credentials', admin.admin_id);

    // Mandatory MFA (§10.3): no password-only login, ever.
    if (!admin.totp_confirmed) return fail('totp_not_enrolled', admin.admin_id);
    if (!dto.totpCode) return fail('totp_required', admin.admin_id);
    const secret = this.cipher
      .decrypt(admin.totp_secret_encrypted as Buffer)
      .toString('utf8');
    if (!this.totp.verify({ token: dto.totpCode, secret })) {
      return fail('totp_invalid', admin.admin_id);
    }

    const sessionToken = randomToken(32);
    const { rows: created } = await this.pool.query<{ session_id: string }>(
      `INSERT INTO admin_session (admin_id, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3 || ' hours')::interval)
       RETURNING session_id`,
      [admin.admin_id, tokenHash(sessionToken), String(ADMIN_SESSION_TTL_HOURS)],
    );
    await this.pool.query(
      `UPDATE admin_user SET last_login_at = now() WHERE admin_id = $1`,
      [admin.admin_id],
    );
    await this.audit.record({
      actorKind: 'ADMIN',
      actorId: admin.admin_id,
      action: 'admin_login.success',
      objectType: 'admin_user',
      objectId: admin.admin_id,
      after: { method: 'password+totp' },
      ipHash,
    });
    return {
      sessionToken,
      context: { sessionId: created[0].session_id, adminId: admin.admin_id, role: admin.role },
    };
  }

  async logout(context: AdminContext, ipHash: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE admin_session SET invalidated_at = now() WHERE session_id = $1`,
      [context.sessionId],
    );
    await this.audit.record({
      actorKind: 'ADMIN',
      actorId: context.adminId,
      action: 'admin_logout',
      objectType: 'admin_session',
      objectId: context.sessionId,
      ipHash,
    });
  }

  /**
   * Resolve a session cookie to an AdminContext. Returns null for expired,
   * invalidated or deactivated-admin sessions — the guard turns that into 401.
   */
  async resolveSession(token: string): Promise<AdminContext | null> {
    const { rows } = await this.pool.query<{
      session_id: string;
      admin_id: string;
      role: AdminRole;
    }>(
      `SELECT s.session_id, s.admin_id, u.role
         FROM admin_session s
         JOIN admin_user u ON u.admin_id = s.admin_id
        WHERE s.token_hash = $1
          AND s.invalidated_at IS NULL
          AND s.expires_at > now()
          AND u.is_active = true`,
      [tokenHash(token)],
    );
    const row = rows[0];
    if (!row) return null;
    return { sessionId: row.session_id, adminId: row.admin_id, role: row.role };
  }

  // ------------------------------------------------------------------

  /** Shared email+password check for the pre-session TOTP enrollment flow. */
  private async verifyEmailPassword(email: string, password: string): Promise<AdminUserRow> {
    const { rows } = await this.pool.query<AdminUserRow>(
      `SELECT admin_id, role, password_hash, totp_secret_encrypted, totp_confirmed
         FROM admin_user
        WHERE lower(email) = lower($1) AND is_active = true`,
      [email],
    );
    const admin = rows[0];
    if (!admin) {
      await argon2.verify(DUMMY_ARGON2_HASH, password); // timing equalization
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    if (!(await argon2.verify(admin.password_hash, password))) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    return admin;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
