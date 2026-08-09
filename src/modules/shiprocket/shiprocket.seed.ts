import type { Pool } from 'pg';
import { ADAPTER_METHODS } from '../courier-framework/adapter.types';
import { SHIPROCKET_COURIER_CODE, SHIPROCKET_COURIER_MAP_KEY } from './shiprocket-api.map';

/**
 * Shiprocket seed (§9.3.4 launch adapter): the global courier row
 * (AGGREGATOR), its credential form schema (A1-12), §8.2 capabilities,
 * starter Services with versioned volumetric rules (§4.2–§4.4), and the
 * starter courier_status_map (§3.6 — the only mapping target, A2-06).
 *
 * Nested service identities (§15.1 acceptance, A2-02): each starter Service
 * stands for ONE Shiprocket nested courier. The service table has no
 * external-reference column, so the mapping is carried two ways:
 *  1. as a documented CODE CONVENTION — `SR-L<padded Shiprocket courier_id>`
 *     (SR-L003 → courier_id 3) — readable by merchants and support;
 *  2. operatively, per courier_account, in the NON-secret credential-blob
 *     field `shiprocket_courier_map`:
 *     `{ "SR-L039": "39", "default": "39" }` — the adapter resolves the
 *     nested courier_id from it at quote and booking time (the §8.2
 *     request shapes carry no service code — see shiprocket.adapter.ts).
 *
 * Exported as data (SHIPROCKET_SEED) plus runShiprocketSeed(pool)
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
  /** Normalized case-folded (lowercase) before write — migration 0006. */
  rawStatus: string;
  carrierEventStatus: CarrierEventStatus;
  /** Why, where the mapping is ambiguous. */
  note: string | null;
}

/** A1-03: the manual fallback shown wherever ndrAction is disabled. Kept in
 *  sync with SHIPROCKET_NDR_FALLBACK_NOTE in shiprocket.adapter.ts. */
export const SHIPROCKET_NDR_SEED_FALLBACK_NOTE =
  'NDR actions (reattempt / address update / RTO) are taken in the Shiprocket panel (NDR section); the Shiprocket NDR action API is not externally verified at v1 (TODO(sandbox-verify)).';

