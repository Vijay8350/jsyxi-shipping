import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import {
  SETUP_HEALTH_CATALOG,
  SetupHealthState,
  catalogEntry,
} from './setup-health.catalog';

/**
 * ADD-29 setup-health object: a computed, stored per-Shop health record
 * (setup_health_item, migration 0017). `compute(shopId)` evaluates the exact
 * ADD-29 checklist and upserts one row per item:
 *
 *  - first_detected_at is written on INSERT only — the ON CONFLICT clause
 *    never touches it, so it is preserved across recomputes;
 *  - updated_at is bumped on every recompute;
 *  - rows whose item_key fell out of the catalog are deleted, so the stored
 *    object is always exactly the current catalog.
 *
 * Recompute triggers: the hourly BullMQ sweep (setup-health.scheduler.ts /
 * setup-health.processor.ts) and on demand — compute() is a plain injectable
 * method, called by the ADD-30 checklist when a shop has no stored rows yet
 * and by the POST /setup/health/recompute endpoint.
 *
 * The evaluation itself is the pure function `evaluateSetupHealth` below —
 * unit-tested without a database.
 *
 * ADD-31: the admin module reads setup_health_item directly (read-only,
 * no PII — state + detail strings carry counts and enum names only) and
 * resolves labels/deep links through setup-health.catalog. See module README
 * (OPS.md) for the read pattern.
 */

/** Webhook "receiving events" recency window (ADD-29). */
export const WEBHOOK_RECENCY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** 15-character Indian GSTIN format (2 state digits + 10-char PAN + entity
 *  + 'Z' + check char). Format check only — no checksum validation. */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export interface PickupLocationRow {
  name: string;
  address_lines: string[];
  city: string | null;
  state: string | null;
  pincode: string | null;
  phone: string | null;
  gstin: string | null;
}

export interface CourierAccountHealthRow {
  health_state: string;
  has_webhook_secret: boolean;
  last_event_received_at: string | null;
}

export interface EnabledServiceRow {
  service_id: string;
  courier_account_id: string;
  cost_source: string;
}

export interface RateCardRefRow {
  service_id: string;
  courier_account_id: string;
}

/** Everything the ADD-29 evaluation reads, pre-fetched and shop-scoped. */
export interface SetupHealthInput {
  pickupLocation: PickupLocationRow | null;
  courierAccounts: CourierAccountHealthRow[];
  enabledServices: EnabledServiceRow[];
  rateCards: RateCardRefRow[];
  defaultChain: unknown[] | null;
  hasLabelTemplate: boolean;
  hasDefaultPackageProfile: boolean;
  subscriptionState: string | null;
  now: Date;
}

export interface ComputedHealthItem {
  itemKey: string;
  state: SetupHealthState;
  detail: string | null;
}

const ok = (itemKey: string): ComputedHealthItem => ({
  itemKey,
  state: 'OK',
  detail: null,
});
const missing = (itemKey: string, detail: string): ComputedHealthItem => ({
  itemKey,
  state: 'MISSING',
  detail,
});
const broken = (itemKey: string, detail: string): ComputedHealthItem => ({
  itemKey,
  state: 'BROKEN',
  detail,
});

function evalPickupAddress(input: SetupHealthInput): ComputedHealthItem {
  const p = input.pickupLocation;
  if (!p) return missing('pickup_address', 'No active pickup location (INV-3).');
  const missingFields: string[] = [];
  if (!p.name) missingFields.push('name');
  if (!p.address_lines || p.address_lines.length === 0)
    missingFields.push('address');
  if (!p.city) missingFields.push('city');
  if (!p.state) missingFields.push('state');
  if (!p.pincode) missingFields.push('pincode');
  if (!p.phone) missingFields.push('phone');
  if (missingFields.length > 0) {
    return broken(
      'pickup_address',
      `Pickup address incomplete: missing ${missingFields.join(', ')}.`,
    );
  }
  return ok('pickup_address');
}

function evalGstin(input: SetupHealthInput): ComputedHealthItem {
  const gstin = input.pickupLocation?.gstin ?? null;
  if (!gstin) return missing('gstin', 'GSTIN not set on the pickup location.');
  if (!GSTIN_RE.test(gstin)) {
    return broken('gstin', 'GSTIN fails the 15-character format check.');
  }
  return ok('gstin');
}

function evalCourierAccount(input: SetupHealthInput): ComputedHealthItem {
  const accounts = input.courierAccounts;
  if (accounts.length === 0) {
    return missing('courier_account', 'No courier account connected.');
  }
  const healthy = accounts.filter((a) => a.health_state === 'HEALTHY').length;
  if (healthy === 0) {
    return broken(
      'courier_account',
      `${accounts.length} account(s) connected, none HEALTHY (§3.21).`,
    );
  }
  return ok('courier_account');
}

