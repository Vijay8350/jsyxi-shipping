/**
 * Loose typings for the Shopify order payload the mapper consumes
 * (§8.1 field mapping). The primary shape is the REST webhook JSON
 * (orders/* topics); the hourly sweep reshapes its GraphQL nodes into this
 * same shape so there is exactly ONE mapper (S-15, §8.1 gap recovery).
 */

export interface ShopifyMoneySet {
  shop_money?: { amount?: string; currency_code?: string } | null;
  presentment_money?: { amount?: string; currency_code?: string } | null;
}

export interface ShopifyRestAddress {
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface ShopifyRestLineItem {
  id?: number | string | null;
  admin_graphql_api_id?: string | null;
  sku?: string | null;
  title?: string | null;
  name?: string | null;
  variant_title?: string | null;
  quantity?: number | null;
  price?: string | null;
  price_set?: ShopifyMoneySet | null;
  tags?: string | string[] | null;
  grams?: number | null;
  hsn_code?: string | null;
  harmonized_system_code?: string | null;
}

export interface ShopifyRestShippingLine {
  title?: string | null;
  price?: string | null;
  price_set?: ShopifyMoneySet | null;
}

export interface ShopifyRestOrderPayload {
  id?: number | string | null;
  admin_graphql_api_id?: string | null;
  order_number?: number | string | null;
  name?: string | null;
  created_at?: string | null;
  email?: string | null;
  phone?: string | null;
  test?: boolean | null;
  current_total_price_set?: ShopifyMoneySet | null;
  /** F-15 basis (§4.6): Shopify's own total_outstanding IS F-17 − captured −
   *  refunds. REST carries both a plain amount and the money set. */
  total_outstanding?: string | null;
  total_outstanding_set?: ShopifyMoneySet | null;
  payment_gateway_names?: string[] | null;
  shipping_address?: ShopifyRestAddress | null;
  customer?: { email?: string | null } | null;
  line_items?: ShopifyRestLineItem[] | null;
  shipping_lines?: ShopifyRestShippingLine[] | null;
  /** Risk flag "where present, else null" (§8.1): either a sweep-reshaped
   *  risk_level or the REST order_risks list. */
  risk_level?: string | null;
  order_risks?: Array<{ recommendation?: string | null }> | null;
  fulfillment_status?: string | null;
}
