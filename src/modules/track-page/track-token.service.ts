import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { randomToken, tokenHash } from '../../common/crypto';
import { TrackShipmentRow } from './track-page-data.service';

/**
 * Per-shipment track tokens (§2.8 track_token, §9.16 path 1 — A1-07, A2-12).
 *
 * - Tokens are ≥128-bit random (32 bytes → base64url) and are stored HASHED
 *   only (token_hash, sha256). The raw token exists only in the issued link.
 * - The tokenized link needs NO further verification (A1-07): possession of
 *   the link is the authorization, so resolve() must reject anything revoked
 *   or belonging to an UNINSTALLED shop (§5.5).
 * - §5.5: uninstall invalidates ALL public track tokens; privacy redaction
 *   revokes buyer track access — both funnel through revokeAllForShop, called
 *   by the uninstall/redaction modules (wiring is theirs, not this module's).
 * - ADD-26 will later send buyers these links; this module only builds them.
 */

export interface IssuedTrackLink {
  tokenId: string;
  shipmentId: string;
  url: string; // {appUrl}/track/t/{token}
}

/** What resolve() returns; null covers every invalid case alike. */
export interface ResolvedTrackToken {
  tokenId: string;
  shipment: TrackShipmentRow;
}

@Injectable()
export class TrackTokenService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
  ) {}

  private appUrl(): string {
    return (
      this.config.get<string>('shopify.appUrl') ?? 'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  /** Issue a fresh tokenized link for one shipment (shop-scoped, INV-1). */
  async issue(shopId: string, shipmentId: string): Promise<IssuedTrackLink> {
    const token = randomToken(32); // 256-bit ≥ the required 128
    const result = await this.pool.query<{ token_id: string }>(
      `INSERT INTO track_token (shop_id, shipment_id, token_hash)
       VALUES ($1, $2, $3)
       RETURNING token_id`,
      [shopId, shipmentId, tokenHash(token)],
    );
    return {
      tokenId: result.rows[0].token_id,
      shipmentId,
      url: `${this.appUrl()}/track/t/${token}`,
    };
  }

  /**
   * Resolve a raw token to its shipment for the public page. Returns null
   * for every invalid case alike: unknown token, revoked token (§5.5), or a
   * shop that is UNINSTALLED (§9.16 — uninstall revokes buyer access).
   */
  async resolve(token: string): Promise<ResolvedTrackToken | null> {
    const result = await this.pool.query<
      { token_id: string; revoked_at: string | null; account_state: string } & TrackShipmentRow
    >(
      `SELECT t.token_id, t.revoked_at, sh.account_state,
              s.shipment_id, s.shop_id, s.order_id, s.movement_state,
              s.awb_raw, s.is_test, s.snapshot,
              c.name AS courier_name
         FROM track_token t
         JOIN shipment s
           ON s.shipment_id = t.shipment_id AND s.shop_id = t.shop_id
         JOIN shop sh ON sh.shop_id = t.shop_id
         LEFT JOIN courier_account ca
           ON ca.courier_account_id = s.courier_account_id
         LEFT JOIN courier c ON c.courier_id = ca.courier_id
        WHERE t.token_hash = $1`,
      [tokenHash(token)],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.revoked_at !== null) return null; // §5.5 revocation
    if (row.account_state === 'UNINSTALLED') return null; // §9.16
    return {
      tokenId: row.token_id,
      shipment: {
        shipment_id: row.shipment_id,
        shop_id: row.shop_id,
        order_id: row.order_id,
        movement_state: row.movement_state,
        awb_raw: row.awb_raw,
        is_test: row.is_test,
        snapshot: row.snapshot,
        courier_name: row.courier_name,
      },
    };
  }

  /** Revoke every token of one shipment (e.g. privacy redaction, §5.5). */
  async revokeForShipment(shopId: string, shipmentId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE track_token SET revoked_at = now()
        WHERE shop_id = $1 AND shipment_id = $2 AND revoked_at IS NULL`,
      [shopId, shipmentId],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Revoke every token of the shop — uninstall scope (§5.5: uninstall
   * immediately invalidates all public track tokens) and shop-level
   * redaction.
   */
  async revokeAllForShop(shopId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE track_token SET revoked_at = now()
        WHERE shop_id = $1 AND revoked_at IS NULL`,
      [shopId],
    );
    return result.rowCount ?? 0;
  }
}
