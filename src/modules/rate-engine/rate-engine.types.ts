/**
 * Rate-engine DB row types (§2.3) — snake_case mirrors of migration 0006.
 * NUMERIC columns arrive from pg as strings; money is converted to paise only
 * inside pricing.ts, never computed on here.
 */

import type { payment_mode } from '../courier-framework/adapter.enum-types';
import type { ComponentBasis, RtoBasis, ZoneCode } from './pricing';

export interface RateCardRow {
  rate_card_id: string;
  shop_id: string;
  service_id: string;
  courier_account_id: string;
  name: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RateCardVersionRow {
  rate_card_version_id: string;
  rate_card_id: string;
  effective_from: string;
  effective_to: string | null;
  zone_map_id: string;
  fuel_pct: string;
  cod_flat: string;
  cod_pct: string;
  rto_basis: RtoBasis;
  rto_pct: string | null;
  gst_pct: string;
  component_order: string[];
  taxable_components: string[];
  is_sealed: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RateCardSlabRow {
  slab_id: string;
  rate_card_version_id: string;
  zone: ZoneCode;
  base_weight_kg: string;
  base_rate: string;
  additional_step_kg: string;
  additional_rate: string;
}

export interface RateCardComponentRow {
  component_id: string;
  rate_card_version_id: string;
  code: string;
  label: string;
  basis: ComponentBasis;
  value: string;
  is_taxable: boolean;
  position: number;
}

export interface ZoneMapRow {
  zone_map_id: string;
  shop_id: string;
  service_id: string;
  label: string;
  effective_from: string;
  postal_version_id: string;
  is_sealed: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ZoneRuleRow {
  zone_rule_id: string;
  zone_map_id: string;
  origin_matcher: unknown;
  destination_matcher: unknown;
  zone: ZoneCode;
  position: number;
}

export interface ServiceVersionRow {
  service_version_id: string;
  service_id: string;
  effective_from: string;
  volumetric_divisor: string | null;
  min_billable_kg: string;
  billable_increment_kg: string;
  supports_cod: boolean;
  supports_reverse: boolean;
  is_sealed: boolean;
}

export interface PostalPincodeRow {
  postal_pincode_id: string;
  postal_version_id: string;
  pincode: string;
  city: string | null;
  district: string | null;
  state: string | null;
  region: string | null;
  is_metro: boolean;
  is_special: boolean;
}

/** estimateCost input (§9.15, §8.3 request minus adapter-owned fields). */
export interface EstimateCostInput {
  shopId: string;
  serviceId: string;
  destinationPincode: string;
  /** F-24 dead weight, 3dp kg text. */
  deadWeightKg: string;
  /** Package dims, 2dp cm text. */
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  paymentMode: payment_mode;
  /** 2dp text; '0.00' for prepaid. */
  collectible: string;
  /** 2dp text; the ADD-41 insurance basis. */
  declaredValue: string;
  /** ISO date — selects the effective rate_card_version / service_version. */
  shipDate: string;
}

export function isPgErrorWithMessage(err: unknown, needle: string): boolean {
  return err instanceof Error && err.message.includes(needle);
}
