import { Injectable } from '@nestjs/common';
import { ShopifyGraphqlClient } from '../shopify/shopify-graphql.client';

/**
 * Shopify Billing API access (§9.14, INV-23). These GraphQL documents are the
 * ONLY charge paths in the product: appSubscriptionCreate (the subscription),
 * appUsageRecordCreate (AWB overage, §9.5.6) and appSubscriptionCancel. No
 * other mutation anywhere in the app may move merchant money (INV-23).
 *
 * All calls go through ShopifyGraphqlClient, so the shop credential is
 * decrypted at call time and never leaves it (INV-18). Amounts are decimal
 * rupee strings converted from integer paise at this boundary (INV-15) — and
 * a usage charge is NEVER zero or negative (§9.5.6: no negative usage call).
 */

export class ShopifyBillingUserError extends Error {
  constructor(
    readonly userErrors: Array<{ field?: string[] | null; message?: string }>,
  ) {
    super(
      `Shopify Billing userError: ${userErrors[0]?.message ?? 'unknown'}`,
    );
    this.name = 'ShopifyBillingUserError';
  }
}

export interface CreateSubscriptionInput {
  name: string;
  returnUrl: string;
  trialDays: number;
  /** Recurring price, decimal rupees ("499.00"). */
  recurringPrice: string;
  currencyCode: string;
  /** Usage-charge cap, decimal rupees; omit the usage line item when null. */
  cappedAmount: string | null;
  /** Human-readable usage terms shown at approval (required with a cap). */
  usageTerms: string | null;
  /** Dev-store flag; passed through untouched. */
  test?: boolean;
}

export interface CreateSubscriptionResult {
  subscriptionGid: string;
  confirmationUrl: string;
}

export interface ActiveSubscription {
  gid: string;
  name: string;
  status: string;
  currentPeriodEnd: string | null;
  createdAt: string;
  /** The AppUsagePricing line item id (target of appUsageRecordCreate). */
  usageLineItemId: string | null;
  /** Approved usage cap, decimal string of the shop currency, when present. */
  cappedAmount: string | null;
}

const APP_SUBSCRIPTION_CREATE = /* GraphQL */ `
  mutation JsyxiAppSubscriptionCreate(
    $name: String!
    $returnUrl: URL!
    $trialDays: Int
    $test: Boolean
    $lineItems: [AppSubscriptionLineItemInput!]!
  ) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      trialDays: $trialDays
      test: $test
      lineItems: $lineItems
    ) {
      appSubscription { id }
      confirmationUrl
      userErrors { field message }
    }
  }
`;

const APP_SUBSCRIPTION_CANCEL = /* GraphQL */ `
  mutation JsyxiAppSubscriptionCancel($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription { id status }
      userErrors { field message }
    }
  }
`;

const ACTIVE_SUBSCRIPTIONS = /* GraphQL */ `
  query JsyxiActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        createdAt
        currentPeriodEnd
        lineItems {
          id
          plan {
            pricingDetails {
              __typename
              ... on AppUsagePricing {
                cappedAmount { amount currencyCode }
              }
            }
          }
        }
      }
    }
  }
`;

const APP_USAGE_RECORD_CREATE = /* GraphQL */ `
  mutation JsyxiAppUsageRecordCreate(
    $subscriptionLineItemId: ID!
    $price: MoneyInput!
    $description: String!
  ) {
    appUsageRecordCreate(
      subscriptionLineItemId: $subscriptionLineItemId
      price: $price
      description: $description
    ) {
      appUsageRecord { id }
      userErrors { field message }
    }
  }
`;

const SUBSCRIPTION_USAGE_RECORDS = /* GraphQL */ `
  query JsyxiSubscriptionUsageRecords($id: ID!) {
    node(id: $id) {
      ... on AppSubscription {
        id
        usageRecords(first: 250) {
          nodes { id }
        }
      }
    }
  }
`;

interface UserErrorsPayload {
  userErrors?: Array<{ field?: string[] | null; message?: string }> | null;
}

function throwOnUserErrors(payload: UserErrorsPayload): void {
  if (payload.userErrors && payload.userErrors.length > 0) {
    throw new ShopifyBillingUserError(payload.userErrors);
  }
}

@Injectable()
export class ShopifyBillingClient {
  constructor(private readonly graphql: ShopifyGraphqlClient) {}

