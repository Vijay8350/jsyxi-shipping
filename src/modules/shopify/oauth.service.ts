import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import { AuditService } from '../../audit/audit.service';
import { EnvelopeCipher } from '../../common/envelope';
import { hmacSha256Hex, randomToken, safeEqualHex } from '../../common/crypto';
import { EntryTokenService } from './entry-token.service';
import { ShopifyGraphqlClient } from './shopify-graphql.client';
import { ShopifyWebhookRegistrationService } from './webhook-registration.service';

/**
 * Shopify OAuth install flow (§9.1.1).
 *
 * GET /shopify/install  → validate domain, store a single-use state nonce in
 *                         Redis (10 min), redirect to Shopify's authorize URL.
 * GET /shopify/callback → verify HMAC (constant-time), consume the nonce,
 *                         exchange the code for an ONLINE-MODE access token
 *                         (per §9.1.2's per-staff identity requirement), read
 *                         shop info over GraphQL, enforce INV-2 (INR only),
 *                         then upsert shop / seed settings / create the Owner
 *                         member and mint an entry token.
 *
 * §9.1.2 external dependency: per-staff identity for a non-embedded app comes
 * from `associated_user` on the online token response. If it is absent we do
 * NOT fall back to shop-level access — the shop row is persisted, the gap is
 * audited, and entry is denied until the week-0 verification resolves it.
 */

const STATE_TTL_SECONDS = 600; // 10 minutes
const STATE_PREFIX = 'shopify:oauth_state:';
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

const MYSHOPIFY_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

const SHOP_INFO_QUERY = `query ShopInfo {
  shop { id myshopifyDomain ianaTimezone currencyCode }
}`;

export interface ShopifyTokenResponse {
  access_token: string;
  scope: string;
  /** Present on online-mode (per-user) tokens — §9.1.2 external dependency. */
  associated_user_scope?: string;
  associated_user?: {
    id: number;
    first_name?: string;
    last_name?: string;
    email?: string;
    account_owner?: boolean;
    locale?: string;
    collaborator?: boolean;
  };
}

export interface ShopInfo {
  shop: {
    id: string;
    myshopifyDomain: string;
    ianaTimezone: string;
    currencyCode: string;
  };
}

export type ShopifyOAuthErrorCode =
  | 'INVALID_SHOP_DOMAIN'
  | 'BAD_HMAC'
  | 'BAD_STATE'
  | 'TOKEN_EXCHANGE_FAILED'
  | 'CURRENCY_NOT_INR'
  | 'STAFF_IDENTITY_UNAVAILABLE'
  | 'SHOPIFY_API';

export class ShopifyOAuthError extends Error {
  constructor(
    readonly code: ShopifyOAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ShopifyOAuthError';
  }
}

/** Shopify's callback HMAC message: sorted `key=value` pairs joined with '&', excluding hmac/signature. */
export function buildCallbackMessage(query: Record<string, string>): string {
  return Object.keys(query)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&');
}

/** Constant-time HMAC verification of the OAuth callback query (§9.1.1). */
export function verifyCallbackHmac(query: Record<string, string>, secret: string): boolean {
  const hmac = query.hmac;
  if (!hmac) return false;
  return safeEqualHex(hmacSha256Hex(secret, buildCallbackMessage(query)), hmac);
}

