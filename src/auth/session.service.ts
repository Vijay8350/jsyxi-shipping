import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL } from '../database/database.module';
import { REDIS } from '../redis/redis.module';
import { randomToken, tokenHash } from '../common/crypto';
import {
  AuthSource,
  InvalidateReason,
  MemberRole,
  SessionContext,
} from './session.types';

/**
 * Server-side sessions (plan ambiguity A-8: Redis for fast lookup + a DB row
 * for audit and invalidation). 12-hour inactivity TTL, sliding (RW-04).
 *
 * Invalidation is driven by events, not by Shopify polling: uninstall,
 * Shopify access revocation, role revocation, Owner transfer and native
 * member revocation all call the invalidate* methods (§9.1.4, OVR-1).
 */

const KEY_PREFIX = 'sess:';
const BY_MEMBER_PREFIX = 'sess_by_member:';
const BY_SHOP_PREFIX = 'sess_by_shop:';
/** Throttle last_active_at writes to at most one per minute per session. */
const ACTIVITY_WRITE_INTERVAL_MS = 60_000;

@Injectable()
export class SessionService {
  private readonly ttlSeconds: number;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.ttlSeconds = config.get<number>('session.ttlSeconds') ?? 43200;
  }

  async create(input: {
    shopId: string;
    memberId: string;
    role: MemberRole;
    authSource: AuthSource;
    ipHash?: string | null;
  }): Promise<{ token: string; context: SessionContext }> {
    const token = randomToken(32);
    const hash = tokenHash(token);
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);

    const { rows } = await this.pool.query<{ session_id: string }>(
      `INSERT INTO member_session
         (shop_id, member_id, token_hash, auth_source, expires_at, ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING session_id`,
      [input.shopId, input.memberId, hash, input.authSource, expiresAt, input.ipHash ?? null],
    );

    const context: SessionContext = {
      sessionId: rows[0].session_id,
      shopId: input.shopId,
      memberId: input.memberId,
      role: input.role,
      authSource: input.authSource,
    };
    await this.cache(context, hash);
    return { token, context };
  }

  /** Resolve a session token; refreshes the sliding TTL on activity. */
  async resolve(token: string): Promise<SessionContext | null> {
    const hash = tokenHash(token);
    const cached = await this.redis.get(KEY_PREFIX + hash);
    if (cached) {
      const context = JSON.parse(cached) as SessionContext;
      await this.touch(context, hash);
      return context;
    }

    const { rows } = await this.pool.query<{
      session_id: string;
      shop_id: string;
      member_id: string;
      auth_source: AuthSource;
      role: MemberRole;
    }>(
      `SELECT s.session_id, s.shop_id, s.member_id, s.auth_source, m.role
         FROM member_session s
         JOIN shop_member m ON m.member_id = s.member_id
        WHERE s.token_hash = $1
          AND s.invalidated_at IS NULL
          AND s.expires_at > now()
          AND m.revoked_at IS NULL`,
      [hash],
    );
    if (rows.length === 0) return null;

    const context: SessionContext = {
      sessionId: rows[0].session_id,
      shopId: rows[0].shop_id,
      memberId: rows[0].member_id,
      role: rows[0].role,
      authSource: rows[0].auth_source,
    };
    await this.cache(context, hash);
    return context;
  }

  async invalidateSession(sessionId: string, reason: InvalidateReason): Promise<void> {
    const { rows } = await this.pool.query<{ token_hash: string; member_id: string; shop_id: string }>(
      `UPDATE member_session
          SET invalidated_at = now(), invalidate_reason = $2
        WHERE session_id = $1 AND invalidated_at IS NULL
        RETURNING token_hash, member_id, shop_id`,
      [sessionId, reason],
    );
    for (const row of rows) await this.evict(row.token_hash, row.member_id, row.shop_id);
  }

  async invalidateMember(memberId: string, reason: InvalidateReason): Promise<void> {
    const { rows } = await this.pool.query<{ token_hash: string; shop_id: string }>(
      `UPDATE member_session
          SET invalidated_at = now(), invalidate_reason = $2
        WHERE member_id = $1 AND invalidated_at IS NULL
        RETURNING token_hash, shop_id`,
      [memberId, reason],
    );
    for (const row of rows) await this.evict(row.token_hash, memberId, row.shop_id);
  }

  async invalidateShop(shopId: string, reason: InvalidateReason): Promise<void> {
    const { rows } = await this.pool.query<{ token_hash: string; member_id: string }>(
      `UPDATE member_session
          SET invalidated_at = now(), invalidate_reason = $2
        WHERE shop_id = $1 AND invalidated_at IS NULL
        RETURNING token_hash, member_id`,
      [shopId, reason],
    );
    for (const row of rows) await this.evict(row.token_hash, row.member_id, shopId);
  }

  private async cache(context: SessionContext, hash: string): Promise<void> {
    await this.redis
      .multi()
      .set(KEY_PREFIX + hash, JSON.stringify(context), 'EX', this.ttlSeconds)
      .sadd(BY_MEMBER_PREFIX + context.memberId, hash)
      .sadd(BY_SHOP_PREFIX + context.shopId, hash)
      .exec();
  }

  private async touch(context: SessionContext, hash: string): Promise<void> {
    await this.redis.expire(KEY_PREFIX + hash, this.ttlSeconds);
    const { rowCount } = await this.pool.query(
      `UPDATE member_session
          SET last_active_at = now(), expires_at = now() + ($2 || ' seconds')::interval
        WHERE session_id = $1
          AND last_active_at < now() - ($3 || ' milliseconds')::interval`,
      [context.sessionId, String(this.ttlSeconds), String(ACTIVITY_WRITE_INTERVAL_MS)],
    );
    void rowCount;
  }

  private async evict(hash: string, memberId: string, shopId: string): Promise<void> {
    await this.redis
      .multi()
      .del(KEY_PREFIX + hash)
      .srem(BY_MEMBER_PREFIX + memberId, hash)
      .srem(BY_SHOP_PREFIX + shopId, hash)
      .exec();
  }
}