function evalEnabledService(input: SetupHealthInput): ComputedHealthItem {
  if (input.enabledServices.length === 0) {
    return missing('enabled_service', 'No merchant_service enabled.');
  }
  return ok('enabled_service');
}

function evalRateCards(input: SetupHealthInput): ComputedHealthItem {
  const covered = new Set(
    input.rateCards.map((r) => `${r.service_id}:${r.courier_account_id}`),
  );
  const gaps = input.enabledServices.filter(
    (s) =>
      s.cost_source === 'RATE_CARD' &&
      !covered.has(`${s.service_id}:${s.courier_account_id}`),
  );
  if (gaps.length > 0) {
    return missing(
      'rate_cards',
      `${gaps.length} enabled RATE_CARD service(s) without a rate card (§9.15).`,
    );
  }
  return ok('rate_cards');
}

function evalDefaultChain(input: SetupHealthInput): ComputedHealthItem {
  if (!Array.isArray(input.defaultChain) || input.defaultChain.length === 0) {
    return missing('default_chain', 'Default chain (S-22) not set.');
  }
  return ok('default_chain');
}

function evalWebhook(input: SetupHealthInput): ComputedHealthItem {
  const withSecret = input.courierAccounts.filter((a) => a.has_webhook_secret);
  if (withSecret.length === 0) {
    return missing(
      'webhook',
      'No courier account has a webhook signing secret (§8.5).',
    );
  }
  const cutoff = input.now.getTime() - WEBHOOK_RECENCY_MS;
  const receiving = withSecret.some(
    (a) =>
      a.last_event_received_at !== null &&
      new Date(a.last_event_received_at).getTime() >= cutoff,
  );
  if (!receiving) {
    return broken(
      'webhook',
      'Webhook secret set but no events received in the last 7 days.',
    );
  }
  return ok('webhook');
}

function evalLabelTemplate(input: SetupHealthInput): ComputedHealthItem {
  return input.hasLabelTemplate
    ? ok('label_template')
    : missing('label_template', 'No label_template row for the shop (§2.6).');
}

function evalPackageProfile(input: SetupHealthInput): ComputedHealthItem {
  // INV-24 mandates exactly one default per Shop, seeded day one (§5.6) —
  // its absence is a broken invariant, not a missing setup step.
  return input.hasDefaultPackageProfile
    ? ok('package_profile')
    : broken('package_profile', 'No default package profile (INV-24).');
}

function evalPlan(input: SetupHealthInput): ComputedHealthItem {
  if (input.subscriptionState === null) {
    return missing('plan', 'No subscription row for the shop.');
  }
  if (
    input.subscriptionState === 'TRIALING' ||
    input.subscriptionState === 'ACTIVE'
  ) {
    return ok('plan');
  }
  return broken('plan', `Subscription state is ${input.subscriptionState}.`);
}

/** The ADD-29 checklist, pure — every item always evaluated, catalog order. */
export function evaluateSetupHealth(
  input: SetupHealthInput,
): ComputedHealthItem[] {
  return [
    evalPickupAddress(input),
    evalGstin(input),
    evalCourierAccount(input),
    evalEnabledService(input),
    evalRateCards(input),
    evalDefaultChain(input),
    evalWebhook(input),
    evalLabelTemplate(input),
    evalPackageProfile(input),
    evalPlan(input),
  ];
}

export interface SetupHealthChecklistItem extends ComputedHealthItem {
  label: string;
  fixPath: string;
  firstDetectedAt: string | null;
  updatedAt: string | null;
}

export interface SetupHealthChecklist {
  /** ADD-30: true when every item is OK. */
  completed: boolean;
  items: SetupHealthChecklistItem[];
}

interface StoredItemRow {
  item_key: string;
  state: SetupHealthState;
  detail: string | null;
  first_detected_at: string;
  updated_at: string;
}

