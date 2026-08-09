import type { Pool } from 'pg';
import { ADAPTER_METHODS } from '../courier-framework/adapter.types';
import { AMAZON_SHIPPING_COURIER_CODE } from './amazon_shipping-api.map';
import {
  AMAZON_SHIPPING_GETQUOTE_FALLBACK_NOTE,
  AMAZON_SHIPPING_NDR_FALLBACK_NOTE,
  AMAZON_SHIPPING_PICKUP_FALLBACK_NOTE,
} from './amazon_shipping.adapter';

/**
 * Amazon Shipping seed (§9.3.4 launch adapter): the global courier row, its
 * credential form schema (A1-12), §8.2 capabilities, starter Services with
 * versioned volumetric rules (§4.2–§4.4), and the starter
 * courier_status_map (§3.6 — the only mapping target, A2-06).
 *
 * Exported as data (AMAZON_SHIPPING_SEED) plus runAmazonShippingSeed(pool)
 * performing idempotent upserts, so it is safe to re-run at every deploy.
 */

/** §3.6 CARRIER_EVENT_STATUS (mirrored from migration 0006; RV-07). */
export const CARRIER_EVENT_STATUSES = [
  'PICKUP_SCHEDULED',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'UNDELIVERED_ATTEMPT',
  'RTO_INITIATED',
  'RTO_IN_TRANSIT',
  'RTO_OUT_FOR_DELIVERY',
  'RTO_DELIVERED',
  'LOST_OR_DAMAGED',
  'CANCELLED_BY_COURIER',
] as const;
export type CarrierEventStatus = (typeof CARRIER_EVENT_STATUSES)[number];

export interface StatusMapRow {
  /** Normalized case-folded (lowercase) before write — migration 0006;
   *  tracking.util foldRawStatus lowercases and collapses whitespace, so
   *  CamelCase event codes fold to their no-space lowercase form. */
  rawStatus: string;
  carrierEventStatus: CarrierEventStatus;
  /** Why, where the mapping is ambiguous. */
  note: string | null;
}

/** The §8.2 methods this adapter declares unsupported (A1-03) with their
 *  manual fallback notes — mirrored by AmazonShippingAdapter.unsupportedMethods. */
const UNSUPPORTED_NOTES: Record<string, string> = {
  getQuote: AMAZON_SHIPPING_GETQUOTE_FALLBACK_NOTE,
  schedulePickup: AMAZON_SHIPPING_PICKUP_FALLBACK_NOTE,
  ndrAction: AMAZON_SHIPPING_NDR_FALLBACK_NOTE,
};