  /** §9.14: create the subscription charge; merchant approves at the returned URL. */
  async createSubscription(
    shopId: string,
    input: CreateSubscriptionInput,
  ): Promise<CreateSubscriptionResult> {
    const lineItems: Array<Record<string, unknown>> = [
      {
        plan: {
          appRecurringPricingDetails: {
            price: {
              amount: Number(input.recurringPrice),
              currencyCode: input.currencyCode,
            },
            interval: 'EVERY_30_DAYS',
          },
        },
      },
    ];
    if (input.cappedAmount !== null) {
      lineItems.push({
        plan: {
          appUsagePricingDetails: {
            terms: input.usageTerms ?? 'AWB overage beyond plan allowance',
            cappedAmount: {
              amount: Number(input.cappedAmount),
              currencyCode: input.currencyCode,
            },
          },
        },
      });
    }
    const data = await this.graphql.queryForShop<{
      appSubscriptionCreate: {
        appSubscription: { id: string } | null;
        confirmationUrl: string;
      } & UserErrorsPayload;
    }>(shopId, APP_SUBSCRIPTION_CREATE, {
      name: input.name,
      returnUrl: input.returnUrl,
      trialDays: input.trialDays > 0 ? input.trialDays : null,
      test: input.test ?? null,
      lineItems,
    });
    throwOnUserErrors(data.appSubscriptionCreate);
    const created = data.appSubscriptionCreate;
    if (!created.appSubscription) {
      throw new ShopifyBillingUserError([{ message: 'no subscription returned' }]);
    }
    return {
      subscriptionGid: created.appSubscription.id,
      confirmationUrl: created.confirmationUrl,
    };
  }

  /** §3.11: cancellation is one of the four RESTRICTED triggers. */
  async cancelSubscription(
    shopId: string,
    subscriptionGid: string,
  ): Promise<string> {
    const data = await this.graphql.queryForShop<{
      appSubscriptionCancel: {
        appSubscription: { id: string; status: string } | null;
      } & UserErrorsPayload;
    }>(shopId, APP_SUBSCRIPTION_CANCEL, { id: subscriptionGid });
    throwOnUserErrors(data.appSubscriptionCancel);
    return data.appSubscriptionCancel.appSubscription?.status ?? 'CANCELLED';
  }

  /**
   * Read the app's active subscriptions at Shopify — the source of truth on
   * the confirmation redirect (§9.14: subscription ACTIVE on approval).
   */
  async activeSubscriptions(shopId: string): Promise<ActiveSubscription[]> {
    const data = await this.graphql.queryForShop<{
      currentAppInstallation: {
        activeSubscriptions: Array<{
          id: string;
          name: string;
          status: string;
          createdAt: string;
          currentPeriodEnd: string | null;
          lineItems: Array<{
            id: string;
            plan: {
              pricingDetails:
                | { __typename: 'AppUsagePricing'; cappedAmount: { amount: string; currencyCode: string } }
                | { __typename: string };
            };
          }>;
        }>;
      };
    }>(shopId, ACTIVE_SUBSCRIPTIONS);
    return data.currentAppInstallation.activeSubscriptions.map((s) => {
      const usageLine = s.lineItems.find(
        (li) => li.plan.pricingDetails.__typename === 'AppUsagePricing',
      );
      const details = usageLine?.plan.pricingDetails;
      const capped =
        details && 'cappedAmount' in details
          ? String(details.cappedAmount.amount)
          : null;
      return {
        gid: s.id,
        name: s.name,
        status: s.status,
        createdAt: s.createdAt,
        currentPeriodEnd: s.currentPeriodEnd,
        usageLineItemId: usageLine?.id ?? null,
        cappedAmount: capped,
      };
    });
  }

  /**
   * §9.5.6: submit ONE overage usage record. `amountRupees` MUST be a
   * positive decimal string — a zero or negative usage charge does not exist
   * in this product (never invent a negative usage call, §9.5.6).
   */
  async createUsageRecord(
    shopId: string,
    subscriptionLineItemId: string,
    amountRupees: string,
    description: string,
  ): Promise<string> {
    const amount = Number(amountRupees);
    if (!Number.isFinite(amount) || amount <= 0) {
      // Invariant guard — this is a programming error, not a Shopify error.
      throw new Error(
        'usage charge must be positive; negative usage calls do not exist (§9.5.6)',
      );
    }
    const data = await this.graphql.queryForShop<{
      appUsageRecordCreate: {
        appUsageRecord: { id: string } | null;
      } & UserErrorsPayload;
    }>(shopId, APP_USAGE_RECORD_CREATE, {
      subscriptionLineItemId,
      price: { amount, currencyCode: 'INR' },
      description,
    });
    throwOnUserErrors(data.appUsageRecordCreate);
    const gid = data.appUsageRecordCreate.appUsageRecord?.id;
    if (!gid) {
      throw new ShopifyBillingUserError([{ message: 'no usage record returned' }]);
    }
    return gid;
  }

  /** §3.20: the SUBMITTED → ACCEPTED promotion reads the record back. */
  async listUsageRecordGids(
    shopId: string,
    subscriptionGid: string,
  ): Promise<string[]> {
    const data = await this.graphql.queryForShop<{
      node: { usageRecords: { nodes: Array<{ id: string }> } } | null;
    }>(shopId, SUBSCRIPTION_USAGE_RECORDS, { id: subscriptionGid });
    return (data.node?.usageRecords.nodes ?? []).map((n) => n.id);
  }
}
