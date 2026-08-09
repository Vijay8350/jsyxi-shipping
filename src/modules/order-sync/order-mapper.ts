import { paiseToRupees, rupeesToPaise } from '../../common/money';
import { WorkingRecipient } from './working-values.types';
import { ShopifyRestLineItem, ShopifyRestOrderPayload } from './shopify-order-payload.types';

/**
 * §8.1 order field mapping + ADD-06/ADD-07 — normalizes one Shopify order
 * payload (REST webhook JSON shape) into row-ready values for `order` and
 * `order_line`. Pure: no DB, no network, no clock — fully unit-testable.
 *
 * Boundaries:
 *  - Money arrives as strings; it is normalized through src/common/money.ts
 *    (paise integers internally) and re-emitted as 2dp NUMERIC text. Never a
 *    float, never sub-paise precision (INV-15, §4.1).
 *  - payment_mode is NOT derived here — the raw gateway names are carried
 *    through as working data for the week-4 §3.5/S-14 derivation; the column
 *    stays 'UNRESOLVED' (its default) until that agent owns it.
 *  - A missing shipping address yields recipientSnapshot = null — the order
 *    stays INCOMPLETE later (INV-7); a recipient is never guessed (§8.1).
 */

export interface MappedOrderLine {
  shopifyLineGid: string | null;
  sku: string | null;
  title: string | null;
  variant: string | null;
  quantity: number;
  /** 2dp NUMERIC text (shop money) or null. */
  unitPrice: string | null;
  tags: string[];
  /** Nullable per §8.1/§9.9. */
  hsnCode: string | null;
  /** Per UNIT, kg as 3dp NUMERIC text (RV-02); null where absent. */
  weightKgPerUnit: string | null;
}

export interface MappedOrder {
  shopifyOrderGid: string;
  shopifyOrderNumber: string | null;
  createdAtShopify: string | null;
  /** F-17: current_total_price_set.shop_money, 2dp NUMERIC text. */
  orderAmount: string | null;
  /** Display only (A2-04). */
  presentmentAmount: string | null;
  presentmentCurrency: string | null;
  recipientSnapshot: WorkingRecipient | null;
  riskFlag: string | null;
  isTestOrder: boolean;
  /** Raw gateway names — working data for the week-4 §3.5 derivation. */
  gatewayNames: string[];
  /** Shopify total_outstanding (shop money) — preferred F-15 basis (§4.6). */
  totalOutstandingShopMoney: string | null;
  /** ADD-06: the shipping line title the buyer selected. */
  checkoutShippingTitle: string | null;
  /** ADD-07: the same shipping line's shop-money amount. */
  checkoutShippingAmount: string | null;
  lines: MappedOrderLine[];
}

/** Thrown when the required §8.1 key is absent — the row cannot be keyed,
 *  so the ingest fails loudly (inbox → FAILED for the §8.6 retry path)
 *  rather than dropping silently (INV-20). */
export class UnmappableOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnmappableOrderError';
  }
}

/** Money boundary (§4.1, INV-15): "123.45" → "123.45"; invalid or sub-paise
 *  input → null (never a guess, never a float). */
export function normalizeMoney(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  try {
    return paiseToRupees(rupeesToPaise(value));
  } catch {
    return null;
  }
}

function nullIfBlank(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function mapTags(tags: string | string[] | null | undefined): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map((t) => t.trim()).filter((t) => t !== '');
  return tags.split(',').map((t) => t.trim()).filter((t) => t !== '');
}

/** REST line items carry per-unit weight as integer grams (RV-02). */
function mapWeightKg(grams: number | null | undefined): string | null {
  if (grams === null || grams === undefined || !Number.isFinite(grams) || grams <= 0) return null;
  return (grams / 1000).toFixed(3);
}

