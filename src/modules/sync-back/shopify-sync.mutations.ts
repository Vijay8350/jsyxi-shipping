import { Injectable } from '@nestjs/common';
import { ShopifyGraphqlClient } from '../shopify/shopify-graphql.client';
import type {
  AddFulfillmentEventPayload,
  CancelFulfillmentPayload,
  CreateFulfillmentPayload,
  SetOrderTagsPayload,
} from './sync-back.types';

/**
 * The §8.4 GraphQL surface (GraphQL Admin API only, FulfillmentOrders-based;
 * version pinned in ShopifyGraphqlClient). Every statement lives here so the
 * week-0 verification of the API surface (§8.4) touches exactly one file.
 *
 * userErrors are treated as failures — they land on the §8.6 retry path and
 * eventually the DLQ, never silently (INV-20).
 */

const FULFILLMENT_ORDER_LINES_QUERY = /* GraphQL */ `
  query SyncBackFulfillmentOrderLines($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on FulfillmentOrder {
        id
        lineItems(first: 100) {
          nodes {
            id
            lineItem {
              id
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = /* GraphQL */ `
  mutation SyncBackFulfillmentCreate($fulfillment: FulfillmentV2Input!) {
    fulfillmentCreateV2(fulfillment: $fulfillment) {
      fulfillment {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FULFILLMENT_EVENT_MUTATION = /* GraphQL */ `
  mutation SyncBackFulfillmentEvent($fulfillmentEvent: FulfillmentEventInput!) {
    fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
      fulfillmentEvent {
        id
        status
        message
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FULFILLMENT_CANCEL_MUTATION = /* GraphQL */ `
  mutation SyncBackFulfillmentCancel($id: ID!) {
    fulfillmentCancel(id: $id) {
      fulfillment {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const TAGS_ADD_MUTATION = /* GraphQL */ `
  mutation SyncBackTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface UserError {
  field?: string[];
  message?: string;
}

/** §8.6: a failed Shopify write — the worker turns this into RETRYING/DEAD. */
export class ShopifySyncMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopifySyncMutationError';
  }
}

function assertNoUserErrors(operation: string, userErrors: UserError[] | undefined): void {
  if (userErrors && userErrors.length > 0) {
    // Field paths + Shopify's message only — never payload values (§5.7.4).
    throw new ShopifySyncMutationError(
      `${operation} userErrors: ${userErrors
        .map((e) => `${(e.field ?? []).join('.')}:${e.message ?? 'unknown'}`)
        .join('; ')}`,
    );
  }
}

interface FulfillmentOrderNodesData {
  nodes: Array<{
    id: string;
    lineItems: { nodes: Array<{ id: string; lineItem: { id: string } | null }> };
  } | null>;
}

@Injectable()
export class ShopifySyncMutations {
  constructor(private readonly graphql: ShopifyGraphqlClient) {}

  /**
   * §8.4 CREATE_FULFILLMENT. The payload carries the allocation's
   * fulfillment-order line mapping (snapshot line GIDs + quantities); the
   * fulfillment-order line-item IDs are resolved here, at execution time,
   * from the fulfillment orders themselves. Returns the fulfillment GID.
   */
  async createFulfillment(shopId: string, payload: CreateFulfillmentPayload): Promise<string> {
    const foGids = payload.lineItemsByFulfillmentOrder.map((m) => m.fulfillmentOrderGid);
    const data = await this.graphql.queryForShop<FulfillmentOrderNodesData>(
      shopId,
      FULFILLMENT_ORDER_LINES_QUERY,
      { ids: foGids },
    );
    // Resolve each allocated line GID to its fulfillment-order line item ID.
    // Resolved globally across the payload's fulfillment orders, because a
    // consolidated allocation (§9.2.3 merge/CONSOLIDATED) may place a line on
    // any of them; lines are then grouped back under the FO that owns them.
    const lineToFoli = new Map<string, { foGid: string; foliId: string }>();
    for (const node of data.nodes ?? []) {
      if (!node) continue;
      for (const foli of node.lineItems.nodes) {
        if (foli.lineItem) lineToFoli.set(foli.lineItem.id, { foGid: node.id, foliId: foli.id });
      }
    }
    const grouped = new Map<string, Array<{ id: string; quantity: number }>>();
    for (const mapping of payload.lineItemsByFulfillmentOrder) {
      for (const line of mapping.lines) {
        const resolved = lineToFoli.get(line.shopifyLineGid);
        if (!resolved) {
          // INV-20: an unmappable allocation line is a loud failure, not a skip.
          throw new ShopifySyncMutationError(
            'fulfillment order line not found for an allocated line',
          );
        }
        const list = grouped.get(resolved.foGid) ?? [];
        list.push({ id: resolved.foliId, quantity: line.quantity });
        grouped.set(resolved.foGid, list);
      }
    }
    const lineItemsByFulfillmentOrder = [...grouped.entries()].map(
      ([fulfillmentOrderId, fulfillmentOrderLineItems]) => ({
        fulfillmentOrderId,
        fulfillmentOrderLineItems,
      }),
    );

    const result = await this.graphql.queryForShop<{
      fulfillmentCreateV2: { fulfillment: { id: string } | null; userErrors: UserError[] };
    }>(shopId, FULFILLMENT_CREATE_MUTATION, {
      fulfillment: {
        lineItemsByFulfillmentOrder,
        trackingInfo: {
          number: payload.awb,
          company: payload.courierName,
          url: payload.trackingUrl,
        },
        notifyCustomer: payload.notifyCustomer,
      },
    });
    assertNoUserErrors('fulfillmentCreateV2', result.fulfillmentCreateV2.userErrors);
    const gid = result.fulfillmentCreateV2.fulfillment?.id;
    if (!gid) throw new ShopifySyncMutationError('fulfillmentCreateV2 returned no fulfillment');
    return gid;
  }

  /** §8.4 ADD_FULFILLMENT_EVENT with the A3-06 constant mapping applied. */
  async addFulfillmentEvent(shopId: string, payload: AddFulfillmentEventPayload): Promise<void> {
    if (!payload.fulfillmentGid) {
      throw new ShopifySyncMutationError('no SUCCEEDED fulfillment to attach the event to');
    }
    const result = await this.graphql.queryForShop<{
      fulfillmentEventCreate: { userErrors: UserError[] };
    }>(shopId, FULFILLMENT_EVENT_MUTATION, {
      fulfillmentEvent: {
        fulfillmentId: payload.fulfillmentGid,
        status: payload.shopifyStatus,
        message: payload.message,
      },
    });
    assertNoUserErrors('fulfillmentEventCreate', result.fulfillmentEventCreate.userErrors);
  }

  async cancelFulfillment(shopId: string, payload: CancelFulfillmentPayload): Promise<void> {
    if (!payload.fulfillmentGid) {
      throw new ShopifySyncMutationError('no SUCCEEDED fulfillment to cancel');
    }
    const result = await this.graphql.queryForShop<{
      fulfillmentCancel: { userErrors: UserError[] };
    }>(shopId, FULFILLMENT_CANCEL_MUTATION, { id: payload.fulfillmentGid });
    assertNoUserErrors('fulfillmentCancel', result.fulfillmentCancel.userErrors);
  }

  /** §8.4 optional order tags. */
  async setOrderTags(shopId: string, payload: SetOrderTagsPayload): Promise<void> {
    const result = await this.graphql.queryForShop<{
      tagsAdd: { userErrors: UserError[] };
    }>(shopId, TAGS_ADD_MUTATION, { id: payload.shopifyOrderGid, tags: payload.tags });
    assertNoUserErrors('tagsAdd', result.tagsAdd.userErrors);
  }
}
