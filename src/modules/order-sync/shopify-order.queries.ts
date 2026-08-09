/**
 * GraphQL Admin API documents used by order sync (§8.4: GraphQL only; the
 * version is pinned inside ShopifyGraphqlClient). Kept as constants so the
 * sweep's pure query builder and the services are unit-testable without a
 * network.
 */

/** §9.2.3 location discovery (RW-14). */
export const LOCATIONS_QUERY = /* GraphQL */ `
  query JsyxiLocations($first: Int!, $after: String) {
    locations(first: $first, after: $after) {
      nodes {
        id
        name
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** §9.2.3: an order's fulfillment orders drive allocation building. */
export const ORDER_FULFILLMENT_ORDERS_QUERY = /* GraphQL */ `
  query JsyxiOrderFulfillmentOrders($orderId: ID!) {
    order(id: $orderId) {
      fulfillmentOrders(first: 50) {
        nodes {
          id
          status
          assignedLocation {
            location {
              id
              name
            }
          }
        }
      }
    }
  }
`;

/** S-15 / RV-14: hourly sweep re-pulls orders changed in the last 24 hours.
 *  The `query` variable carries `updated_at:>=<ISO>` (see order-sweep.logic). */
export const UPDATED_ORDERS_QUERY = /* GraphQL */ `
  query JsyxiUpdatedOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query) {
      nodes {
        id
        name
        createdAt
        test
        email
        phone
        displayFinancialStatus
        currentTotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
          presentmentMoney {
            amount
            currencyCode
          }
        }
        paymentGatewayNames
        riskLevel
        shippingAddress {
          name
          address1
          address2
          city
          province
          zip
          phone
        }
        shippingLines(first: 5) {
          nodes {
            title
            originalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
        }
        lineItems(first: 100) {
          nodes {
            id
            sku
            title
            variantTitle
            quantity
            originalUnitPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            product {
              tags
            }
            variant {
              weight
              weightUnit
              inventoryItem {
                harmonizedSystemCode
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export interface ShopifyLocationNode {
  id: string;
  name: string;
}

export interface LocationsQueryData {
  locations: {
    nodes: ShopifyLocationNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export interface FulfillmentOrderNode {
  id: string;
  status: string;
  assignedLocation: { location: { id: string; name: string } | null } | null;
}

export interface OrderFulfillmentOrdersData {
  order: { fulfillmentOrders: { nodes: FulfillmentOrderNode[] } } | null;
}
