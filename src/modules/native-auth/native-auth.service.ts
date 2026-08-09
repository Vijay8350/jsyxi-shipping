import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { SessionService } from '../../auth/session.service';
import { MemberRole, SessionContext } from '../../auth/session.types';
import { randomToken, saltedPiiHash, tokenHash } from '../../common/crypto';
import { EnvelopeCipher } from '../../common/envelope';
import {
  INVITE_TTL_HOURS,
  LOCK_MINUTES,
  LOCK_THRESHOLD,
  MAGIC_LINK_TTL_MINUTES,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RESET_TTL_HOURS,
  TOTP_ISSUER,
  TOTP_WINDOW,
} from './native-auth.constants';
import {
  AcceptInviteDto,
  CreateInviteDto,
  MagicLinkRequestDto,
  NativeLoginDto,
  PasswordResetConsumeDto,
  PasswordResetRequestDto,
} from './native-auth.dto';

/**
 * OVR-1 direct login: Jsyxi-native members (auth_source = 'NATIVE') invited
 * by the Owner, with argon2id passwords, mandatory TOTP 2FA, magic links,
 * lockout, password reset and full audit of every native login.
 *
 * Standing rules honoured throughout:
 * - INV-1: every query is scoped by shop_id; sessions bind (shop_id, member_id).
 * - INV-18 / §5.7 control 4: no password, TOTP code, raw email or raw IP is
 *   ever logged or audited — emails enter audit rows only as salted hashes.
 * - §5.7 control 1: the TOTP secret is envelope-encrypted at rest.
 * - member_credential rows belong only to NATIVE members (enforced here — a
 *   cross-table CHECK is not expressible in SQL, per migration 0002).
 *
 * EMAIL HANDOFF SEAM (v1): no mailer exists yet (notifications are a later
 * module). Invite, magic-link and password-reset tokens are returned on the
 * response as `devHandoffToken` so the flow can be exercised end-to-end; a
 * mailer replaces that field without touching token logic.
 */

const INVALID_CREDENTIALS = 'invalid email or password';
const INVALID_TOKEN = 'invalid or expired token';

/**
 * Pre-computed argon2id hash of a throwaway password. On the unknown-email /
 * unknown-shop login paths we verify against it so the response time does not
 * reveal whether the member exists (timing-safe, OVR-1).
 */
const DUMMY_ARGON2_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$MTxPlYkdCiEQVeFWBkV5xg$I6eqb5OVBLhzbnom3FZr4ZS6Hdvm0M5o2rOVtjwWWhQ';

export const DEV_HANDOFF_NOTE =
  'DEV HANDOFF — v1 has no mailer; the notifications module must deliver this token by email. Until then it is exposed on this response only.';

interface MemberCredentialRow {
  member_id: string;
  role: MemberRole;
  password_hash: string | null;
  totp_secret_encrypted: Buffer | null;
  totp_confirmed: boolean;
  locked_until: Date | null;
}

