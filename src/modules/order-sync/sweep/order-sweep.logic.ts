import { ShopifyRestOrderPayload } from '../shopify-order-payload.types';

/**
 * S-15 / §8.1 gap recovery / RV-14 — the PURE half of the hourly
 * reconciliation sweep: the 24-hour search window, the page envelope and
 * the GraphQL-node → REST-payload reshape (so the sweep feeds the ONE §8.1
 * mapper). No I/O here; fully unit-testable without Redis/BullMQ/network.
 */

/** S-15: re-pull orders changed in the LAST 24 HOURS. */
export const SWEEP_WINDOW_HOURS = 24;
export const SWEEP_PAGE_SIZE = 100;

/** Shopify search syntax filter for the `orders` query (§5.2: the window
 *  is computed in UTC; instants are stored UTC). */
export function buildSweepSearchQuery(now: Date): string {
  const since = new Date(now.getTime() - SWEEP_WINDOW_HOURS * 60 * 60 * 1000);
  return `updated_at:>=${since.toISOString()}`;
}

export interface UpdatedOrdersPage<TNode> {
  nodes: TNode[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface UpdatedOrdersQueryData {
  orders?: {
    nodes?: unknown[];
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  } | null;
}

/** Narrow the GraphQL envelope to one page of nodes. */
export function extractUpdatedOrdersPage<TNode>(data: UpdatedOrdersQueryData): UpdatedOrdersPage<TNode> {
  return {
    nodes: (data.orders?.nodes ?? []) as TNode[],
    hasNextPage: data.orders?.pageInfo?.hasNextPage ?? false,
    endCursor: data.orders?.pageInfo?.endCursor ?? null,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the GraphQL node is
   reshaped field-by-field into the typed REST payload; typing the wire
   shape verbatim would double the mapper's surface for no safety gain. */

/** Grams per unit from a GraphQL variant weight, or null (RV-02). */
function weightToGrams(weight: unknown, unit: unknown): number | null {
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) return null;
  switch (unit) {
    case 'GRAMS':
      return weight;
    case 'KILOGRAMS':
      return weight * 1000;
    case 'OUNCES':
      return weight * 28.349523125;
    case 'POUNDS':
      return weight * 453.59237;
    default:
      return null;
  }
}

function money(amount: unknown, currencyCode: unknown): { amount: string; currency_code: string } | undefined {
  return typeof amount === 'string'
    ? { amount, currency_code: typeof currencyCode === 'string' ? currencyCode : 'INR' }
    : undefined;
}

/**
 * Reshape one GraphQL order node (see UPDATED_ORDERS_QUERY) into the REST
 * webhook JSON shape the §8.1 mapper consumes. This is what lets the sweep
 * share the webhook ingest path verbatim.
 */
export function graphqlOrderToRestPayload(node: any): ShopifyRestOrderPayload {
  return {
    admin_graphql_api_id: node?.id ?? null,
    name: node?.name ?? null,
    created_at: node?.createdAt ?? null,
    test: node?.test === true,
    email: node?.email ?? null,
    phone: node?.phone ?? null,
    current_total_price_set: {
      shop_money: money(
        node?.currentTotalPriceSet?.shopMoney?.amount,
        node?.currentTotalPriceSet?.shopMoney?.currencyCode,
      ),
      presentment_money: money(
        node?.currentTotalPriceSet?.presentmentMoney?.amount,
        node?.currentTotalPriceSet?.presentmentMoney?.currencyCode,
      ),
    },
    payment_gateway_names: Array.isArray(node?.paymentGatewayNames)
      ? node.paymentGatewayNames
      : [],
    risk_level: typeof node?.riskLevel === 'string' ? node.riskLevel : null,
    shipping_address: node?.shippingAddress ?? null,
    shipping_lines: (node?.shippingLines?.nodes ?? []).map((sl: any) => ({
      title: sl?.title ?? null,
      price_set: {
        shop_money: money(
          sl?.originalPriceSet?.shopMoney?.amount,
          sl?.originalPriceSet?.shopMoney?.currencyCode,
        ),
      },
    })),
    line_items: (node?.lineItems?.nodes ?? []).map((li: any) => ({
      admin_graphql_api_id: li?.id ?? null,
      sku: li?.sku ?? null,
      title: li?.title ?? null,
      variant_title: li?.variantTitle ?? null,
      quantity: typeof li?.quantity === 'number' ? li.quantity : null,
      price_set: {
        shop_money: money(
          li?.originalUnitPriceSet?.shopMoney?.amount,
          li?.originalUnitPriceSet?.shopMoney?.currencyCode,
        ),
      },
      tags: Array.isArray(li?.product?.tags) ? li.product.tags : [],
      grams: weightToGrams(li?.variant?.weight, li?.variant?.weightUnit),
      harmonized_system_code: li?.variant?.inventoryItem?.harmonizedSystemCode ?? null,
    })),
  };
}