export const SHIPROCKET_SEED = {
  courier: {
    code: SHIPROCKET_COURIER_CODE,
    name: 'Shiprocket',
    kind: 'AGGREGATOR', // §9.3.4: Shiprocket is the launch aggregator (A2-02)
    authPattern: 'KEY_PASTE', // pasted secrets — login email + password
  },
  /** courier_credential_field rows (drives the merchant form, A1-12;
   *  is_secret fields are write-only with masked display, §5.7 control 3).
   *  email + password are secrets: they mint the bearer token (§9.3.3).
   *  shiprocket_courier_map is NOT a secret: it is routing configuration
   *  (nested service identity → Shiprocket courier_id). */
  credentialFields: [
    {
      key: 'email',
      label: 'Account e-mail',
      type: 'password',
      isSecret: true,
      isRequired: true,
      validationRegex: null as string | null,
      displayOrder: 1,
    },
    {
      key: 'password',
      label: 'Account password',
      type: 'password',
      isSecret: true,
      isRequired: true,
      validationRegex: null as string | null,
      displayOrder: 2,
    },
    {
      key: SHIPROCKET_COURIER_MAP_KEY,
      label: 'Nested courier map (JSON: service code → Shiprocket courier_id, plus "default")',
      type: 'textarea',
      isSecret: false,
      isRequired: false,
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
      label: 'Registered pickup location',
      type: 'text',
      isSecret: false,
      isRequired: false,
      validationRegex: null as string | null,
      displayOrder: 4,
    },
  ],
  /**
   * §8.2 capabilities: Shiprocket implements 7 of 8 adapter methods.
   * ndrAction is supported = false (A1-03): Shiprocket's NDR action API is
   * not externally verified at v1 — the adapter throws
   * UnsupportedCapabilityError, never a silent no-op.
   */
  capabilities: ADAPTER_METHODS.map((capability) => ({
    capability,
    supported: capability !== 'ndrAction',
    manualFallbackNote: capability === 'ndrAction' ? SHIPROCKET_NDR_SEED_FALLBACK_NOTE : null,
  })),
  /** Services (§9.3.2, A2-02): one per Shiprocket nested courier, priced
   *  LIVE_QUOTE off /courier/serviceability; labels may be custom-generated
   *  for the aggregator's services (CUSTOM_ALLOWED, §9.9.1). The code
   *  carries the nested identity by convention: SR-L<courier_id> (the
   *  service table has no external-ref column — see the header).
   *  TODO(sandbox-verify): which nested courier_ids are actually offered on
   *  the merchant's account; the names below are placeholders for the
   *  seeded ids 3 / 14 / 39. */
  services: [
    {
      code: 'SR-L003',
      name: 'Shiprocket Nested Courier 3',
      labelMode: 'CUSTOM_ALLOWED',
      costSource: 'LIVE_QUOTE',
    },
    {
      code: 'SR-L014',
      name: 'Shiprocket Nested Courier 14',
      labelMode: 'CUSTOM_ALLOWED',
      costSource: 'LIVE_QUOTE',
    },
    {
      code: 'SR-L039',
      name: 'Shiprocket Nested Courier 39',
      labelMode: 'CUSTOM_ALLOWED',
      costSource: 'LIVE_QUOTE',
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
   * Starter courier_status_map (§3.6). Raw statuses are Shiprocket's known
   * status labels, stored normalized case-folded; the numeric sr-status
   * codes ride alongside in tracking payloads and are mapped by their
   * label. TODO(sandbox-verify): the exact raw status vocabulary against
   * sandbox tracking payloads.
   */
  statusMap: [
    // "New" = booked, awaiting pickup — conservative: the closest §3.6
    // value is PICKUP_SCHEDULED (no "manifested" value).
    { rawStatus: 'new', carrierEventStatus: 'PICKUP_SCHEDULED', note: 'booked, awaiting pickup' },
    { rawStatus: 'pickup scheduled', carrierEventStatus: 'PICKUP_SCHEDULED', note: null },
    { rawStatus: 'pickup queued', carrierEventStatus: 'PICKUP_SCHEDULED', note: null },
    { rawStatus: 'manifest generated', carrierEventStatus: 'PICKUP_SCHEDULED', note: 'manifested, not yet picked up' },
    { rawStatus: 'picked up', carrierEventStatus: 'PICKED_UP', note: null },
    { rawStatus: 'shipped', carrierEventStatus: 'IN_TRANSIT', note: 'Shiprocket uses "Shipped" for the in-transit leg' },
    { rawStatus: 'in transit', carrierEventStatus: 'IN_TRANSIT', note: null },
    { rawStatus: 'reached destination hub', carrierEventStatus: 'IN_TRANSIT', note: 'still in transit, not yet OFD' },
    { rawStatus: 'out for delivery', carrierEventStatus: 'OUT_FOR_DELIVERY', note: null },
    { rawStatus: 'delivered', carrierEventStatus: 'DELIVERED', note: null },
    // "Undelivered" is a failed delivery attempt (the NDR reason rides as
    // the activity/reason text), not a terminal state.
    { rawStatus: 'undelivered', carrierEventStatus: 'UNDELIVERED_ATTEMPT', note: 'NDR reason rides as activity text' },
    { rawStatus: 'rto initiated', carrierEventStatus: 'RTO_INITIATED', note: null },
    { rawStatus: 'rto in transit', carrierEventStatus: 'RTO_IN_TRANSIT', note: null },
    { rawStatus: 'rto out for delivery', carrierEventStatus: 'RTO_OUT_FOR_DELIVERY', note: null },
    { rawStatus: 'rto delivered', carrierEventStatus: 'RTO_DELIVERED', note: null },
    { rawStatus: 'lost', carrierEventStatus: 'LOST_OR_DAMAGED', note: null },
    { rawStatus: 'damaged', carrierEventStatus: 'LOST_OR_DAMAGED', note: null },
    // Shiprocket spells it "Canceled"; the double-l spelling is mapped
    // defensively too.
    { rawStatus: 'canceled', carrierEventStatus: 'CANCELLED_BY_COURIER', note: 'Shiprocket spelling' },
    { rawStatus: 'cancelled', carrierEventStatus: 'CANCELLED_BY_COURIER', note: null },
  ] as StatusMapRow[],
};

/**
 * Idempotent upserts for every Shiprocket seed row. Safe to re-run on each
 * deploy; never touches sealed versions (INV-11 trigger would reject the
 * write anyway — the update below targets only unsealed starter rows).
 */
export async function runShiprocketSeed(pool: Pool): Promise<void> {
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
        SHIPROCKET_SEED.courier.code,
        SHIPROCKET_SEED.courier.name,
        SHIPROCKET_SEED.courier.kind,
        SHIPROCKET_SEED.courier.authPattern,
      ],
    );
    const courierId = courierRes.rows[0].courier_id;

    for (const f of SHIPROCKET_SEED.credentialFields) {
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

    for (const c of SHIPROCKET_SEED.capabilities) {
      await client.query(
        `INSERT INTO courier_capability (courier_id, capability, supported, manual_fallback_note)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (courier_id, capability) DO UPDATE
           SET supported = EXCLUDED.supported,
               manual_fallback_note = EXCLUDED.manual_fallback_note`,
        [courierId, c.capability, c.supported, c.manualFallbackNote],
      );
    }

    const v = SHIPROCKET_SEED.serviceVersion;
    for (const s of SHIPROCKET_SEED.services) {
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

    for (const m of SHIPROCKET_SEED.statusMap) {
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
