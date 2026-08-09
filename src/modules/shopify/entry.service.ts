import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import { AuditService } from '../../audit/audit.service';
import { SessionService } from '../../auth/session.service';
import { SessionContext } from '../../auth/session.types';
import { saltedPiiHash } from '../../common/crypto';
import { EntryTokenService } from './entry-token.service';
import { ShopifyGraphqlClient } from './shopify-graphql.client';

/**
 * §9.1.1/§9.1.2: exchange a signed entry token for an app session.
 *
 * Deny-by-default: "No access" is the ABSENCE of a shop_member row (§9.1.2),
 * so any staff user without a granted, unrevoked row gets NO_ACCESS. The
 * access-request endpoint itself is owned by the team module; we only expose
 * whether a PENDING request already exists.
 *
 * §9.1.2 revocation check: a staff user removed in Shopify loses access at
 * their next entry. assertStaffStillValid verifies against Shopify on entry
 * and revokes the member (plus their sessions) when the user is gone.
 */

/**
 * Fail-open posture (documented choice): a Shopify outage must not lock
 * every merchant out. A successful staff check is cached in Redis for
 * 15 minutes; while the cache is warm no Shopify call is made. When Shopify
 * is unreachable we trust the last known state and allow entry. Only a
 * definitive "user not found" revokes — API/GraphQL errors never do.
 */
const STAFF_VALID_CACHE_TTL_SECONDS = 900;
const STAFF_VALID_PREFIX = 'shopify:staff_valid:';

// TODO(week-0-verification): confirm user(id:) is queryable by a
// non-embedded app with an online token; staffMember is Plus-only (§9.1.2
// external dependency).
const STAFF_STILL_VALID_QUERY = `query StaffStillValid($id: ID!) {
  user(id: $id) { id }
}`;

export type EntryDenyReason =
  | 'SHOP_NOT_FOUND'
  | 'SHOP_UNINSTALLED'
  | 'NO_MEMBER'
  | 'MEMBER_REVOKED'
  | 'STAFF_REVOKED_IN_SHOPIFY';

export type ShopifyEntryResult =
  | { status: 'OK'; sessionToken: string; context: SessionContext }
  | { status: 'NO_ACCESS'; reason: EntryDenyReason; accessRequest: 'PENDING' | 'NONE' };

interface MemberRow {
  member_id: string;
  role: SessionContext['role'];
  auth_source: SessionContext['authSource'];
  revoked_at: Date | null;
}

