import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS } from '../../redis/redis.module';
import { hmacSha256Hex, randomToken, safeEqualHex } from '../../common/crypto';

/**
 * Signed Shopify-entry tokens (§9.1.1, §5.7 control 6).
 *
 * The Shopify OAuth callback (or the admin companion page) hands the browser
 * a short-lived, HMAC-signed token; `POST /auth/shopify-entry` exchanges it
 * for a real app session. Payload: shop GID, Shopify staff-user id, expiry,
 * nonce. The nonce is stored in Redis and consumed atomically on first use,
 * so a token can never be replayed.
 */

export const ENTRY_TOKEN_TTL_SECONDS = 300; // 5 minutes (§9.1.1: short-lived)

const NONCE_PREFIX = 'shopify:entry_nonce:';

export interface EntryTokenPayload {
  /** shopify_shop_gid */
  sg: string;
  /** shopify_staff_user_id */
  su: string;
  /** expiry, epoch seconds */
  exp: number;
  nonce: string;
}

export type EntryTokenErrorCode = 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' | 'REPLAYED';

export class EntryTokenError extends Error {
  constructor(
    readonly code: EntryTokenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EntryTokenError';
  }
}

@Injectable()
export class EntryTokenService {
  private readonly secret: string;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService,
  ) {
    // Signed with the app credential; entry tokens are our own artifact, so
    // the Shopify API secret is the signing key (§5.7 control 6).
    this.secret = config.get<string>('shopify.apiSecret') ?? '';
  }

  async issue(
    shopGid: string,
    staffUserId: string,
  ): Promise<{ token: string; expiresInSeconds: number }> {
    const payload: EntryTokenPayload = {
      sg: shopGid,
      su: staffUserId,
      exp: Math.floor(Date.now() / 1000) + ENTRY_TOKEN_TTL_SECONDS,
      nonce: randomToken(16),
    };
    // The nonce is bound to the shop GID so a token minted for one shop can
    // never be consumed against another (INV-1).
    await this.redis.set(NONCE_PREFIX + payload.nonce, shopGid, 'EX', ENTRY_TOKEN_TTL_SECONDS);
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return { token: `${body}.${hmacSha256Hex(this.secret, body)}`, expiresInSeconds: ENTRY_TOKEN_TTL_SECONDS };
  }

  /** Verify signature, expiry and single-use nonce. Throws EntryTokenError. */
  async verify(raw: string): Promise<EntryTokenPayload> {
    const dot = raw.lastIndexOf('.');
    if (dot <= 0 || dot === raw.length - 1) {
      throw new EntryTokenError('MALFORMED', 'entry token is malformed');
    }
    const body = raw.slice(0, dot);
    const signature = raw.slice(dot + 1);
    if (!safeEqualHex(hmacSha256Hex(this.secret, body), signature)) {
      throw new EntryTokenError('BAD_SIGNATURE', 'entry token signature mismatch');
    }
    let payload: EntryTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as EntryTokenPayload;
    } catch {
      throw new EntryTokenError('MALFORMED', 'entry token payload is not JSON');
    }
    if (
      typeof payload.sg !== 'string' ||
      typeof payload.su !== 'string' ||
      typeof payload.exp !== 'number' ||
      typeof payload.nonce !== 'string'
    ) {
      throw new EntryTokenError('MALFORMED', 'entry token payload is incomplete');
    }
    if (payload.exp * 1000 <= Date.now()) {
      throw new EntryTokenError('EXPIRED', 'entry token has expired');
    }
    // Single use: the nonce must exist (not replayed, not lapsed) and belong
    // to the shop named in the payload.
    const bound = await this.redis.getdel(NONCE_PREFIX + payload.nonce);
    if (bound === null || bound !== payload.sg) {
      throw new EntryTokenError('REPLAYED', 'entry token nonce already used or unknown');
    }
    return payload;
  }
}