export const AMAZON_SHIPPING_SEED = {
  courier: {
    code: AMAZON_SHIPPING_COURIER_CODE,
    name: 'Amazon Shipping',
    kind: 'DIRECT', // §9.3.4: Amazon Shipping is a DIRECT courier (BYOC)
    authPattern: 'OAUTH', // Login with Amazon (§9.3.3)
  },
  /** courier_credential_field rows (drives the merchant form, A1-12;
   *  is_secret fields are write-only with masked display, §5.7 control 3).
   *  OAUTH (§9.3.3): the LWA refresh_token and client_secret are secrets;
   *  the LWA app's client_id identifies the app and is not a secret. */
  credentialFields: [
    {
      key: 'refresh_token',
      label: 'LWA refresh token (from Login with Amazon consent)',
      type: 'password',
      isSecret: true,
      isRequired: true,
      validationRegex: null as string | null,
      displayOrder: 1,
    },
    {
      key: 'client_id',
      label: 'LWA app client ID',
      type: 'text',
      isSecret: false,
      isRequired: true,
      validationRegex: null as string | null,
      displayOrder: 2,
    },
    {
      key: 'client_secret',
      label: 'LWA app client secret',
      type: 'password',
      isSecret: true,
      isRequired: true,
      validationRegex: null as string | null,
      displayOrder: 3,
    },
      {
      // The merchant's courier-registered pickup identity. NOT a secret — it
      // is an account reference, and masking it would only stop the merchant
      // checking what they typed. Optional so an existing account keeps
      // working; when unset the adapter falls back to the internal id, which
      // is the pre-existing (wrong) behaviour rather than a new failure.
      key: 'pickup_code',
      label: 'Ship-from address ID',
      type: 'text',
      isSecret: false,
      isRequired: false,
      validationRegex: null as string | null,
      displayOrder: 4,
    },
  ],
  /**
   * §8.2 capabilities: Amazon Shipping implements 5 of 8 adapter methods.
   * getQuote is supported = false (A1-03): the Services are
   * cost_source = RATE_CARD (§3.7), so pricing and lane serviceability come
   * from the merchant's rate card via the §4.5 cost engine. schedulePickup
   * and ndrAction are supported = false (A1-03): Amazon Shipping
   * auto-collects under most merchant contracts and no NDR action endpoint
   * is mapped at v1. The adapter throws UnsupportedCapabilityError, never a
   * silent no-op.
   */
  capabilities: ADAPTER_METHODS.map((capability) => ({
    capability,
    supported: !(capability in UNSUPPORTED_NOTES),
    manualFallbackNote: UNSUPPORTED_NOTES[capability] ?? null,
  })),
  /** Services (§9.3.2): labels are always the courier's own PDF
   *  (COURIER_PDF_REQUIRED, §9.9.1); pricing comes from the merchant's
   *  uploaded rate card (RATE_CARD, §3.7 — BYOC, INV-23). */
  services: [
    {
      code: 'AMAZON_SHIPPING_STANDARD',
      name: 'Amazon Shipping Standard',
      labelMode: 'COURIER_PDF_REQUIRED',
      costSource: 'RATE_CARD',
    },
    {
      code: 'AMAZON_SHIPPING_EXPRESS',
      name: 'Amazon Shipping Express',
      labelMode: 'COURIER_PDF_REQUIRED',
      costSource: 'RATE_CARD',
    },
  ],
  /** One starter service_version per service (§4.2–§4.4): divisor 5000,
   *  minimum billable 0.5 kg, increment 0.5 kg. */
  serviceVersion: {
    effectiveFrom: '2026-01-01',
    volumetricDivisor: '5000',
    minBillableKg: '0.500',
    billableIncrementKg: '0.500',
    supportsCod: true,
  },
  /**
   * Starter courier_status_map (§3.6). Raw statuses are Amazon Shipping's
   * best-known tracking event codes, stored case-folded exactly as
   * tracking.util foldRawStatus folds them (CamelCase → lowercase, no
   * spaces). TODO(sandbox-verify): the exact eventCode vocabulary against
   * sandbox tracking payloads. Every mapping is conservative.
   */
  statusMap: [
    // Booked/awaiting pickup — conservative: the closest §3.6 value is
    // PICKUP_SCHEDULED (no "manifested" value).
    { rawStatus: 'labelpurchased', carrierEventStatus: 'PICKUP_SCHEDULED', note: 'booked, awaiting pickup' },
    { rawStatus: 'readyforreceive', carrierEventStatus: 'PICKUP_SCHEDULED', note: 'awaiting carrier collection' },
    { rawStatus: 'pickupdone', carrierEventStatus: 'PICKED_UP', note: null },
    { rawStatus: 'departed', carrierEventStatus: 'IN_TRANSIT', note: null },
    { rawStatus: 'arrived', carrierEventStatus: 'IN_TRANSIT', note: 'facility arrival is still in transit' },
    { rawStatus: 'intransit', carrierEventStatus: 'IN_TRANSIT', note: null },
    { rawStatus: 'outfordelivery', carrierEventStatus: 'OUT_FOR_DELIVERY', note: null },
    { rawStatus: 'delivered', carrierEventStatus: 'DELIVERED', note: null },
    // A failed delivery attempt (NDR reasons ride as the reason text), not
    // a terminal state. A recipient refusal is conservatively an attempt.
    { rawStatus: 'deliveryattempted', carrierEventStatus: 'UNDELIVERED_ATTEMPT', note: null },
    { rawStatus: 'rejected', carrierEventStatus: 'UNDELIVERED_ATTEMPT', note: 'recipient refusal treated as a failed attempt' },
    // "Undeliverable" parcels return to origin under Amazon contracts.
    { rawStatus: 'undeliverable', carrierEventStatus: 'RTO_INITIATED', note: 'returns to origin under Amazon contracts' },
    { rawStatus: 'returninitiated', carrierEventStatus: 'RTO_INITIATED', note: null },
    { rawStatus: 'returnintransit', carrierEventStatus: 'RTO_IN_TRANSIT', note: null },
    { rawStatus: 'returnoutfordelivery', carrierEventStatus: 'RTO_OUT_FOR_DELIVERY', note: null },
    { rawStatus: 'returndelivered', carrierEventStatus: 'RTO_DELIVERED', note: null },
    { rawStatus: 'lost', carrierEventStatus: 'LOST_OR_DAMAGED', note: null },
    { rawStatus: 'damaged', carrierEventStatus: 'LOST_OR_DAMAGED', note: null },
    { rawStatus: 'cancelled', carrierEventStatus: 'CANCELLED_BY_COURIER', note: null },
  ] as StatusMapRow[],
};