@Injectable()
export class NativeAuthService {
  private readonly cipher: EnvelopeCipher;
  private readonly piiSalt: string;
  private readonly totp: typeof authenticator;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    // §5.7 control 1 applied to the OVR-1 TOTP secret.
    this.cipher = EnvelopeCipher.fromHex(config.get<string>('crypto.masterKeyHex') ?? '');
    this.piiSalt = config.get<string>('crypto.piiHashSalt') ?? '';
    this.totp = authenticator.clone({ window: TOTP_WINDOW });
  }

  /** Salted IP hash for session/audit rows (§5.7 control 4). */
  hashIp(ip: string | undefined): string | null {
    if (!ip) return null;
    return saltedPiiHash(this.piiSalt, ip);
  }

  // ------------------------------------------------------------------
  // Invites (Owner-only; OVR-1 native members are invited, not discovered)
  // ------------------------------------------------------------------

  async createInvite(
    session: SessionContext,
    dto: CreateInviteDto,
  ): Promise<{ inviteId: string; expiresAt: Date; devHandoffToken: string }> {
    this.requireOwner(session);
    // OVR-1: a native member can never become Owner — the DTO whitelist and
    // the member_invite CHECK back this, but the service does not trust them.
    if (dto.role === 'OWNER') {
      throw new ForbiddenException('a native member can never become Owner');
    }
    const token = randomToken(32);
    const { rows } = await this.pool.query<{ invite_id: string; expires_at: Date }>(
      `INSERT INTO member_invite (shop_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, lower($2), $3, $4, $5, now() + ($6 || ' hours')::interval)
       RETURNING invite_id, expires_at`,
      [session.shopId, dto.email, dto.role, tokenHash(token), session.memberId, String(INVITE_TTL_HOURS)],
    );
    await this.audit.record({
      shopId: session.shopId,
      actorKind: 'MEMBER',
      actorId: session.memberId,
      action: 'native_invite.created',
      objectType: 'member_invite',
      objectId: rows[0].invite_id,
      after: { email_hash: saltedPiiHash(this.piiSalt, dto.email), role: dto.role },
    });
    return { inviteId: rows[0].invite_id, expiresAt: rows[0].expires_at, devHandoffToken: token };
  }

  /** Resend = revoke the outstanding invite + issue a fresh token. */
  async resendInvite(
    session: SessionContext,
    inviteId: string,
  ): Promise<{ inviteId: string; expiresAt: Date; devHandoffToken: string }> {
    this.requireOwner(session);
    const { rows } = await this.pool.query<{ email: string; role: MemberRole }>(
      `SELECT email, role FROM member_invite
        WHERE invite_id = $1 AND shop_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [inviteId, session.shopId],
    );
    if (rows.length === 0) throw new NotFoundException('invite not found');

    const token = randomToken(32);
    const client = await this.pool.connect();
    let created: { invite_id: string; expires_at: Date };
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE member_invite SET revoked_at = now() WHERE invite_id = $1 AND shop_id = $2`,
        [inviteId, session.shopId],
      );
      const ins = await client.query<{ invite_id: string; expires_at: Date }>(
        `INSERT INTO member_invite (shop_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' hours')::interval)
         RETURNING invite_id, expires_at`,
        [session.shopId, rows[0].email, rows[0].role, tokenHash(token), session.memberId, String(INVITE_TTL_HOURS)],
      );
      await client.query('COMMIT');
      created = ins.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await this.audit.record({
      shopId: session.shopId,
      actorKind: 'MEMBER',
      actorId: session.memberId,
      action: 'native_invite.resent',
      objectType: 'member_invite',
      objectId: created.invite_id,
      before: { superseded_invite_id: inviteId },
    });
    return { inviteId: created.invite_id, expiresAt: created.expires_at, devHandoffToken: token };
  }

  async revokeInvite(session: SessionContext, inviteId: string): Promise<void> {
    this.requireOwner(session);
    const { rowCount } = await this.pool.query(
      `UPDATE member_invite SET revoked_at = now()
        WHERE invite_id = $1 AND shop_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [inviteId, session.shopId],
    );
    if (!rowCount) throw new NotFoundException('invite not found');
    await this.audit.record({
      shopId: session.shopId,
      actorKind: 'MEMBER',
      actorId: session.memberId,
      action: 'native_invite.revoked',
      objectType: 'member_invite',
      objectId: inviteId,
    });
  }

  /**
   * Accept an invite: ONE transaction creates the NATIVE shop_member and its
   * member_credential and marks the invite accepted, then a session is issued
   * so the member can immediately enroll TOTP. The member cannot log in with
   * the password until totp_confirmed (mandatory 2FA, OVR-1).
   */
  async acceptInvite(
    dto: AcceptInviteDto,
    ipHash: string | null,
  ): Promise<{ memberId: string; sessionToken: string; context: SessionContext }> {
    const { rows } = await this.pool.query<{
      invite_id: string;
      shop_id: string;
      email: string;
      role: MemberRole;
      invited_by: string;
    }>(
      `SELECT invite_id, shop_id, email, role, invited_by FROM member_invite
        WHERE token_hash = $1 AND expires_at > now() AND accepted_at IS NULL AND revoked_at IS NULL`,
      [tokenHash(dto.token)],
    );
    const invite = rows[0];
    if (!invite) {
      await this.audit.record({
        actorKind: 'SYSTEM',
        action: 'native_invite.accept_failed',
        objectType: 'member_invite',
        reason: 'invite_invalid',
        ipHash,
      });
      throw new UnauthorizedException(INVALID_TOKEN);
    }
    // OVR-1: belt-and-braces next to the member_invite CHECK (role <> 'OWNER').
    if (invite.role === 'OWNER') throw new ForbiddenException('a native member can never become Owner');
    if (dto.password.length < PASSWORD_MIN_LENGTH) {
      throw new BadRequestException(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    }

    const passwordHash = await argon2.hash(dto.password);
    const client = await this.pool.connect();
    let memberId: string;
    try {
      await client.query('BEGIN');
      const m = await client.query<{ member_id: string }>(
        `INSERT INTO shop_member (shop_id, email, auth_source, role, granted_by)
         VALUES ($1, $2, 'NATIVE', $3, $4)
         RETURNING member_id`,
        [invite.shop_id, invite.email, invite.role, invite.invited_by],
      );
      memberId = m.rows[0].member_id;
      // member_credential only ever belongs to NATIVE members — the row above
      // is created with auth_source 'NATIVE' in this same transaction.
      await client.query(
        `INSERT INTO member_credential (member_id, password_hash) VALUES ($1, $2)`,
        [memberId, passwordHash],
      );
      await client.query(
        `UPDATE member_invite SET accepted_at = now()
          WHERE invite_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [invite.invite_id],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(err)) throw new ConflictException('email is already a member of this shop');
      throw err;
    } finally {
      client.release();
    }

    await this.audit.record({
      shopId: invite.shop_id,
      actorKind: 'MEMBER',
      actorId: memberId,
      action: 'native_invite.accepted',
      objectType: 'shop_member',
      objectId: memberId,
      after: { role: invite.role, auth_source: 'NATIVE' },
      ipHash,
    });

    const { token, context } = await this.sessions.create({
      shopId: invite.shop_id,
      memberId,
      role: invite.role,
      authSource: 'NATIVE',
      ipHash,
    });
    return { memberId, sessionToken: token, context };
  }

  // ------------------------------------------------------------------
  // TOTP enrollment (mandatory 2FA, OVR-1)
  // ------------------------------------------------------------------

  async enrollTotp(session: SessionContext): Promise<{ otpauthUri: string }> {
    // member_credential is NATIVE-only; Shopify staff never enroll here.
    if (session.authSource !== 'NATIVE') {
      throw new ForbiddenException('TOTP enrollment is for native members only');
    }
    const { rows } = await this.pool.query<{ email: string }>(
      `SELECT email FROM shop_member
        WHERE member_id = $1 AND shop_id = $2 AND auth_source = 'NATIVE' AND revoked_at IS NULL`,
      [session.memberId, session.shopId],
    );
    if (rows.length === 0) throw new ForbiddenException('native member not found');

    const secret = this.totp.generateSecret();
    const { rowCount } = await this.pool.query(
      // A re-enroll replaces the secret and forces re-confirmation.
      `UPDATE member_credential
          SET totp_secret_encrypted = $2, totp_confirmed = false, version = version + 1
        WHERE member_id = $1`,
      [session.memberId, this.cipher.encrypt(secret)],
    );
    if (!rowCount) throw new ForbiddenException('native credential not found');

    await this.audit.record({
      shopId: session.shopId,
      actorKind: 'MEMBER',
      actorId: session.memberId,
      action: 'native_totp.enrolled',
      objectType: 'member_credential',
      objectId: session.memberId,
    });
    return { otpauthUri: this.totp.keyuri(rows[0].email, TOTP_ISSUER, secret) };
  }

  async confirmTotp(session: SessionContext, code: string, ipHash: string | null): Promise<void> {
    const { rows } = await this.pool.query<{
      totp_secret_encrypted: Buffer | null;
    }>(
      `SELECT c.totp_secret_encrypted
         FROM member_credential c
         JOIN shop_member m ON m.member_id = c.member_id
        WHERE c.member_id = $1 AND m.shop_id = $2
          AND m.auth_source = 'NATIVE' AND m.revoked_at IS NULL`,
      [session.memberId, session.shopId],
    );
    const secret = rows[0]?.totp_secret_encrypted;
    if (!secret) throw new BadRequestException('TOTP is not enrolled');

    const ok = this.totp.verify({ token: code, secret: this.cipher.decrypt(secret).toString('utf8') });
    if (!ok) {
      await this.audit.record({
        shopId: session.shopId,
        actorKind: 'MEMBER',
        actorId: session.memberId,
        action: 'native_totp.confirm_failure',
        objectType: 'member_credential',
        objectId: session.memberId,
        ipHash,
      });
      throw new UnauthorizedException('invalid TOTP code');
    }
    await this.pool.query(
      `UPDATE member_credential SET totp_confirmed = true, version = version + 1
        WHERE member_id = $1`,
      [session.memberId],
    );
    await this.audit.record({
      shopId: session.shopId,
      actorKind: 'MEMBER',
      actorId: session.memberId,
      action: 'native_totp.confirmed',
      objectType: 'member_credential',
      objectId: session.memberId,
      ipHash,
    });
  }

  // ------------------------------------------------------------------
  // Login (every attempt audited, OVR-1)
  // ------------------------------------------------------------------

  async login(
    dto: NativeLoginDto,
    ipHash: string | null,
  ): Promise<{ sessionToken: string; context: SessionContext }> {
    const shopId = await this.resolveShopId(dto.shopId, dto.shopDomain);
    const fail = async (reason: string, memberId: string | null, resolvedShopId: string | null): Promise<never> => {
      // OVR-1: EVERY native login attempt is audited — success and failure.
      await this.audit.record({
        shopId: resolvedShopId,
        actorKind: memberId ? 'MEMBER' : 'SYSTEM',
        actorId: memberId,
        action: 'native_login.failure',
        objectType: 'shop_member',
        objectId: memberId,
        after: { email_hash: saltedPiiHash(this.piiSalt, dto.email) },
        reason,
        ipHash,
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    };

    if (!shopId) {
      await argon2.verify(DUMMY_ARGON2_HASH, dto.password); // timing equalization
      return fail('invalid_credentials', null, null);
    }

    const { rows } = await this.pool.query<MemberCredentialRow>(
      `SELECT m.member_id, m.role, c.password_hash, c.totp_secret_encrypted,
              c.totp_confirmed, c.locked_until
         FROM shop_member m
         JOIN member_credential c ON c.member_id = m.member_id
        WHERE m.shop_id = $1 AND lower(m.email) = lower($2)
          AND m.auth_source = 'NATIVE' AND m.revoked_at IS NULL`,
      [shopId, dto.email],
    );
    const member = rows[0];
    if (!member || !member.password_hash) {
      await argon2.verify(DUMMY_ARGON2_HASH, dto.password); // timing equalization
      return fail('invalid_credentials', null, shopId);
    }

    // OVR-1 lockout: LOCK_THRESHOLD bad passwords lock the credential for
    // LOCK_MINUTES minutes (see native-auth.constants.ts for the rationale).
    if (member.locked_until && member.locked_until.getTime() > Date.now()) {
      return fail('locked', member.member_id, shopId);
    }

    const passwordOk = await argon2.verify(member.password_hash, dto.password);
    if (!passwordOk) {
      await this.pool.query(
        `UPDATE member_credential
            SET failed_attempts = failed_attempts + 1,
                locked_until = CASE
                  WHEN failed_attempts + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
                  ELSE locked_until
                END,
                version = version + 1
          WHERE member_id = $1`,
        [member.member_id, LOCK_THRESHOLD, String(LOCK_MINUTES)],
      );
      return fail('invalid_credentials', member.member_id, shopId);
    }

    // Mandatory 2FA (OVR-1): no password login before TOTP is confirmed.
    if (!member.totp_confirmed) {
      await this.audit.record({
        shopId,
        actorKind: 'MEMBER',
        actorId: member.member_id,
        action: 'native_login.failure',
        objectType: 'shop_member',
        objectId: member.member_id,
        after: { email_hash: saltedPiiHash(this.piiSalt, dto.email) },
        reason: 'totp_not_enrolled',
        ipHash,
      });
      throw new UnauthorizedException('TOTP enrollment required before password login');
    }
    if (!dto.totpCode) {
      await this.audit.record({
        shopId,
        actorKind: 'MEMBER',
        actorId: member.member_id,
        action: 'native_login.failure',
        objectType: 'shop_member',
        objectId: member.member_id,
        after: { email_hash: saltedPiiHash(this.piiSalt, dto.email) },
        reason: 'totp_required',
        ipHash,
      });
      throw new UnauthorizedException('TOTP code required');
    }
    const secret = this.cipher.decrypt(member.totp_secret_encrypted as Buffer).toString('utf8');
    if (!this.totp.verify({ token: dto.totpCode, secret })) {
      await this.audit.record({
        shopId,
        actorKind: 'MEMBER',
        actorId: member.member_id,
        action: 'native_login.failure',
        objectType: 'shop_member',
        objectId: member.member_id,
        after: { email_hash: saltedPiiHash(this.piiSalt, dto.email) },
        reason: 'totp_invalid',
        ipHash,
      });
      throw new UnauthorizedException('invalid TOTP code');
    }

    await this.pool.query(
      `UPDATE member_credential
          SET failed_attempts = 0, locked_until = NULL, version = version + 1
        WHERE member_id = $1`,
      [member.member_id],
    );
    const { token, context } = await this.sessions.create({
      shopId,
      memberId: member.member_id,
      role: member.role,
      authSource: 'NATIVE',
      ipHash,
    });
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: member.member_id,
      action: 'native_login.success',
      objectType: 'shop_member',
      objectId: member.member_id,
      after: { method: 'password' },
      ipHash,
    });
    return { sessionToken: token, context };
  }

  // ------------------------------------------------------------------
  // Magic link (single-use, OVR-1)
  // ------------------------------------------------------------------

  async requestMagicLink(
    dto: MagicLinkRequestDto,
    ipHash: string | null,
  ): Promise<{ devHandoffToken: string | null }> {
    const shopId = await this.resolveShopId(dto.shopId, dto.shopDomain);
    if (!shopId) return { devHandoffToken: null }; // timing-safe: same response shape

    const { rows } = await this.pool.query<{ member_id: string }>(
      `SELECT member_id FROM shop_member
        WHERE shop_id = $1 AND lower(email) = lower($2)
          AND auth_source = 'NATIVE' AND revoked_at IS NULL`,
      [shopId, dto.email],
    );
    if (rows.length === 0) return { devHandoffToken: null };

    const token = randomToken(32);
    await this.pool.query(
      `INSERT INTO magic_link_token (shop_id, member_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
      [shopId, rows[0].member_id, tokenHash(token), String(MAGIC_LINK_TTL_MINUTES)],
    );
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: rows[0].member_id,
      action: 'native_magic_link.requested',
      objectType: 'magic_link_token',
      after: { email_hash: saltedPiiHash(this.piiSalt, dto.email) },
      ipHash,
    });
    return { devHandoffToken: token };
  }

  async consumeMagicLink(
    token: string,
    ipHash: string | null,
  ): Promise<{ sessionToken: string; context: SessionContext }> {
    // Atomic single-use: the UPDATE ... WHERE used_at IS NULL claims the token;
    // a concurrent second consume matches no row (OVR-1 single-use magic link).
    const { rows } = await this.pool.query<{
      token_id: string;
      shop_id: string;
      member_id: string;
    }>(
      `UPDATE magic_link_token
          SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING token_id, shop_id, member_id`,
      [tokenHash(token)],
    );
    const claimed = rows[0];
    if (!claimed) {
      await this.audit.record({
        actorKind: 'SYSTEM',
        action: 'native_login.failure',
        objectType: 'magic_link_token',
        reason: 'magic_link_invalid',
        ipHash,
      });
      throw new UnauthorizedException(INVALID_TOKEN);
    }

    const member = await this.pool.query<{ role: MemberRole }>(
      `SELECT role FROM shop_member
        WHERE member_id = $1 AND shop_id = $2 AND auth_source = 'NATIVE' AND revoked_at IS NULL`,
      [claimed.member_id, claimed.shop_id],
    );
    if (member.rows.length === 0) {
      await this.audit.record({
        shopId: claimed.shop_id,
        actorKind: 'SYSTEM',
        action: 'native_login.failure',
        objectType: 'shop_member',
        objectId: claimed.member_id,
        reason: 'member_revoked',
        ipHash,
      });
      throw new UnauthorizedException(INVALID_TOKEN);
    }

    const created = await this.sessions.create({
      shopId: claimed.shop_id,
      memberId: claimed.member_id,
      role: member.rows[0].role,
      authSource: 'NATIVE',
      ipHash,
    });
    // OVR-1: a magic-link login counts as a native login in the audit trail.
    await this.audit.record({
      shopId: claimed.shop_id,
      actorKind: 'MEMBER',
      actorId: claimed.member_id,
      action: 'native_login.success',
      objectType: 'shop_member',
      objectId: claimed.member_id,
      after: { method: 'magic_link' },
      ipHash,
    });
    return { sessionToken: created.token, context: created.context };
  }

  // ------------------------------------------------------------------
  // Password reset (OVR-1); consume kills every session (RW-04)
  // ------------------------------------------------------------------

  async requestPasswordReset(
    dto: PasswordResetRequestDto,
    ipHash: string | null,
  ): Promise<{ devHandoffToken: string | null }> {
    const shopId = await this.resolveShopId(dto.shopId, dto.shopDomain);
    if (!shopId) return { devHandoffToken: null };

    const { rows } = await this.pool.query<{ member_id: string }>(
      `SELECT member_id FROM shop_member
        WHERE shop_id = $1 AND lower(email) = lower($2)
          AND auth_source = 'NATIVE' AND revoked_at IS NULL`,
      [shopId, dto.email],
    );
    if (rows.length === 0) return { devHandoffToken: null };

    const token = randomToken(32);
    await this.pool.query(
      `UPDATE member_credential
          SET password_reset_token_hash = $2,
              password_reset_expires_at = now() + ($3 || ' hours')::interval,
              version = version + 1
        WHERE member_id = $1`,
      [rows[0].member_id, tokenHash(token), String(PASSWORD_RESET_TTL_HOURS)],
    );
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: rows[0].member_id,
      action: 'native_password_reset.requested',
      objectType: 'member_credential',
      objectId: rows[0].member_id,
      ipHash,
    });
    return { devHandoffToken: token };
  }

  async consumePasswordReset(dto: PasswordResetConsumeDto, ipHash: string | null): Promise<void> {
    const { rows } = await this.pool.query<{ member_id: string; shop_id: string }>(
      `SELECT c.member_id, m.shop_id
         FROM member_credential c
         JOIN shop_member m ON m.member_id = c.member_id
        WHERE c.password_reset_token_hash = $1
          AND c.password_reset_expires_at > now()
          AND m.auth_source = 'NATIVE' AND m.revoked_at IS NULL`,
      [tokenHash(dto.token)],
    );
    const row = rows[0];
    if (!row) {
      await this.audit.record({
        actorKind: 'SYSTEM',
        action: 'native_password_reset.consume_failed',
        objectType: 'member_credential',
        reason: 'token_invalid',
        ipHash,
      });
      throw new UnauthorizedException(INVALID_TOKEN);
    }
    if (dto.newPassword.length < PASSWORD_MIN_LENGTH) {
      throw new BadRequestException(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    }

    const passwordHash = await argon2.hash(dto.newPassword);
    await this.pool.query(
      `UPDATE member_credential
          SET password_hash = $2,
              password_reset_token_hash = NULL,
              password_reset_expires_at = NULL,
              failed_attempts = 0,
              locked_until = NULL,
              version = version + 1
        WHERE member_id = $1`,
      [row.member_id, passwordHash],
    );
    // OVR-1 + RW-04: a password reset kills every existing session.
    await this.sessions.invalidateMember(row.member_id, 'PASSWORD_RESET');
    await this.audit.record({
      shopId: row.shop_id,
      actorKind: 'MEMBER',
      actorId: row.member_id,
      action: 'native_password_reset.consumed',
      objectType: 'member_credential',
      objectId: row.member_id,
      ipHash,
    });
  }

  // ------------------------------------------------------------------
  // Logout (both auth sources, §9.1.4)
  // ------------------------------------------------------------------

  async logout(session: SessionContext, ipHash: string | null): Promise<void> {
    await this.sessions.invalidateSession(session.sessionId, 'LOGOUT');
    await this.audit.record({
      shopId: session.shopId,
      actorKind: 'MEMBER',
      actorId: session.memberId,
      action: 'auth.logout',
      objectType: 'member_session',
      objectId: session.sessionId,
      ipHash,
    });
  }

  // ------------------------------------------------------------------

  private requireOwner(session: SessionContext): void {
    if (session.role !== 'OWNER') throw new ForbiddenException('owner role required');
  }

  /** The login page knows its shop; accept either the id or the myshopify domain. */
  private async resolveShopId(shopId?: string, shopDomain?: string): Promise<string | null> {
    if (shopId) {
      const { rows } = await this.pool.query<{ shop_id: string }>(
        `SELECT shop_id FROM shop WHERE shop_id = $1`,
        [shopId],
      );
      return rows[0]?.shop_id ?? null;
    }
    if (shopDomain) {
      const { rows } = await this.pool.query<{ shop_id: string }>(
        `SELECT shop_id FROM shop WHERE lower(myshopify_domain) = lower($1)`,
        [shopDomain],
      );
      return rows[0]?.shop_id ?? null;
    }
    return null;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