@Injectable()
export class SetupHealthService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** All ADD-29 inputs for one shop — every query shop-scoped (INV-1). */
  private async loadInput(shopId: string): Promise<SetupHealthInput> {
    const [pickup, accounts, services, rateCards, settings, template, profile, subscription] =
      await Promise.all([
        this.pool.query<PickupLocationRow>(
          `SELECT name, address_lines, city, state, pincode, phone, gstin
             FROM pickup_location
            WHERE shop_id = $1 AND is_active`,
          [shopId],
        ),
        this.pool.query<CourierAccountHealthRow>(
          `SELECT health_state,
                  webhook_secret_encrypted IS NOT NULL AS has_webhook_secret,
                  last_event_received_at
             FROM courier_account
            WHERE shop_id = $1 AND disabled_at IS NULL`,
          [shopId],
        ),
        this.pool.query<EnabledServiceRow>(
          `SELECT ms.service_id, ms.courier_account_id, s.cost_source
             FROM merchant_service ms
             JOIN service s ON s.service_id = ms.service_id
            WHERE ms.shop_id = $1 AND ms.enabled`,
          [shopId],
        ),
        this.pool.query<RateCardRefRow>(
          `SELECT service_id, courier_account_id
             FROM rate_card
            WHERE shop_id = $1`,
          [shopId],
        ),
        this.pool.query<{ default_chain: unknown[] | null }>(
          `SELECT default_chain FROM order_sync_settings WHERE shop_id = $1`,
          [shopId],
        ),
        this.pool.query(
          `SELECT 1 AS present FROM label_template WHERE shop_id = $1`,
          [shopId],
        ),
        this.pool.query(
          `SELECT 1 AS present FROM package_profile
            WHERE shop_id = $1 AND is_default`,
          [shopId],
        ),
        this.pool.query<{ state: string }>(
          `SELECT state FROM subscription
            WHERE shop_id = $1
            ORDER BY created_at DESC
            LIMIT 1`,
          [shopId],
        ),
      ]);
    return {
      pickupLocation: pickup.rows[0] ?? null,
      courierAccounts: accounts.rows.map((r) => ({
        ...r,
        last_event_received_at:
          r.last_event_received_at === null
            ? null
            : String(r.last_event_received_at),
      })),
      enabledServices: services.rows,
      rateCards: rateCards.rows,
      defaultChain: settings.rows[0]?.default_chain ?? null,
      hasLabelTemplate: template.rows.length > 0,
      hasDefaultPackageProfile: profile.rows.length > 0,
      subscriptionState: subscription.rows[0]?.state ?? null,
      now: new Date(),
    };
  }

  /**
   * Evaluate ADD-29 and persist. Upsert keeps first_detected_at (written on
   * insert only) and always bumps updated_at; stale item_keys are removed.
   */
  async compute(shopId: string): Promise<ComputedHealthItem[]> {
    const items = evaluateSetupHealth(await this.loadInput(shopId));
    for (const item of items) {
      await this.pool.query(
        `INSERT INTO setup_health_item (shop_id, item_key, state, detail)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (shop_id, item_key) DO UPDATE
            SET state = EXCLUDED.state,
                detail = EXCLUDED.detail,
                updated_at = now()`,
        [shopId, item.itemKey, item.state, item.detail],
      );
    }
    await this.pool.query(
      `DELETE FROM setup_health_item
        WHERE shop_id = $1 AND item_key <> ALL($2::text[])`,
      [shopId, SETUP_HEALTH_CATALOG.map((e) => e.itemKey)],
    );
    return items;
  }

  /** Hourly sweep entry (BullMQ thin shell calls this per shop). */
  async computeSweep(shopId: string): Promise<ComputedHealthItem[]> {
    return this.compute(shopId);
  }

  /**
   * ADD-30 merchant checklist: stored items joined with the code catalog.
   * A shop with no stored rows yet (fresh install, before the first hourly
   * sweep) is computed on demand so the checklist never renders empty.
   */
  async getChecklist(shopId: string): Promise<SetupHealthChecklist> {
    let { rows } = await this.pool.query<StoredItemRow>(
      `SELECT item_key, state, detail, first_detected_at, updated_at
         FROM setup_health_item
        WHERE shop_id = $1`,
      [shopId],
    );
    if (rows.length === 0) {
      await this.compute(shopId);
      ({ rows } = await this.pool.query<StoredItemRow>(
        `SELECT item_key, state, detail, first_detected_at, updated_at
           FROM setup_health_item
          WHERE shop_id = $1`,
        [shopId],
      ));
    }
    const byKey = new Map(rows.map((r) => [r.item_key, r]));
    const items: SetupHealthChecklistItem[] = SETUP_HEALTH_CATALOG.map(
      (cat) => {
        const stored = byKey.get(cat.itemKey);
        return {
          itemKey: cat.itemKey,
          label: cat.label,
          fixPath: cat.fixPath,
          state: stored?.state ?? 'MISSING',
          detail: stored?.detail ?? 'Not yet evaluated.',
          firstDetectedAt: stored?.first_detected_at ?? null,
          updatedAt: stored?.updated_at ?? null,
        };
      },
    );
    return {
      completed: items.every((i) => i.state === 'OK'),
      items,
    };
  }
}

/** Re-export so the ADD-31 reader and tests resolve catalog entries through
 *  one import site. */
export { catalogEntry };
