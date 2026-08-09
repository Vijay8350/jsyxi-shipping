import { createHash } from 'node:crypto';

/**
 * Shop public reference for the hosted track page URL (§9.16).
 *
 * The hosted page URL is `{appUrl}/track/{shopPublicRef}`; the internal
 * shop_id MUST NOT appear in a public URL. The ref is the first 12 hex chars
 * (48 bits) of sha256('track-shop-ref:' + salt + ':' + shop_id) — stable,
 * non-sequential, and impractical to enumerate back to a shop_id without the
 * salt.
 *
 * Because the ref is one-way, the public lookup path resolves ref → shop_id
 * through a Redis reverse map written by the merchant-side config/snippet
 * endpoints (the only places a ref is ever handed out). A durable
 * `shop.public_ref` column is the proper v1.1 home for this mapping — see
 * the module summary; Redis is the no-schema-change store for now.
 */
export function shopPublicRef(shopId: string, salt: string): string {
  return createHash('sha256')
    .update(`track-shop-ref:${salt}:${shopId}`)
    .digest('hex')
    .slice(0, 12);
}

/** Redis key of the reverse map shopPublicRef → shop_id. */
export function shopRefRedisKey(ref: string): string {
  return `track:shopref:${ref}`;
}
