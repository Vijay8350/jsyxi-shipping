import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { randomToken, tokenHash } from '../../common/crypto';

/**
 * ADD-27 tokenized buyer links (ndr_response_token, migration 0014): 256-bit
 * random, stored HASHED only, single-purpose (revoked on first successful
 * response — see NdrRespondService). Possession of the link is the
 * authorization, same model as the track token (§9.16 path 1, A1-07).
 */

export interface IssuedNdrLink {
  tokenId: string;
  ndrCaseId: string;
  url: string; // {appUrl}/ndr/respond/{token}
}

export interface ResolvedNdrToken {
  tokenId: string;
  shopId: string;
  ndrCaseId: string;
  shipmentId: string;
  orderRef: string | null;
  /** §2.9 snapshot recipient — the address on file shown back to the buyer. */
  recipient: Record<string, unknown> | null;
}

@Injectable()
export class NdrTokenService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
  ) {}

  private appUrl(): string {
    return (
      this.config.get<string>('shopify.appUrl') ?? 'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  async issue(shopId: string, ndrCaseId: string): Promise<IssuedNdrLink> {
    const token = randomToken(32);
    const result = await this.pool.query<{ token_id: string }>(
      `INSERT INTO ndr_response_token (shop_id, ndr_case_id, token_hash)
       VALUES ($1, $2, $3)
       RETURNING token_id`,
      [shopId, ndrCaseId, tokenHash(token)],
    );
    return {
      tokenId: result.rows[0].token_id,
      ndrCaseId,
      url: `${this.appUrl()}/ndr/respond/${token}`,
    };
  }

  /**
   * Resolve a raw token for the public endpoint. Null covers every invalid
   * case alike: unknown token, already-used/revoked token, UNINSTALLED shop
   * (§5.5 — uninstall revokes buyer access).
   */
  async resolve(token: string): Promise<ResolvedNdrToken | null> {
    const result = await this.pool.query<{
      token_id: string;
      shop_id: string;
      ndr_case_id: string;
      revoked_at: string | null;
      account_state: string;
      shipment_id: string;
      shopify_order_number: string | null;
      snapshot: { recipient?: Record<string, unknown> | null } | null;
    }>(
      `SELECT t.token_id, t.shop_id, t.ndr_case_id, t.revoked_at,
              sh.account_state,
              c.shipment_id, o.shopify_order_number, s.snapshot
         FROM ndr_response_token t
         JOIN shop sh ON sh.shop_id = t.shop_id
         JOIN ndr_case c ON c.ndr_case_id = t.ndr_case_id
         JOIN shipment s ON s.shipment_id = c.shipment_id AND s.shop_id = c.shop_id
         JOIN "order" o ON o.order_id = s.order_id
        WHERE t.token_hash = $1`,
      [tokenHash(token)],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.revoked_at !== null) return null;
    if (row.account_state === 'UNINSTALLED') return null;
    return {
      tokenId: row.token_id,
      shopId: row.shop_id,
      ndrCaseId: row.ndr_case_id,
      shipmentId: row.shipment_id,
      orderRef: row.shopify_order_number,
      recipient: row.snapshot?.recipient ?? null,
    };
  }

  /** Single-purpose: a token dies with the first successful response. */
  async revoke(tokenId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ndr_response_token SET revoked_at = now()
        WHERE token_id = $1 AND revoked_at IS NULL`,
      [tokenId],
    );
  }
}
