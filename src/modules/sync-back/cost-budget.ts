import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../../redis/redis.module';

/**
 * §8.4 per-Shop GraphQL cost budget (S-21 spirit): one shop must not starve
 * the shared sync worker. Implemented as a fixed-window token bucket in
 * Redis — up to SHOPIFY_COST_POINTS_PER_SECOND cost points per Shop per
 * one-second window; every sync-back GraphQL call costs
 * SYNC_GRAPHQL_COST_PER_CALL point (Shopify's calculated query cost for
 * these small mutations is 2–10; the budget is deliberately generous per
 * shop but bounded).
 *
 * The key is shop-scoped (INV-1). A throttled row is deferred — it is NOT an
 * attempt (§8.6 retries are for real failures, not self-imposed pacing).
 */

export const SHOPIFY_COST_POINTS_PER_SECOND = 50;
export const SYNC_GRAPHQL_COST_PER_CALL = 10;
/** Defer interval when the bucket is empty. */
export const THROTTLE_DEFER_MS = 1_000;

const KEY_PREFIX = 'syncback:budget:';

@Injectable()
export class SyncCostBudget {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Try to spend `cost` points for the shop in the current 1-second window.
   * Returns true when the call may proceed. Overspend in a racing window is
   * bounded and self-corrects on the next window — the budget is pacing, not
   * accounting.
   */
  async tryConsume(
    shopId: string,
    cost: number = SYNC_GRAPHQL_COST_PER_CALL,
    now: Date = new Date(),
  ): Promise<boolean> {
    const window = Math.floor(now.getTime() / 1_000);
    const key = `${KEY_PREFIX}${shopId}:${window}`;
    const used = Number(await this.redis.incrby(key, cost));
    if (used === cost) {
      await this.redis.expire(key, 2);
    }
    if (used > SHOPIFY_COST_POINTS_PER_SECOND) {
      // Give the points back so borderline callers don't poison the window.
      await this.redis.decrby(key, cost);
      return false;
    }
    return true;
  }
}