export function mapLineItem(line: ShopifyRestLineItem): MappedOrderLine {
  return {
    shopifyLineGid:
      nullIfBlank(line.admin_graphql_api_id) ??
      (line.id !== null && line.id !== undefined ? `gid://shopify/LineItem/${line.id}` : null),
    sku: nullIfBlank(line.sku),
    title: nullIfBlank(line.title) ?? nullIfBlank(line.name),
    variant: nullIfBlank(line.variant_title),
    quantity: line.quantity && line.quantity > 0 ? Math.trunc(line.quantity) : 1,
    // Shop money, per §8.1's money mapping; the plain `price` fallback is
    // already shop currency in the REST webhook payload.
    unitPrice: normalizeMoney(line.price_set?.shop_money?.amount ?? line.price),
    tags: mapTags(line.tags),
    hsnCode: nullIfBlank(line.hsn_code) ?? nullIfBlank(line.harmonized_system_code),
    weightKgPerUnit: mapWeightKg(line.grams),
  };
}

/** §8.1 + RV-13: the protected recipient set; null address → null snapshot
 *  (INCOMPLETE later, never guessed). */
export function mapRecipient(payload: ShopifyRestOrderPayload): WorkingRecipient | null {
  const addr = payload.shipping_address;
  if (!addr) return null;
  const joined = [addr.first_name, addr.last_name]
    .map((p) => (p ?? '').trim())
    .filter((p) => p !== '')
    .join(' ');
  const name = nullIfBlank(addr.name) ?? (joined === '' ? null : joined);
  return {
    name,
    addressLines: [addr.address1, addr.address2]
      .map((l) => (l ?? '').trim())
      .filter((l) => l !== ''),
    city: nullIfBlank(addr.city),
    state: nullIfBlank(addr.province),
    pincode: nullIfBlank(addr.zip),
    phone: nullIfBlank(addr.phone) ?? nullIfBlank(payload.phone),
    email: nullIfBlank(addr.email) ?? nullIfBlank(payload.email) ?? nullIfBlank(payload.customer?.email),
  };
}

export function mapShopifyOrder(payload: ShopifyRestOrderPayload): MappedOrder {
  // §8.1: shopify_order_gid is REQUIRED — it keys the upsert.
  const gid =
    nullIfBlank(payload.admin_graphql_api_id) ??
    (payload.id !== null && payload.id !== undefined
      ? `gid://shopify/Order/${payload.id}`
      : null);
  if (!gid) throw new UnmappableOrderError('order payload has no shopify_order_gid');

  // ADD-06/ADD-07: the buyer-selected shipping line (first line carries the
  // selected rate; title and shop-money amount are mirrored verbatim).
  const shippingLine = payload.shipping_lines?.[0];

  return {
    shopifyOrderGid: gid,
    shopifyOrderNumber:
      payload.order_number !== null && payload.order_number !== undefined
        ? String(payload.order_number)
        : nullIfBlank(payload.name),
    createdAtShopify: nullIfBlank(payload.created_at),
    orderAmount: normalizeMoney(payload.current_total_price_set?.shop_money?.amount),
    presentmentAmount: normalizeMoney(payload.current_total_price_set?.presentment_money?.amount),
    presentmentCurrency: nullIfBlank(payload.current_total_price_set?.presentment_money?.currency_code),
    recipientSnapshot: mapRecipient(payload),
    riskFlag:
      nullIfBlank(payload.risk_level) ?? nullIfBlank(payload.order_risks?.[0]?.recommendation),
    isTestOrder: payload.test === true,
    gatewayNames: (payload.payment_gateway_names ?? [])
      .map((g) => (g ?? '').trim())
      .filter((g) => g !== ''),
    totalOutstandingShopMoney: normalizeMoney(
      payload.total_outstanding_set?.shop_money?.amount ?? payload.total_outstanding,
    ),
    checkoutShippingTitle: nullIfBlank(shippingLine?.title),
    checkoutShippingAmount: normalizeMoney(
      shippingLine?.price_set?.shop_money?.amount ?? shippingLine?.price,
    ),
    lines: (payload.line_items ?? []).map(mapLineItem),
  };
}
