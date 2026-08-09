import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../database/database.module';
import { ShopifyGraphqlClient } from '../../shopify/shopify-graphql.client';
import { OrderIngestService } from '../order-ingest.service';
import { UPDATED_ORDERS_QUERY } from '../shopify-order.queries';
import {
  SWEEP_PAGE_SIZE,
  UpdatedOrdersPage,
  UpdatedOrdersQueryData,
  buildSweepSearchQuery,
  extractUpdatedOrdersPage,
  graphqlOrderToRestPayload,
} from './order-sweep.logic';

/**
 * S-15 hourly reconciliation sweep (§8.1 gap recovery, RV-14): re-pulls
 * orders changed in the last 24 hours for one shop, paginated, feeding the
 * same ingest path as the webhooks. Shops in UNINSTALLED are skipped
 * (§5.5). The paging/filter mechanics live in order-sweep.logic (pure);
 * this class is only I/O orchestration.
 */
export interface SweepResult {
  shopId: string;
  skipped: boolean;
  ordersProcessed: number;
  pages: number;
}

@Injectable()
export class OrderSweepService {
  private readonly logger = new Logger(OrderSweepService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly graphql: ShopifyGraphqlClient,
    private readonly ingest: OrderIngestService,
  ) {}

  async runShopSweep(shopId: string, now: Date = new Date()): Promise<SweepResult> {
    // §5.5: uninstall disables schedules and queued jobs — re-checked here
    // so a job enqueued before the uninstall is still a no-op.
    const shopRes = await this.pool.query<{ account_state: string }>(
      `SELECT account_state FROM shop WHERE shop_id = $1`,
      [shopId],
    );
    const state = shopRes.rows[0]?.account_state;
    if (!state || state === 'UNINSTALLED') {
      return { shopId, skipped: true, ordersProcessed: 0, pages: 0 };
    }

    const query = buildSweepSearchQuery(now);
    let after: string | null = null;
    let pages = 0;
    let ordersProcessed = 0;
    do {
      const data: UpdatedOrdersQueryData = await this.graphql.queryForShop<UpdatedOrdersQueryData>(
        shopId,
        UPDATED_ORDERS_QUERY,
        { first: SWEEP_PAGE_SIZE, after, query },
      );
      const page: UpdatedOrdersPage<unknown> = extractUpdatedOrdersPage<unknown>(data);
      for (const node of page.nodes) {
        await this.ingest.ingest(shopId, graphqlOrderToRestPayload(node));
        ordersProcessed += 1;
      }
      pages += 1;
      after = page.hasNextPage ? page.endCursor : null;
    } while (after !== null);

    this.logger.log(
      `sweep done shop=${shopId} pages=${pages} orders=${ordersProcessed} window=${query}`,
    );
    return { shopId, skipped: false, ordersProcessed, pages };
  }
}
