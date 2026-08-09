import type { Pool } from 'pg';
import { ADAPTER_METHODS } from '../courier-framework/adapter.types';
import { DTDC_COURIER_CODE } from './dtdc-api.map';
import { DTDC_NDR_MANUAL_FALLBACK_NOTE } from './dtdc.adapter';

/**
 * DTDC seed (§9.3.4 launch adapter): the global courier row, its credential
 * form schema (A1-12), §8.2 capabilities, starter Services with versioned
 * volumetric rules (§4.2–§4.4), and the starter courier_status_map
 * (§3.6 — the only mapping target, A2-06).
 *
 * Exported as data (DTDC_SEED) plus runDtdcSeed(pool) performing idempotent
 * upserts, so it is safe to re-run at every deploy.
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

export const DTDC_SEED = {
  courier: {
    code: DTDC_COURIER_CODE,
    name: 'DTDC',
    kind: 'DIRECT', // §9.3.4: DTDC is a DIRECT courier (BYOC)
    authPattern: 'KEY_PASTE', // one pasted secret — api_key
  },
  /** courier_credential_field rows (drives the merchant form, A1-12;
   *  is_secret fields are write-only with masked display, §5.7 control 3). */
  credentialFields: [
    {
      key: 'api_key',
      label: 'API key',
      type: 'password',
      isSecret: true,
      isRequired: true,
      validationRegex: null as string | null,
      displayOrder: 1,
    },
      {
      // The merchant's courier-registered pickup identity. NOT a secret — it
      // is an account reference, and masking it would only stop the merchant
      // checking what they typed. Optional so an existing account keeps
      // working; when unset the adapter falls back to the internal id, which
      // is the pre-existing (wrong) behaviour rather than a new failure.
      key: 'pickup_code',
      label: 'Customer code',
      type: 'text',
      isSecret: false,
      isRequired: false,
      validationRegex: null as string | null,
      displayOrder: 2,
    },
  ],
  /**
   * §8.2 capabilities: DTDC implements 7 of the 8 adapter methods.
   * ndrAction is supported = false (A1-03): DTDC exposes NDR/reattempt
   * endpoints inconsistently, so v1 seeds a manual_fallback_note instead of
   * a silent no-op (TODO(sandbox-verify): flip to true if a stable NDR
   * action endpoint is confirmed).
   */
  capabilities: ADAPTER_METHODS.map((capability) => ({
    capability,
    supported: capability !== 'ndrAction',
    manualFallbackNote:
      capability === 'ndrAction' ? DTDC_NDR_MANUAL_FALLBACK_NOTE : (null as string | null),
  })),
  /** Services (§9.3.2): labels may be custom-generated for DTDC
   *  (CUSTOM_ALLOWED, §9.9.1); pricing comes from the merchant's uploaded
   *  rate card (RATE_CARD, §3.7 — BYOC, INV-23). */
  services: [
    {
      code: 'DTDC_EXPRESS',
      name: 'DTDC Express',
      labelMode: 'CUSTOM_ALLOWED',
      costSource: 'RATE_CARD',
    },
    {
      code: 'DTDC_SURFACE',
      name: 'DTDC Surface',
      labelMode: 'CUSTOM_ALLOWED',
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
   * Starter courier_status_map (§3.6). Raw statuses are DTDC's known status
   * texts, stored normalized case-folded. TODO(sandbox-verify): the exact
   * raw status vocabulary against sandbox tracking payloads.
   */
  statusMap: [
    // Booked = manifested, awaiting pickup — conservative: the closest §3.6
    // value is PICKUP_SCHEDULED (no "booked" value).
    { rawStatus: 'booked', carrierEventStatus: 'PICKUP_SCHEDULED', note: 'booked, awaiting pickup' },
    { rawStatus: 'pickup scheduled', carrierEventStatus: 'PICKUP_SCHEDULED', note: null },
    { rawStatus: 'picked up', carrierEventStatus: 'PICKED_UP', note: null },
    { rawStatus: 'in transit', carrierEventStatus: 'IN_TRANSIT', note: null },
    { rawStatus: 'out for delivery', carrierEventStatus: 'OUT_FOR_DELIVERY', note: null },
    { rawStatus: 'delivered', carrierEventStatus: 'DELIVERED', note: null },
    // "Undelivered" (with reason codes) is a failed delivery attempt, not a
    // terminal state.
    { rawStatus: 'undelivered', carrierEventStatus: 'UNDELIVERED_ATTEMPT', note: null },
    // "RTO" is ambiguous (initiation vs in-transit); conservative:
    // RTO_INITIATED — later scans refine it.
    { rawStatus: 'rto', carrierEventStatus: 'RTO_INITIATED', note: 'ambiguous; conservative' },
    { rawStatus: 'rto delivered', carrierEventStatus: 'RTO_DELIVERED', note: 'return leg completed' },
    { rawStatus: 'lost/damaged', carrierEventStatus: 'LOST_OR_DAMAGED', note: null },
    { rawStatus: 'cancelled', carrierEventStatus: 'CANCELLED_BY_COURIER', note: null },
  ] as StatusMapRow[],
};

/**
 * Idempotent upserts for every DTDC seed row. Safe to re-run on each
 * deploy; never touches sealed versions (INV-11 trigger would reject the
 * write anyway — the update below targets only unsealed starter rows).
 */
export async function runDtdcSeed(pool: Pool): Promise<void> {
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
        DTDC_SEED.courier.code,
        DTDC_SEED.courier.name,
        DTDC_SEED.courier.kind,
        DTDC_SEED.courier.authPattern,
      ],
    );
    const courierId = courierRes.rows[0].courier_id;

    for (const f of DTDC_SEED.credentialFields) {
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

    for (const c of DTDC_SEED.capabilities) {
      await client.query(
        `INSERT INTO courier_capability (courier_id, capability, supported, manual_fallback_note)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (courier_id, capability) DO UPDATE
           SET supported = EXCLUDED.supported,
               manual_fallback_note = EXCLUDED.manual_fallback_note`,
        [courierId, c.capability, c.supported, c.manualFallbackNote],
      );
    }

    const v = DTDC_SEED.serviceVersion;
    for (const s of DTDC_SEED.services) {
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

    for (const m of DTDC_SEED.statusMap) {
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