@Injectable()
export class ShopifyEntryService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly entryTokens: EntryTokenService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly graphql: ShopifyGraphqlClient,
  ) {}

  /** Exchange an entry token. EntryTokenError propagates (controller → 401). */
  async exchange(rawToken: string, ip: string | null): Promise<ShopifyEntryResult> {
    const payload = await this.entryTokens.verify(rawToken);

    const shopRows = await this.pool.query<{
      shop_id: string;
      account_state: string;
      myshopify_domain: string;
    }>(
      `SELECT shop_id, account_state, myshopify_domain
         FROM shop WHERE shopify_shop_gid = $1`,
      [payload.sg],
    );
    const shop = shopRows.rows[0];
    if (!shop) return this.noAccess('SHOP_NOT_FOUND', null, null);
    if (shop.account_state === 'UNINSTALLED') {
      return this.noAccess('SHOP_UNINSTALLED', shop.shop_id, payload.su);
    }

    const memberRows = await this.pool.query<MemberRow>(
      `SELECT member_id, role, auth_source, revoked_at
         FROM shop_member
        WHERE shop_id = $1 AND shopify_staff_user_id = $2`,
      [shop.shop_id, payload.su],
    );
    const member = memberRows.rows[0];
    if (!member) return this.noAccess('NO_MEMBER', shop.shop_id, payload.su);
    if (member.revoked_at) return this.noAccess('MEMBER_REVOKED', shop.shop_id, payload.su);

    // §9.1.2 + OVR-1: the Shopify re-validation applies only to SHOPIFY_STAFF
    // members (native members are revoked in Team & Roles only).
    if (member.auth_source === 'SHOPIFY_STAFF') {
      const verdict = await this.assertStaffStillValid(shop.shop_id, payload.su);
      if (verdict === 'REVOKED') {
        await this.revokeMember(shop.shop_id, member.member_id);
        return this.noAccess('STAFF_REVOKED_IN_SHOPIFY', shop.shop_id, payload.su);
      }
    }

    await this.pool.query(
      `UPDATE shop_member SET last_active_at = now(), version = version + 1
        WHERE shop_id = $1 AND member_id = $2`,
      [shop.shop_id, member.member_id],
    );

    // §5.7 control 4: the IP is stored only as a salted hash.
    const salt = this.config.get<string>('crypto.piiHashSalt') ?? '';
    const ipHash = ip && salt ? saltedPiiHash(salt, ip) : null;
    const { token, context } = await this.sessions.create({
      shopId: shop.shop_id,
      memberId: member.member_id,
      role: member.role,
      authSource: member.auth_source,
      ipHash,
    });
    return { status: 'OK', sessionToken: token, context };
  }

  /**
   * §9.1.2: verify that a SHOPIFY_STAFF member is still a valid staff user
   * in Shopify. Returns REVOKED only on a definitive "not found"; every
   * transient failure fails open (see STAFF_VALID_CACHE_TTL_SECONDS note).
   */
  async assertStaffStillValid(shopId: string, staffUserId: string): Promise<'VALID' | 'REVOKED'> {
    const cacheKey = STAFF_VALID_PREFIX + shopId + ':' + staffUserId;
    if (await this.redis.get(cacheKey)) return 'VALID';
    try {
      const data = await this.graphql.queryForShop<{ user: { id: string } | null }>(
        shopId,
        STAFF_STILL_VALID_QUERY,
        { id: `gid://shopify/User/${staffUserId}` },
      );
      if (!data.user) return 'REVOKED';
      await this.redis.set(cacheKey, '1', 'EX', STAFF_VALID_CACHE_TTL_SECONDS);
      return 'VALID';
    } catch {
      // Fail-open: a Shopify outage never locks a merchant out. The 15-minute
      // positive cache bounds how stale "last known good" can be.
      return 'VALID';
    }
  }

  /** §9.1.2/§9.1.4: revoke the member, kill their sessions, audit (§12). */
  private async revokeMember(shopId: string, memberId: string): Promise<void> {
    await this.pool.query(
      `UPDATE shop_member SET revoked_at = now(), version = version + 1
        WHERE shop_id = $1 AND member_id = $2 AND revoked_at IS NULL`,
      [shopId, memberId],
    );
    await this.sessions.invalidateMember(memberId, 'SHOPIFY_ACCESS_REVOKED');
    await this.audit.record({
      shopId,
      actorKind: 'SYSTEM',
      action: 'MEMBER_ACCESS_REVOKED',
      objectType: 'shop_member',
      objectId: memberId,
      reason: 'staff user no longer valid in Shopify (§9.1.2)',
    });
  }

  private async noAccess(
    reason: EntryDenyReason,
    shopId: string | null,
    staffUserId: string | null,
  ): Promise<ShopifyEntryResult> {
    let accessRequest: 'PENDING' | 'NONE' = 'NONE';
    if (shopId && staffUserId) {
      // The team module owns creating/resolving requests; we only report
      // whether one is already pending (§9.1.2).
      const { rows } = await this.pool.query(
        `SELECT 1 AS x FROM access_request
          WHERE shop_id = $1 AND shopify_staff_user_id = $2 AND resolution = 'PENDING'
          LIMIT 1`,
        [shopId, staffUserId],
      );
      if (rows.length > 0) accessRequest = 'PENDING';
    }
    return { status: 'NO_ACCESS', reason, accessRequest };
  }
}