@Injectable()
export class ShopifyOAuthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly entryTokens: EntryTokenService,
    private readonly audit: AuditService,
    private readonly graphql: ShopifyGraphqlClient,
    private readonly webhooks: ShopifyWebhookRegistrationService,
  ) {}

  /** §9.1.1: validate the shop domain and build the authorize redirect. */
  async beginInstall(rawDomain: string | undefined): Promise<string> {
    const domain = (rawDomain ?? '').trim().toLowerCase();
    if (!MYSHOPIFY_DOMAIN.test(domain)) {
      throw new ShopifyOAuthError('INVALID_SHOP_DOMAIN', 'invalid myshopify domain');
    }
    const nonce = randomToken(16);
    await this.redis.set(STATE_PREFIX + nonce, domain, 'EX', STATE_TTL_SECONDS);

    const apiKey = this.config.get<string>('shopify.apiKey') ?? '';
    const scopes = this.config.get<string[]>('shopify.scopes') ?? [];
    const appUrl = this.config.get<string>('shopify.appUrl') ?? '';
    const params = new URLSearchParams({
      client_id: apiKey,
      scope: scopes.join(','),
      redirect_uri: `${appUrl}/shopify/callback`,
      state: nonce,
    });
    // §9.1.2 external dependency: request online-mode (per-user) tokens so
    // the token response carries `associated_user`. TODO(week-0-verification):
    // confirm online tokens remain available to non-embedded apps.
    params.append('grant_options[]', 'per-user');
    return `https://${domain}/admin/oauth/authorize?${params.toString()}`;
  }

  /** §9.1.1: verify, exchange, enforce INV-2, persist, and mint an entry token. */
  async handleCallback(
    query: Record<string, string>,
  ): Promise<{ entryToken: string; expiresInSeconds: number }> {
    const apiSecret = this.config.get<string>('shopify.apiSecret') ?? '';
    if (!verifyCallbackHmac(query, apiSecret)) {
      throw new ShopifyOAuthError('BAD_HMAC', 'callback HMAC verification failed');
    }
    const domain = (query.shop ?? '').trim().toLowerCase();
    if (!MYSHOPIFY_DOMAIN.test(domain) || !query.code || !query.state) {
      throw new ShopifyOAuthError('BAD_STATE', 'callback parameters are incomplete');
    }
    // Single-use state nonce, bound to the shop domain it was issued for.
    const stored = await this.redis.getdel(STATE_PREFIX + query.state);
    if (stored === null || stored !== domain) {
      throw new ShopifyOAuthError('BAD_STATE', 'OAuth state nonce is unknown or already used');
    }

    const tokenResponse = await this.exchangeCode(domain, query.code);
    const shopInfo = await this.graphql.queryWithToken<ShopInfo>(
      domain,
      tokenResponse.access_token,
      SHOP_INFO_QUERY,
    );

    // INV-2: INR-only product. Persist nothing and say so plainly.
    if (shopInfo.shop.currencyCode !== 'INR') {
      await this.audit.record({
        shopId: null,
        actorKind: 'SYSTEM',
        action: 'SHOP_INSTALL_BLOCKED',
        objectType: 'shop',
        objectId: shopInfo.shop.id,
        reason: 'shop currency is not INR; onboarding blocked (INV-2)',
      });
      throw new ShopifyOAuthError(
        'CURRENCY_NOT_INR',
        'Jsyxi Shipping supports INR stores only; onboarding is blocked (INV-2)',
      );
    }

    const shopId = await this.upsertShop(
      shopInfo.shop,
      tokenResponse.access_token,
    );
    await this.seedStoreSettings(shopId, shopInfo.shop.ianaTimezone);
    await this.seedOnboardingRows(shopId);
    await this.subscribeWebhooks(shopId);

    // §9.1.2: staff identity comes from exactly one place.
    const staff = resolveStaffIdentity(tokenResponse);
    if (!staff) {
      // TODO(week-0-verification): per-staff identity unavailable in this
      // entry model. Per §9.1.2 we escalate instead of silently falling back
      // to shop-level access: the shop row exists, but no member is created
      // and no entry token is minted.
      await this.audit.record({
        shopId,
        actorKind: 'SYSTEM',
        action: 'STAFF_IDENTITY_UNAVAILABLE',
        objectType: 'shop',
        objectId: shopId,
        reason:
          'associated_user absent from online token response; entry denied pending week-0 verification (§9.1.2)',
      });
      throw new ShopifyOAuthError(
        'STAFF_IDENTITY_UNAVAILABLE',
        'per-staff identity unavailable from Shopify — escalate (no shop-level fallback, §9.1.2)',
      );
    }

    await this.upsertStaffMember(shopId, staff.staffUserId);

    await this.audit.record({
      shopId,
      actorKind: 'SYSTEM',
      action: 'SHOP_INSTALLED',
      objectType: 'shop',
      objectId: shopId,
      after: {
        account_state: 'TRIALING',
        myshopify_domain: shopInfo.shop.myshopifyDomain,
        iana_timezone: shopInfo.shop.ianaTimezone,
      },
    });

    const issued = await this.entryTokens.issue(shopInfo.shop.id, staff.staffUserId);
    return { entryToken: issued.token, expiresInSeconds: issued.expiresInSeconds };
  }

  /**
   * §8.1: subscribe the shop to every handled topic. Runs after the credential
   * is persisted, because the subscription calls authenticate as the shop.
   *
   * Deliberately non-fatal. A Shopify hiccup here must not strand a merchant
   * mid-install with a shop row and no way in — and the sync is idempotent, so
   * it can be retried. The failure is audited by the registration service
   * (SHOPIFY_WEBHOOKS_SYNC_PARTIAL / _FAILED) rather than swallowed, because a
   * shop with no subscriptions never syncs an order and that must be visible.
   */
  private async subscribeWebhooks(shopId: string): Promise<void> {
    try {
      await this.webhooks.syncForShop(shopId);
    } catch (err) {
      await this.audit.record({
        shopId,
        actorKind: 'SYSTEM',
        action: 'SHOPIFY_WEBHOOKS_SYNC_FAILED',
        objectType: 'shop',
        objectId: shopId,
        reason: `webhook subscription failed at install: ${(err as Error).message}`,
      });
    }
  }

  private async exchangeCode(domain: string, code: string): Promise<ShopifyTokenResponse> {
    const apiKey = this.config.get<string>('shopify.apiKey') ?? '';
    const apiSecret = this.config.get<string>('shopify.apiSecret') ?? '';
    let res: Response;
    try {
      res = await fetch(`https://${domain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: apiKey,
          client_secret: apiSecret,
          code,
          'grant_options[]': 'per-user',
        }),
        signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
      });
    } catch {
      throw new ShopifyOAuthError('TOKEN_EXCHANGE_FAILED', 'token exchange request failed');
    }
    if (!res.ok) {
      throw new ShopifyOAuthError('TOKEN_EXCHANGE_FAILED', `token exchange HTTP ${res.status}`);
    }
    const body = (await res.json()) as ShopifyTokenResponse;
    if (!body.access_token) {
      throw new ShopifyOAuthError('TOKEN_EXCHANGE_FAILED', 'token exchange returned no access token');
    }
    return body;
  }

  /**
   * Upsert the shop. The access token is envelope-encrypted before it
   * touches the database (§5.7 control 1) and is never logged (INV-18).
   * A reinstall is a fresh connection (§9.1.5): state resets to TRIALING and
   * uninstalled_at clears — never a restore of the old cycle.
   */
  private async upsertShop(
    shop: ShopInfo['shop'],
    accessToken: string,
  ): Promise<string> {
    const masterKeyHex = this.config.get<string>('crypto.masterKeyHex') ?? '';
    const encrypted = EnvelopeCipher.fromHex(masterKeyHex).encrypt(accessToken);
    const { rows } = await this.pool.query<{ shop_id: string }>(
      `INSERT INTO shop
         (shopify_shop_gid, myshopify_domain, iana_timezone,
          shopify_access_token_encrypted, account_state, installed_at)
       VALUES ($1, $2, $3, $4, 'TRIALING', now())
       ON CONFLICT (shopify_shop_gid) DO UPDATE SET
         myshopify_domain = EXCLUDED.myshopify_domain,
         iana_timezone = EXCLUDED.iana_timezone,
         shopify_access_token_encrypted = EXCLUDED.shopify_access_token_encrypted,
         account_state = 'TRIALING',
         installed_at = now(),
         uninstalled_at = NULL,
         version = shop.version + 1
       RETURNING shop_id`,
      [shop.id, shop.myshopifyDomain, shop.ianaTimezone, encrypted],
    );
    return rows[0].shop_id;
  }

  /** §5.6/§7.1: seed store_settings defaults at onboarding. */
  private async seedStoreSettings(shopId: string, ianaTimezone: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO store_settings (shop_id, timezone)
       VALUES ($1, $2)
       ON CONFLICT (shop_id) DO NOTHING`,
      [shopId, ianaTimezone],
    );
  }

  /**
   * §5.6 day one, per shop: order-sync settings (S-8…S-14 with the S-14 COD
   * gateway seed) and exactly one default package profile (INV-24 — without
   * it F-20's last rung and INV-7's dimension block are non-deterministic).
   * The seed dimensions are a placeholder the merchant replaces in settings;
   * the values are a build choice, the EXISTENCE is the invariant (RW-21).
   */
  private async seedOnboardingRows(shopId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO order_sync_settings (shop_id)
       VALUES ($1)
       ON CONFLICT (shop_id) DO NOTHING`,
      [shopId],
    );
    await this.pool.query(
      `INSERT INTO package_profile
         (shop_id, name, length_cm, width_cm, height_cm, tare_kg, is_default)
       VALUES ($1, 'Default parcel', 25.00, 20.00, 10.00, 0.050, true)
       ON CONFLICT DO NOTHING`,
      [shopId],
    );
    // S-39: the trial — 14 days, 50 AWBs — starts at install, so the §3.2
    // booking guard ("entitlement available or overage permitted") has a
    // subscription to read from day one.
    await this.pool.query(
      `INSERT INTO subscription (shop_id, plan_id, cycle_start_at, cycle_end_at, state)
       SELECT $1, plan_id, now(), now() + interval '14 days', 'TRIALING'
         FROM plan WHERE code = 'TRIAL'
       ON CONFLICT DO NOTHING`,
      [shopId],
    );
  }

  /**
   * §9.1.2: the staff user who completes the install becomes Owner — the
   * FIRST member of a shop gets role OWNER. Any other staff user is NOT
   * given a row here: "No access" is the absence of a row (deny-by-default),
   * and the access-request flow lives in the team module.
   */
  private async upsertStaffMember(shopId: string, staffUserId: string): Promise<void> {
    const existing = await this.pool.query<{ member_id: string }>(
      `SELECT member_id FROM shop_member
        WHERE shop_id = $1 AND shopify_staff_user_id = $2`,
      [shopId, staffUserId],
    );
    if (existing.rows.length > 0) {
      await this.pool.query(
        `UPDATE shop_member SET last_active_at = now(), version = version + 1
          WHERE shop_id = $1 AND member_id = $2`,
        [shopId, existing.rows[0].member_id],
      );
      return;
    }
    const count = await this.pool.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM shop_member WHERE shop_id = $1`,
      [shopId],
    );
    if (Number(count.rows[0].n) > 0) return; // deny-by-default: no row, no role
    const inserted = await this.pool.query<{ member_id: string }>(
      `INSERT INTO shop_member (shop_id, shopify_staff_user_id, auth_source, role, last_active_at)
       VALUES ($1, $2, 'SHOPIFY_STAFF', 'OWNER', now())
       RETURNING member_id`,
      [shopId, staffUserId],
    );
    // §12: role grants are always audited.
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: inserted.rows[0].member_id,
      action: 'MEMBER_ROLE_GRANTED',
      objectType: 'shop_member',
      objectId: inserted.rows[0].member_id,
      after: { role: 'OWNER', auth_source: 'SHOPIFY_STAFF' },
      reason: 'first member at install becomes Owner (§9.1.2)',
    });
  }
}

/**
 * §9.1.2: the single source of per-staff identity. Reads `associated_user`
 * from an online-mode token response; returns null when Shopify did not
 * provide one (the caller escalates — never a shop-level fallback).
 */
export function resolveStaffIdentity(
  tokenResponse: ShopifyTokenResponse,
): { staffUserId: string } | null {
  const id = tokenResponse.associated_user?.id;
  if (id === undefined || id === null) return null;
  return { staffUserId: String(id) };
}
