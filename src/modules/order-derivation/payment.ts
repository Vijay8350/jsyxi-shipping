import { paiseToRupees, rupeesToPaise } from '../../common/money';

/**
 * §3.5 PAYMENT_MODE + F-15 order COD outstanding (§4.6) — pure derivations.
 *
 * S-14 (§7.2) is the merchant-maintained list of COD gateway names
 * (order_sync_settings.cod_gateway_map, a JSON array of gateway name strings).
 * Classification per gateway name on the order:
 *   - present in the map  → a COD entry
 *   - absent from the map → a prepaid entry
 * An order with NO gateway names is the §3.5 "unmapped gateway" case.
 * Matching is exact (the S-14 seed carries case variants like "COD"/"cod",
 * which shows the merchant maintains exact strings).
 *
 * F-15 (§4.6) = F-17 − amounts already captured or paid − refunds, floored
 * at 0, in shop money. DERIVATION CHOICE (documented for the parent): the
 * week-3 order mapper does not carry Shopify's `total_outstanding`, captured
 * or refund amounts, and no schema column holds them. So:
 *   - when `totalOutstandingShopMoney` is supplied (Shopify computes exactly
 *     F-17 − captured − refunds), it is used verbatim, floored at 0;
 *   - otherwise the gateway heuristic applies: an order carrying a COD-mapped
 *     gateway has nothing captured on its collectible balance, so F-15 = F-17;
 *     an order whose gateways are all prepaid was paid at checkout, so F-15 = 0;
 *   - F-17 itself missing while a COD balance might exist → null (the §3.5
 *     "collectible balance cannot be determined" case → UNRESOLVED).
 * The shared change to carry `total_outstanding` shop money through
 * order-mapper → "order" is flagged in the week-4 handoff.
 */

export interface CodOutstandingInput {
  /** F-17 (order.order_amount), NUMERIC text; null when unmapped. */
  orderAmountF17: string | null;
  /** Shopify total_outstanding shop money, when the payload carries it. */
  totalOutstandingShopMoney?: string | null;
  /** Whether any gateway on the order matches an S-14 COD entry. */
  hasCodMappedGateway: boolean;
}

export type CodOutstandingBasis = 'TOTAL_OUTSTANDING' | 'COD_GATEWAY' | 'PREPAID_GATEWAYS' | 'UNDETERMINED';

export interface CodOutstandingResult {
  /** F-15, 2dp NUMERIC text; null when it cannot be determined (§3.5). */
  codOutstanding: string | null;
  basis: CodOutstandingBasis;
}

export function deriveCodOutstanding(input: CodOutstandingInput): CodOutstandingResult {
  // Preferred basis: Shopify's own total_outstanding IS F-17 − captured − refunds.
  if (input.totalOutstandingShopMoney !== null && input.totalOutstandingShopMoney !== undefined) {
    const paise = rupeesToPaise(input.totalOutstandingShopMoney);
    // §4.6: floored at 0.
    return { codOutstanding: paiseToRupees(paise > 0n ? paise : 0n), basis: 'TOTAL_OUTSTANDING' };
  }
  if (input.hasCodMappedGateway) {
    if (input.orderAmountF17 === null) {
      // §3.5: "a COD-mapped gateway whose collectible balance cannot be
      // determined" → UNRESOLVED downstream.
      return { codOutstanding: null, basis: 'UNDETERMINED' };
    }
    const paise = rupeesToPaise(input.orderAmountF17);
    return { codOutstanding: paiseToRupees(paise > 0n ? paise : 0n), basis: 'COD_GATEWAY' };
  }
  // All-prepaid gateways: paid at checkout, nothing collectible.
  return { codOutstanding: paiseToRupees(0n), basis: 'PREPAID_GATEWAYS' };
}

export type PaymentMode = 'PREPAID' | 'COD' | 'UNRESOLVED';

export interface PaymentModeInput {
  gatewayNames: string[];
  /** S-14: exact gateway names that mean COD. */
  codGatewayMap: string[];
  /** F-15 from deriveCodOutstanding; null = cannot be determined. */
  codOutstanding: string | null;
}

/** §3.5 (A1-03): COD requires BOTH a COD gateway match AND F-15 > 0. */
export function derivePaymentMode(input: PaymentModeInput): PaymentMode {
  const codSet = new Set(input.codGatewayMap);
  const hasCod = input.gatewayNames.some((g) => codSet.has(g));
  const hasPrepaid = input.gatewayNames.some((g) => !codSet.has(g));

  // §3.5: the unmapped gateway — nothing to classify.
  if (input.gatewayNames.length === 0) return 'UNRESOLVED';
  // §3.5: the mixed case — a mapped COD gateway alongside a prepaid one.
  if (hasCod && hasPrepaid) return 'UNRESOLVED';

  if (hasCod) {
    // §3.5: collectible balance undeterminable → UNRESOLVED; F-15 = 0 means
    // fully prepaid / captured / refunded → PREPAID, not COD; else COD.
    if (input.codOutstanding === null) return 'UNRESOLVED';
    return rupeesToPaise(input.codOutstanding) > 0n ? 'COD' : 'PREPAID';
  }

  // All gateways map to prepaid entries. §3.5: PREPAID requires F-15 = 0;
  // a positive balance with no COD gateway cannot be explained → UNRESOLVED.
  if (input.codOutstanding === null) return 'UNRESOLVED';
  return rupeesToPaise(input.codOutstanding) > 0n ? 'UNRESOLVED' : 'PREPAID';
}