/**
 * Idempotent upserts for every Amazon Shipping seed row. Safe to re-run on
 * each deploy; never touches sealed versions (INV-11 trigger would reject
 * the write anyway — the update below targets only unsealed starter rows).
 */
export async function runAmazonShippingSeed(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const courierRes = await client.query<{ courier_id: string }>(
      `INSERT INTO courier (code, name, kind, auth_pattern)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name,
             kind = EXCLUDED.kind,
             auth_pattern = EXCLUDED.auth_pattern
       RETURNING courier_id`,
      [
        AMAZON_SHIPPING_SEED.courier.code,
        AMAZON_SHIPPING_SEED.courier.name,
        AMAZON_SHIPPING_SEED.courier.kind,
        AMAZON_SHIPPING_SEED.courier.authPattern,
      ],
    );
    const courierId = courierRes.rows[0].courier_id;

    for (const f of AMAZON_SHIPPING_SEED.credentialFields) {
      await client.query(
        `INSERT INTO courier_credential_field
           (courier_id, key, label, type, is_secret, is_required, validation_regex, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (courier_id, key) DO UPDATE
           SET label = EXCLUDED.label,
               type = EXCLUDED.type,
               is_secret = EXCLUDED.is_secret,
               is_required = EXCLUDED.is_required,
               validation_regex = EXCLUDED.validation_regex,
               display_order = EXCLUDED.display_order`,
        [courierId, f.key, f.label, f.type, f.isSecret, f.isRequired, f.validationRegex, f.displayOrder],
      );
    }

    for (const c of AMAZON_SHIPPING_SEED.capabilities) {
      await client.query(
        `INSERT INTO courier_capability (courier_id, capability, supported, manual_fallback_note)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (courier_id, capability) DO UPDATE
           SET supported = EXCLUDED.supported,
               manual_fallback_note = EXCLUDED.manual_fallback_note`,
        [courierId, c.capability, c.supported, c.manualFallbackNote],
      );
    }

    const v = AMAZON_SHIPPING_SEED.serviceVersion;
    for (const s of AMAZON_SHIPPING_SEED.services) {
      const serviceRes = await client.query<{ service_id: string }>(
        `INSERT INTO service (courier_id, code, name, label_mode, cost_source)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (courier_id, code) DO UPDATE
           SET name = EXCLUDED.name,
               label_mode = EXCLUDED.label_mode,
               cost_source = EXCLUDED.cost_source
         RETURNING service_id`,
        [courierId, s.code, s.name, s.labelMode, s.costSource],
      );
      const serviceId = serviceRes.rows[0].service_id;

      // service_version has no natural unique key: upsert the unsealed
      // starter row by (service_id, effective_from). A sealed row (INV-11)
      // is left untouched — a new version row is inserted instead.
      const existing = await client.query<{ service_version_id: string; is_sealed: boolean }>(
        `SELECT service_version_id, is_sealed FROM service_version
          WHERE service_id = $1 AND effective_from = $2
          ORDER BY created_at ASC LIMIT 1`,
        [serviceId, v.effectiveFrom],
      );
      const current = existing.rows[0];
      if (current && !current.is_sealed) {
        await client.query(
          `UPDATE service_version
              SET volumetric_divisor = $2,
                  min_billable_kg = $3,
                  billable_increment_kg = $4,
                  supports_cod = $5
            WHERE service_version_id = $1`,
          [current.service_version_id, v.volumetricDivisor, v.minBillableKg, v.billableIncrementKg, v.supportsCod],
        );
      } else if (!current) {
        await client.query(
          `INSERT INTO service_version
             (service_id, effective_from, volumetric_divisor, min_billable_kg,
              billable_increment_kg, supports_cod)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [serviceId, v.effectiveFrom, v.volumetricDivisor, v.minBillableKg, v.billableIncrementKg, v.supportsCod],
        );
      }
    }

    for (const m of AMAZON_SHIPPING_SEED.statusMap) {
      await client.query(
        `INSERT INTO courier_status_map (courier_id, raw_status, carrier_event_status)
         VALUES ($1, $2, $3)
         ON CONFLICT (courier_id, raw_status) DO UPDATE
           SET carrier_event_status = EXCLUDED.carrier_event_status`,
        [courierId, m.rawStatus, m.carrierEventStatus],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
