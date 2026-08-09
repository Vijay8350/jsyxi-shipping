/**
 * ADD-29 / ADD-30 setup-health item catalog. The stored object
 * (`setup_health_item`, migration 0017) carries only (item_key, state,
 * detail, first_detected_at, updated_at); the presentation metadata — label
 * and the deep link to the screen that fixes the item — lives here in code,
 * exactly as the migration comment prescribes ("the item catalog (deep
 * links, labels) lives in code").
 *
 * fixPath values are app.jsyxi.com dashboard routes (§9.1.1 non-embedded
 * app). The ADD-30 checklist and the ADD-31 admin health board both resolve
 * item_key through this one catalog, so a renamed screen changes in one
 * place.
 */

export type SetupHealthState = 'OK' | 'MISSING' | 'BROKEN';

export interface SetupHealthCatalogEntry {
  /** Stable key — the setup_health_item primary-key component. */
  readonly itemKey: string;
  /** ADD-30 checklist label. */
  readonly label: string;
  /** Deep link to the screen that fixes the item. */
  readonly fixPath: string;
}

const entry = (
  itemKey: string,
  label: string,
  fixPath: string,
): SetupHealthCatalogEntry => ({ itemKey, label, fixPath });

/** ADD-29 checklist — one entry per evaluated item, in display order. */
export const SETUP_HEALTH_CATALOG: readonly SetupHealthCatalogEntry[] = [
  entry(
    'pickup_address',
    'Pickup address present and complete',
    '/settings/pickup-address',
  ),
  entry(
    'gstin',
    'GSTIN present and valid',
    '/settings/pickup-address', // the seller GSTIN lives on the pickup location (migration 0003)
  ),
  entry(
    'courier_account',
    'At least one courier account connected and HEALTHY',
    '/settings/couriers',
  ),
  entry(
    'enabled_service',
    'At least one service enabled',
    '/settings/services',
  ),
  entry(
    'rate_cards',
    'Every enabled RATE_CARD service has a rate card',
    '/settings/rate-cards',
  ),
  entry(
    'default_chain',
    'Default chain (S-22) set',
    '/rules',
  ),
  entry(
    'webhook',
    'Webhook configured and receiving events',
    '/settings/webhooks',
  ),
  entry(
    'label_template',
    'Label template selected',
    '/settings/labels',
  ),
  entry(
    'package_profile',
    'Default package profile present (INV-24)',
    '/settings/packages',
  ),
  entry(
    'plan',
    'Plan active',
    '/settings/billing',
  ),
] as const;

export type SetupHealthItemKey =
  (typeof SETUP_HEALTH_CATALOG)[number]['itemKey'];

const BY_KEY = new Map(SETUP_HEALTH_CATALOG.map((e) => [e.itemKey, e]));

/** Catalog lookup; throws on a key the catalog does not know (programming
 *  error — stored keys are written only by SetupHealthService). */
export function catalogEntry(itemKey: string): SetupHealthCatalogEntry {
  const found = BY_KEY.get(itemKey);
  if (!found) throw new Error(`unknown setup-health item '${itemKey}'`);
  return found;
}
