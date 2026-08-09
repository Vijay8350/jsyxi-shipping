import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { ShopifyGraphqlClient } from '../shopify/shopify-graphql.client';
import {
  LOCATIONS_QUERY,
  LocationsQueryData,
  ShopifyLocationNode,
} from './shopify-order.queries';

/**
 * §9.2.3 / A4-01 / RV-11 / RW-14: Shopify location discovery.
 *
 * Every Shopify location is mirrored into shopify_location, auto-discovered
 * with ships_via_jsyxi = true (a newly created location NEVER causes an
 * order to be skipped). The merchant's only control is the per-location
 * ships_via_jsyxi toggle (§9.12, Owner-only) — this service never writes
 * that flag back to false; an update preserves the stored value.
 */
@Injectable()
export class LocationService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly graphql: ShopifyGraphqlClient,
  ) {}

  /** Full discovery pass — paginates the Admin API locations list and
   *  upserts every row. Safe to re-run: updates rename only. */
  async syncLocations(shopId: string): Promise<number> {
    let after: string | null = null;
    let synced = 0;
    do {
      const data: LocationsQueryData = await this.graphql.queryForShop<LocationsQueryData>(
        shopId,
        LOCATIONS_QUERY,
        { first: 100, after },
      );
      await this.ensureLocations(shopId, data.locations.nodes);
      synced += data.locations.nodes.length;
      after = data.locations.pageInfo.hasNextPage ? data.locations.pageInfo.endCursor : null;
    } while (after !== null);
    return synced;
  }

  /**
   * Idempotent upsert keyed on (shop_id, shopify_location_gid) (INV-1).
   * Insert defaults ships_via_jsyxi = true (§9.2.3); an existing row keeps
   * the merchant's toggle.
   */
  async ensureLocations(shopId: string, locations: ShopifyLocationNode[]): Promise<void> {
    for (const loc of locations) {
      await this.pool.query(
        `INSERT INTO shopify_location (shop_id, shopify_location_gid, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (shop_id, shopify_location_gid) DO UPDATE SET
           name = EXCLUDED.name,
           version = shopify_location.version + 1`,
        [shopId, loc.id, loc.name],
      );
    }
  }

  /** ships_via_jsyxi flags for the given GIDs; unknown GIDs are reported
   *  absent so the caller can auto-discover them (never skip — §9.2.3). */
  async getShipsViaFlags(
    shopId: string,
    locationGids: string[],
  ): Promise<Map<string, boolean>> {
    const flags = new Map<string, boolean>();
    if (locationGids.length === 0) return flags;
    const { rows } = await this.pool.query<{
      shopify_location_gid: string;
      ships_via_jsyxi: boolean;
    }>(
      `SELECT shopify_location_gid, ships_via_jsyxi
         FROM shopify_location
        WHERE shop_id = $1 AND shopify_location_gid = ANY($2::text[])`,
      [shopId, locationGids],
    );
    for (const row of rows) flags.set(row.shopify_location_gid, row.ships_via_jsyxi);
    return flags;
  }
}
