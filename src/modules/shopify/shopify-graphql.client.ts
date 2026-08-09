import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { EnvelopeCipher } from '../../common/envelope';

/**
 * Minimal GraphQL Admin API client (§8.4: GraphQL only). Used by this module
 * now (shop info at install, staff-validity checks at entry) and by order
 * sync later.
 *
 * INV-18 / §5.7 control 1: the shop's access token is envelope-encrypted at
 * rest and decrypted HERE, at call time, inside this client only. The
 * plaintext token is never logged, returned, or passed to any other module —
 * it exists only as a local for the duration of one fetch call.
 */

// §8.4 note: the accepted API surface is verified against current Shopify
// docs in week 0; the version is pinned, not "latest".
const ADMIN_API_VERSION = '2025-01';
const DEFAULT_TIMEOUT_MS = 10_000;

export type ShopifyApiErrorKind = 'NETWORK' | 'TIMEOUT' | 'HTTP' | 'THROTTLED' | 'GRAPHQL';

/** Never carries request/response bodies or credentials (INV-18). */
export class ShopifyApiError extends Error {
  constructor(
    readonly kind: ShopifyApiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ShopifyApiError';
  }
}

/** The shop row has no credential (only legitimate after uninstall). */
export class ShopifyCredentialMissingError extends Error {
  constructor(readonly shopId: string) {
    super('shop has no Shopify credential');
    this.name = 'ShopifyCredentialMissingError';
  }
}

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

@Injectable()
export class ShopifyGraphqlClient {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
  ) {}

  /**
   * Run a query using the shop's stored credential. Decryption happens at
   * call time and the plaintext never leaves this method (INV-18).
   */
  async queryForShop<T>(
    shopId: string,
    query: string,
    variables?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    // Shop-scoped lookup (INV-1).
    const { rows } = await this.pool.query<{
      myshopify_domain: string;
      shopify_access_token_encrypted: Buffer | null;
    }>(
      `SELECT myshopify_domain, shopify_access_token_encrypted
         FROM shop
        WHERE shop_id = $1`,
      [shopId],
    );
    const row = rows[0];
    if (!row || !row.shopify_access_token_encrypted) {
      throw new ShopifyCredentialMissingError(shopId);
    }
    const masterKeyHex = this.config.get<string>('crypto.masterKeyHex') ?? '';
    const accessToken = EnvelopeCipher.fromHex(masterKeyHex)
      .decrypt(row.shopify_access_token_encrypted)
      .toString('utf8');
    return this.queryWithToken(row.myshopify_domain, accessToken, query, variables, timeoutMs);
  }

  /**
   * Run a query with a caller-supplied plaintext token. Only used at install
   * time (§9.1.1), before the credential has been persisted — everywhere else
   * goes through queryForShop.
   */
  async queryWithToken<T>(
    myshopifyDomain: string,
    accessToken: string,
    query: string,
    variables?: Record<string, unknown>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(
        `https://${myshopifyDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken,
          },
          body: JSON.stringify({ query, variables: variables ?? {} }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch (err) {
      // Error name only — never the URL, headers or body (INV-18).
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ShopifyApiError('TIMEOUT', 'Shopify GraphQL request timed out');
      }
      throw new ShopifyApiError('NETWORK', 'Shopify GraphQL request failed');
    }
    if (res.status === 429) {
      throw new ShopifyApiError('THROTTLED', 'Shopify GraphQL throttled', 429);
    }
    if (!res.ok) {
      throw new ShopifyApiError('HTTP', `Shopify GraphQL HTTP ${res.status}`, res.status);
    }
    let body: GraphqlEnvelope<T>;
    try {
      body = (await res.json()) as GraphqlEnvelope<T>;
    } catch {
      throw new ShopifyApiError('HTTP', 'Shopify GraphQL returned non-JSON', res.status);
    }
    if (body.errors && body.errors.length > 0) {
      throw new ShopifyApiError(
        'GRAPHQL',
        `Shopify GraphQL error: ${body.errors[0]?.message ?? 'unknown'}`,
      );
    }
    return body.data as T;
  }
}
