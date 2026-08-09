import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { MerchantServicesService } from '../courier-framework/merchant-services.service';
import { EstimateCostService } from '../rate-engine/estimate-cost.service';
import { computeWeights, resolveZone, ZoneRuleInput } from '../rate-engine/pricing';
import { EntitlementLedgerService } from '../platform/ledger/entitlement-ledger.service';
import { evaluateEligibility, EligibilityCheck } from '../order-derivation/eligibility';
import { rupeesToPaise } from '../../common/money';
import type { ShipmentWorkingValuesWeek4 } from '../order-derivation/working-values-week4.types';
import type { payment_mode } from '../courier-framework/adapter.enum-types';
import type { QuoteRequest, QuoteResponse } from '../courier-framework/adapter.types';
import { QuoteCacheService } from './quote-cache.service';
import { BookingQueueService } from './booking-queue';
import { RuleRoutingService } from '../rules/rule-routing.service';
import {
  buildBookingSnapshot,
  buildMerchantReference,
  buildRequestDigest,
  deadWeightWithTare,
} from './snapshot';
import type {
  BookingSnapshot,
  BookingState,
  CostSource,
  CourierAccountMode,
  QueueBookingInput,
  QueueBookingResult,
  SnapshotPackageProfile,
} from './booking.types';

/**
 * The booking state machine's DRAFT → QUEUED transition (§3.2) — the member
 * `book` action (§9.5.1) with the manual Service/package override, and later
 * the auto-ship path. Everything §3.2 names as a guard is re-evaluated here
 * on the shipment's working values, inside one transaction:
 *
 *  - every INV-7 hard-block, including the two checks order-derivation left
 *    as TODOs (an enabled, bookable Service via isBookable, and courier
 *    credentials present for the account's current mode);
 *  - account not RESTRICTED / READ_ONLY / UNINSTALLED (§3.11);
 *  - entitlement available or overage permitted (§9.5.6) — a block carries
 *    approvalNeeded, and no debit happens here (debit is at CONFIRMED);
 *  - INV-9 under the order-row lock: the first booked shipment claims the
 *    full F-15 Collectible, siblings book with 0 (§4.7).
 *
 * On success: a new booking_intent (§13.5 merchant reference + §9.5.4
 * digest), the §2.9 snapshot freeze and the DRAFT → QUEUED transition in the
 * same transaction, then the audit row and the enqueue onto the §5.7
 * `booking` queue. All failures are structured results — nothing is silent
 * (INV-20).
 *
 * The quote is obtained INSIDE the transaction: the collectible claim (an
 * F-7 input) is only stable under the order lock. Single booking holds that
 * lock for the duration of one quote call; the §9.5.2 bulk path avoids it by
 * pre-resolving distinct quote cache keys before its booking stage (§4.5).
 */

interface Queryable {
  query: Pool['query'];
}

interface ShipmentRow {
  shipment_id: string;
  shop_id: string;
  order_id: string;
  pickup_location_id: string | null;
  service_id: string | null;
  booking_state: BookingState;
  working_values: ShipmentWorkingValuesWeek4 | null;
  collectible: string;
  version: number;
  created_at: string;
}

interface SelectionRow {
  merchant_service_id: string;
  courier_account_id: string;
  service_id: string;
  enabled: boolean;
  service_code: string;
  service_name: string;
  cost_source: CostSource;
  service_active: boolean;
  account_mode: CourierAccountMode;
  account_disabled_at: string | null;
  has_test_credentials: boolean;
  has_live_credentials: boolean;
}

interface ServiceVersionRow {
  service_version_id: string;
  volumetric_divisor: string | null;
  min_billable_kg: string | null;
  billable_increment_kg: string | null;
}

interface PackageProfileRow {
  package_profile_id: string;
  name: string;
  length_cm: string;
  width_cm: string;
  height_cm: string;
  tare_kg: string;
}

interface PickupRow {
  pickup_location_id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  address_lines: string[];
  city: string | null;
  state: string | null;
  pincode: string | null;
  gstin: string | null;
}

/** §3.11: booking is blocked in every non-operating account state. */
const BLOCKED_ACCOUNT_STATES = new Set(['RESTRICTED', 'READ_ONLY', 'UNINSTALLED']);

const SELECTION_SQL = `
  SELECT ms.merchant_service_id, ms.courier_account_id, ms.service_id, ms.enabled,
         s.code AS service_code, s.name AS service_name, s.cost_source,
         s.is_active AS service_active,
         ca.mode AS account_mode, ca.disabled_at AS account_disabled_at,
         (ca.credentials_test_encrypted IS NOT NULL) AS has_test_credentials,
         (ca.credentials_live_encrypted IS NOT NULL) AS has_live_credentials
    FROM merchant_service ms
    JOIN service s ON s.service_id = ms.service_id
    JOIN courier_account ca ON ca.courier_account_id = ms.courier_account_id
   WHERE ms.shop_id = $1`;

@Injectable()
export class BookingService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly merchantServices: MerchantServicesService,
    private readonly estimates: EstimateCostService,
    private readonly quoteCache: QuoteCacheService,
    private readonly ledger: EntitlementLedgerService,
    private readonly queue: BookingQueueService,
    private readonly ruleRouting: RuleRoutingService,
  ) {}

  /** F-4 (§4.3) on the rate card version's zone map, attributes from the
   *  map's FROZEN postal_version_id (A1-05). Null for LIVE_QUOTE lanes. */
  private async resolveLaneZone(
    db: Queryable,
    shopId: string,
    zoneMapId: string,
    originPincode: string,
    destinationPincode: string,
  ): Promise<string | null> {
    const { rows: maps } = await db.query<{ postal_version_id: string }>(
      `SELECT postal_version_id FROM commercial_zone_map
        WHERE zone_map_id = $1 AND shop_id = $2`,
      [zoneMapId, shopId],
    );
    const map = maps[0];
    if (!map) return null;
    const { rows: ruleRows } = await db.query<{
      origin_matcher: unknown;
      destination_matcher: unknown;
      zone: string;
      position: number;
    }>(
      `SELECT origin_matcher, destination_matcher, zone, position
         FROM commercial_zone_rule WHERE zone_map_id = $1 ORDER BY position`,
      [zoneMapId],
    );
    const attrs = async (pincode: string) => {
      const { rows } = await db.query<{
        city: string | null;
        district: string | null;
        state: string | null;
        region: string | null;
        is_metro: boolean;
        is_special: boolean;
      }>(
        `SELECT city, district, state, region, is_metro, is_special
           FROM postal_pincode WHERE postal_version_id = $1 AND pincode = $2`,
        [map.postal_version_id, pincode],
      );
      const r = rows[0];
      return r
        ? {
            city: r.city,
            district: r.district,
            state: r.state,
            region: r.region,
            isMetro: r.is_metro,
            isSpecial: r.is_special,
          }
        : null;
    };
    const rules: ZoneRuleInput[] = ruleRows.map((r) => ({
      originMatcher: r.origin_matcher as ZoneRuleInput['originMatcher'],
      destinationMatcher: r.destination_matcher as ZoneRuleInput['destinationMatcher'],
      zone: r.zone as ZoneRuleInput['zone'],
      position: r.position,
    }));
    return resolveZone(
      rules,
      { pincode: originPincode, attributes: await attrs(originPincode) },
      { pincode: destinationPincode, attributes: await attrs(destinationPincode) },
    );
  }

  /**
   * Service selection: the §9.5.1 explicit override, the shipment's stored
   * selection, else the S-22 default chain (ordered merchant_service ids,
   * NULL = unset — RW-22). Returns null when nothing bookable resolves.
   */
  private async resolveSelection(
    db: Queryable,
    shopId: string,
    shipment: ShipmentRow,
    serviceIdOverride: string | undefined,
  ): Promise<{ row: SelectionRow | null; noneResolvable: boolean }> {
    const explicit = serviceIdOverride ?? shipment.service_id;
    if (explicit) {
      const { rows } = await db.query<SelectionRow>(
        `${SELECTION_SQL} AND ms.service_id = $2`,
        [shopId, explicit],
      );
      // An explicit pick with no merchant_service row is not "no chain" — it
      // is an unbookable Service (INV-7), reported as such by the caller.
      return { row: rows[0] ?? null, noneResolvable: false };
    }
    // S-22 (§7.3): ordered merchant_service ids; NULL = unset at day one.
    const { rows: settings } = await db.query<{ default_chain: string[] | null }>(
      `SELECT default_chain FROM order_sync_settings WHERE shop_id = $1`,
      [shopId],
    );
    const chain = settings[0]?.default_chain ?? null;
    if (!chain || chain.length === 0) return { row: null, noneResolvable: true };
    const { rows } = await db.query<SelectionRow>(
      `${SELECTION_SQL} AND ms.merchant_service_id = ANY($2::uuid[])`,
      [shopId, chain],
    );
    const byId = new Map(rows.map((r) => [r.merchant_service_id, r]));
    for (const id of chain) {
      const row = byId.get(id);
      if (row && row.enabled && row.service_active && !row.account_disabled_at) {
        return { row, noneResolvable: false };
      }
    }
    return { row: null, noneResolvable: true };
  }

  async queueBooking(input: QueueBookingInput): Promise<QueueBookingResult> {
    // §9.4.4: rule evaluation runs BEFORE the stored-selection / S-22
    // fallback — it writes the selected Service (or NEEDS_MANUAL_ASSIGNMENT
    // with the §3.30 reason) idempotently while DRAFT. An explicit §9.5.1
    // override skips evaluation entirely (the override is the routing).
    if (!input.serviceId) {
      const routing = await this.ruleRouting.evaluateForShipment(
        input.shopId,
        input.shipmentId,
        { actorId: input.actorId ?? null },
      );
      if (routing.evaluated && routing.result.outcome.kind === 'MANUAL_ASSIGNMENT') {
        return {
          queued: false,
          code: 'NO_BOOKABLE_SERVICE',
          manualAssignmentReason: routing.result.outcome.reason,
        };
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the shipment (INV-22 serializes concurrent book attempts).
      const { rows: shipmentRows } = await client.query<ShipmentRow>(
        `SELECT shipment_id, shop_id, order_id, pickup_location_id, service_id,
                booking_state, working_values, collectible, version, created_at
           FROM shipment
          WHERE shop_id = $1 AND shipment_id = $2
          FOR UPDATE`,
        [input.shopId, input.shipmentId],
      );
      const shipment = shipmentRows[0];
      if (!shipment) {
        await client.query('ROLLBACK');
        return { queued: false, code: 'SHIPMENT_NOT_FOUND' };
      }
      // §3.2: booking starts from DRAFT; NEEDS_MANUAL_ASSIGNMENT returns to
      // DRAFT when a Member picks a Service; FAILED re-enters DRAFT via retry.
      if (!['DRAFT', 'NEEDS_MANUAL_ASSIGNMENT', 'FAILED'].includes(shipment.booking_state)) {
        await client.query('ROLLBACK');
        return {
          queued: false,
          code: 'INVALID_STATE',
          currentState: shipment.booking_state,
        };
      }
      // INV-22: the writer carries the version it read; a mismatch rejects
      // with the current state, never a silent last-write-wins merge.
      if (input.expectedVersion !== undefined && input.expectedVersion !== shipment.version) {
        await client.query('ROLLBACK');
        return {
          queued: false,
          code: 'VERSION_CONFLICT',
          currentState: shipment.booking_state,
          currentVersion: shipment.version,
        };
      }

      // INV-9 / §4.7: the collectible claim is keyed on the Order — the row
      // lock is held for the whole transaction.
      const { rows: orderRows } = await client.query<{
        order_id: string;
        shopify_order_gid: string | null;
        payment_mode: payment_mode;
        cod_outstanding: string | null;
        order_amount: string | null;
      }>(
        `SELECT order_id, shopify_order_gid, payment_mode, cod_outstanding, order_amount
           FROM "order" WHERE shop_id = $1 AND order_id = $2 FOR UPDATE`,
        [input.shopId, shipment.order_id],
      );
      const order = orderRows[0];

      // §3.11: RESTRICTED blocks new booking; READ_ONLY / UNINSTALLED too.
      const { rows: shopRows } = await client.query<{ account_state: string }>(
        `SELECT account_state FROM shop WHERE shop_id = $1`,
        [input.shopId],
      );
      if (shopRows[0] && BLOCKED_ACCOUNT_STATES.has(shopRows[0].account_state)) {
        await client.query('ROLLBACK');
        return {
          queued: false,
          code: 'ACCOUNT_STATE_BLOCKED',
          currentState: shipment.booking_state,
        };
      }

      // --- Service selection (§9.5.1 override / stored / S-22 chain). ---
      const selection = await this.resolveSelection(
        client,
        input.shopId,
        shipment,
        input.serviceId,
      );
      if (!selection.row) {
        if (selection.noneResolvable) {
          // RW-22 / §3.30: no rule matched (rules land later) and S-22 is
          // unset or exhausted → NEEDS_MANUAL_ASSIGNMENT, never an arbitrary
          // Service. DRAFT is the only §3.2 source state for this transition.
          if (shipment.booking_state === 'DRAFT') {
            await client.query(
              `UPDATE shipment
                  SET booking_state = 'NEEDS_MANUAL_ASSIGNMENT',
                      manual_assignment_reason = 'NO_RULE_AND_NO_DEFAULT_CHAIN',
                      version = version + 1
                WHERE shop_id = $1 AND shipment_id = $2 AND booking_state = 'DRAFT'`,
              [input.shopId, input.shipmentId],
            );
            await client.query('COMMIT');
            await this.audit.record({
              shopId: input.shopId,
              actorKind: input.actorId ? 'MEMBER' : 'SYSTEM',
              actorId: input.actorId,
              action: 'booking.needs_manual_assignment', // §12
              objectType: 'shipment',
              objectId: input.shipmentId,
              after: { manualAssignmentReason: 'NO_RULE_AND_NO_DEFAULT_CHAIN' },
            });
          } else {
            await client.query('ROLLBACK');
          }
          return {
            queued: false,
            code: 'NO_BOOKABLE_SERVICE',
            manualAssignmentReason: 'NO_RULE_AND_NO_DEFAULT_CHAIN',
          };
        }
        await client.query('ROLLBACK');
        return { queued: false, code: 'INV_7_BLOCKS', failures: ['SERVICE_SERVICEABLE'] };
      }
      const sel = selection.row;

      // --- Package profile: the §9.5.1 override or the F-20 resolution. ---
      const working = shipment.working_values;
      let profileRow: PackageProfileRow | null = null;
      if (input.packageProfileId) {
        const { rows } = await client.query<PackageProfileRow>(
          `SELECT package_profile_id, name, length_cm, width_cm, height_cm, tare_kg
             FROM package_profile WHERE shop_id = $1 AND package_profile_id = $2`,
          [input.shopId, input.packageProfileId],
        );
        profileRow = rows[0] ?? null;
      }
      const workingProfile = working?.packageProfile ?? null;
      const packageProfile: SnapshotPackageProfile | null = profileRow
        ? {
            packageProfileId: profileRow.package_profile_id,
            lengthCm: profileRow.length_cm,
            widthCm: profileRow.width_cm,
            heightCm: profileRow.height_cm,
            tareKg: profileRow.tare_kg,
            source: 'MEMBER_OVERRIDE',
          }
        : workingProfile
          ? {
              packageProfileId: workingProfile.packageProfileId,
              lengthCm: workingProfile.lengthCm,
              widthCm: workingProfile.widthCm,
              heightCm: workingProfile.heightCm,
              tareKg: workingProfile.tareKg,
              source: workingProfile.source,
            }
          : null;

      // F-24: an override re-tares the derived content weight (§4.2 step 4).
      const weightBlock = working?.weight ?? null;
      const deadWeightKg = weightBlock
        ? profileRow
          ? deadWeightWithTare(weightBlock.deadWeightKg, weightBlock.tareKg, profileRow.tare_kg)
          : weightBlock.deadWeightKg
        : null;

      // Current service_version (divisor / min / increment feed F-1…F-3).
      const shipDate = new Date().toISOString().slice(0, 10);
      const { rows: svRows } = await client.query<ServiceVersionRow>(
        `SELECT service_version_id, volumetric_divisor, min_billable_kg, billable_increment_kg
           FROM service_version
          WHERE service_id = $1 AND effective_from <= $2::date
          ORDER BY effective_from DESC LIMIT 1`,
        [sel.service_id, shipDate],
      );
      const serviceVersion = svRows[0] ?? null;

      const { rows: pickupRows } = await client.query<PickupRow>(
        `SELECT pickup_location_id, name, contact_name, phone, address_lines,
                city, state, pincode, gstin
           FROM pickup_location WHERE shop_id = $1 AND pickup_location_id = $2`,
        [input.shopId, shipment.pickup_location_id],
      );
      const pickup = pickupRows[0] ?? null;

      const paymentMode: payment_mode = working?.payment?.mode ?? order?.payment_mode ?? 'UNRESOLVED';
      const destinationPincode = working?.recipient?.pincode ?? null;
      const originPincode = pickup?.pincode ?? null;
      const declaredValue = order?.order_amount ?? '0.00';

      // --- INV-9 / §4.7 collectible claim (under the order lock). ---
      const { rows: carrierRows } = await client.query<{ shipment_id: string }>(
        `SELECT shipment_id FROM shipment
          WHERE shop_id = $1 AND order_id = $2 AND shipment_id <> $3
            AND collectible > 0 AND awb_normalized IS NOT NULL
            AND booking_state <> 'VOID'
          LIMIT 1`,
        [input.shopId, shipment.order_id, input.shipmentId],
      );
      const collectible =
        paymentMode === 'COD' && carrierRows.length === 0 && order?.cod_outstanding
          ? order.cod_outstanding
          : '0.00';

      // --- INV-7 hard-blocks, re-evaluated on working values. ---
      const failures: EligibilityCheck[] = evaluateEligibility({
        recipient: working?.recipient ?? null,
        allocatedLineCount: (working?.lines ?? []).filter((l) => l.quantity > 0).length,
        deadWeightKg,
        dimensionsCm: packageProfile
          ? {
              lengthCm: packageProfile.lengthCm,
              widthCm: packageProfile.widthCm,
              heightCm: packageProfile.heightCm,
            }
          : null,
        pickupLocationId: shipment.pickup_location_id,
        paymentMode,
        collectible,
      }).failures;
      // The two checks order-derivation left as TODOs (weeks 4–6), wired:
      const bookable =
        sel.enabled &&
        sel.service_active &&
        !sel.account_disabled_at &&
        (await this.merchantServices.isBookable(input.shopId, sel.courier_account_id, sel.service_id));
      if (!bookable) failures.push('SERVICE_SERVICEABLE');
      const credentialsPresent =
        sel.account_mode === 'TEST' ? sel.has_test_credentials : sel.has_live_credentials;
      if (!credentialsPresent || sel.account_disabled_at) failures.push('COURIER_CREDENTIALS');
      if (failures.length > 0) {
        await client.query('ROLLBACK');
        return { queued: false, code: 'INV_7_BLOCKS', failures };
      }

      // --- §9.5.6 entitlement: available or overage permitted, else block
      // with an approval-needed result. No debit here (debit is at CONFIRMED).
      const { rows: subRows } = await client.query<{
        subscription_id: string;
        cycle_start_at: string | null;
        capped_amount: string | null;
        awb_allowance_per_cycle: number;
      }>(
        `SELECT s.subscription_id, s.cycle_start_at, s.capped_amount,
                p.awb_allowance_per_cycle
           FROM subscription s
           JOIN plan p ON p.plan_id = s.plan_id
          WHERE s.shop_id = $1 AND s.state IN ('TRIALING', 'ACTIVE')
          ORDER BY s.created_at DESC LIMIT 1`,
        [input.shopId],
      );
      const sub = subRows[0];
      if (!sub || !sub.cycle_start_at) {
        await client.query('ROLLBACK');
        return { queued: false, code: 'ENTITLEMENT_INSUFFICIENT', approvalNeeded: true };
      }
      const balance = await this.ledger.allowanceBalance(sub.subscription_id, sub.cycle_start_at);
      const available = sub.awb_allowance_per_cycle - balance.consumed;
      const overagePermitted =
        sub.capped_amount !== null && rupeesToPaise(sub.capped_amount) > 0n;
      if (available <= 0 && !overagePermitted) {
        await client.query('ROLLBACK');
        return {
          queued: false,
          code: 'ENTITLEMENT_INSUFFICIENT',
          approvalNeeded: true,
          allowance: sub.awb_allowance_per_cycle,
          consumed: balance.consumed,
        };
      }

      // --- F-1…F-3 (§4.2); nulls under the §4.1 zero/null guard. ---
      const weights =
        deadWeightKg !== null && packageProfile
          ? computeWeights({
              deadWeightKg,
              lengthCm: packageProfile.lengthCm,
              widthCm: packageProfile.widthCm,
              heightCm: packageProfile.heightCm,
              divisor: serviceVersion?.volumetric_divisor ?? null,
              minBillableKg: serviceVersion?.min_billable_kg ?? null,
              incrementKg: serviceVersion?.billable_increment_kg ?? null,
            })
          : null;

      // --- The expected quote (§4.5). NONE-cost services carry no quote. ---
      let quote: QuoteResponse | null = null;
      let rateCardVersionId: string | null = null;
      let zoneMapId: string | null = null;
      let zone: string | null = null;
      if (sel.cost_source === 'RATE_CARD') {
        const est = await this.estimates.estimateCost({
          shopId: input.shopId,
          serviceId: sel.service_id,
          destinationPincode: destinationPincode ?? '',
          deadWeightKg: deadWeightKg ?? '0.000',
          lengthCm: packageProfile?.lengthCm ?? '0.00',
          widthCm: packageProfile?.widthCm ?? '0.00',
          heightCm: packageProfile?.heightCm ?? '0.00',
          paymentMode,
          collectible,
          declaredValue,
          shipDate,
        });
        quote = est.quote;
        rateCardVersionId = est.rateCardVersionId;
        zoneMapId = est.zoneMapId;
        if (zoneMapId && originPincode && destinationPincode) {
          zone = await this.resolveLaneZone(
            client,
            input.shopId,
            zoneMapId,
            originPincode,
            destinationPincode,
          );
        }
      } else if (sel.cost_source === 'LIVE_QUOTE') {
        const request: QuoteRequest = {
          courierAccountId: sel.courier_account_id,
          serviceId: sel.service_id,
          originPincode: originPincode ?? '',
          destinationPincode: destinationPincode ?? '',
          shipDate,
          pieces: 1, // INV-4
          deadWeightKg: deadWeightKg ?? '0.000',
          lengthCm: packageProfile?.lengthCm ?? '0.00',
          widthCm: packageProfile?.widthCm ?? '0.00',
          heightCm: packageProfile?.heightCm ?? '0.00',
          paymentMode,
          collectible,
          declaredValue,
          pickupLocationId: shipment.pickup_location_id ?? '',
        };
        // §4.5: cached under the S-16 TTL; stale → re-fetched.
        quote = await this.quoteCache.getLiveQuote(client, {
          shopId: input.shopId,
          courierAccountId: sel.courier_account_id,
          request,
          billableWeightBand: weights?.billableWeightKg ?? null,
        });
      }
      // INV-7: the Service must be serviceable on this lane. A price failure
      // alone never blocks (§4.5 PRIORITY_CHAIN, A3-04).
      if (quote && !quote.serviceable) {
        await client.query('ROLLBACK');
        return {
          queued: false,
          code: 'INV_7_BLOCKS',
          failures: ['SERVICE_SERVICEABLE'],
          serviceFailureReasons: quote.failureReasons,
        };
      }

      // §3.25 / §4.5: a usable frozen quote ⇒ SNAPSHOT_QUOTE; otherwise the
      // basis is decided at CONFIRMED (PROVIDER_CONFIRMED_CHARGE / NONE).
      const expectedCostBasis =
        quote && quote.serviceable && quote.rateAvailable ? 'SNAPSHOT_QUOTE' : null;

      // --- §2.9 snapshot assembly (full content list). ---
      const frozenAt = new Date().toISOString();
      const snapshot: BookingSnapshot = buildBookingSnapshot({
        working: working ?? {
          schemaVersion: 1,
          recipient: null,
          lines: [],
          payment: { mode: paymentMode, gatewayNames: [], collectible },
          fulfillment: { sourceFulfillmentOrderGids: [], shopifyLocationGid: null, mergePath: 'CONSOLIDATED' },
        },
        pickupLocation: pickup
          ? {
              pickupLocationId: pickup.pickup_location_id,
              name: pickup.name,
              contactName: pickup.contact_name,
              phone: pickup.phone,
              addressLines: pickup.address_lines ?? [],
              city: pickup.city,
              state: pickup.state,
              pincode: pickup.pincode,
              gstin: pickup.gstin,
            }
          : null,
        packageProfile,
        deadWeightKg,
        paymentMode,
        collectible,
        declaredValue,
        originPincode,
        destinationPincode,
        shipDate,
        service: {
          serviceId: sel.service_id,
          serviceVersionId: serviceVersion?.service_version_id ?? null,
          code: sel.service_code,
          name: sel.service_name,
          costSource: sel.cost_source,
          volumetricDivisor: serviceVersion?.volumetric_divisor ?? null,
          minBillableKg: serviceVersion?.min_billable_kg ?? null,
          billableIncrementKg: serviceVersion?.billable_increment_kg ?? null,
        },
        courierAccount: { courierAccountId: sel.courier_account_id, mode: sel.account_mode },
        weights: {
          volumetricWeightKg: weights?.volumetricWeightKg ?? null,
          rawChargeableKg: weights?.rawChargeableKg ?? null,
          billableWeightKg: weights?.billableWeightKg ?? null,
        },
        rateCardVersionId,
        zoneMapId,
        zone,
        quote,
        shopifyOrderGid: order?.shopify_order_gid ?? null,
        frozenAt,
      });

      // --- §9.5.4: a NEW booking intent per attempt. ---
      const { rows: intentCount } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM booking_intent WHERE shipment_id = $1`,
        [input.shipmentId],
      );
      const attemptNumber = (intentCount[0]?.n ?? 0) + 1;
      const merchantReference = buildMerchantReference(
        input.shopId,
        input.shipmentId,
        attemptNumber,
      );
      const requestDigest = buildRequestDigest({
        merchantReference,
        shipmentId: input.shipmentId,
        serviceId: sel.service_id,
        courierAccountId: sel.courier_account_id,
        originPincode: originPincode ?? '',
        destinationPincode: destinationPincode ?? '',
        deadWeightKg: deadWeightKg ?? '0.000',
        lengthCm: packageProfile?.lengthCm ?? '0.00',
        widthCm: packageProfile?.widthCm ?? '0.00',
        heightCm: packageProfile?.heightCm ?? '0.00',
        paymentMode,
        collectible,
        declaredValue,
      });
      const { rows: intentRows } = await client.query<{ booking_intent_id: string }>(
        // shipment_created_at via subquery: the exact timestamptz value the
        // row holds — a JS Date round-trip loses microseconds and breaks the
        // composite FK (live e2e proved it).
        `INSERT INTO booking_intent
           (shipment_id, shipment_created_at, request_digest, merchant_reference)
         SELECT $1, created_at, $2, $3 FROM shipment WHERE shipment_id = $1
         RETURNING booking_intent_id`,
        [input.shipmentId, requestDigest, merchantReference],
      );
      const bookingIntentId = intentRows[0]?.booking_intent_id as string;

      // INV-11: seal every version the snapshot references (idempotent).
      if (serviceVersion) {
        await client.query(
          `UPDATE service_version SET is_sealed = true
            WHERE service_version_id = $1 AND is_sealed = false`,
          [serviceVersion.service_version_id],
        );
      }
      if (rateCardVersionId) {
        await client.query(
          `UPDATE rate_card_version v SET is_sealed = true, version = v.version + 1
             FROM rate_card c
            WHERE v.rate_card_version_id = $1 AND v.rate_card_id = c.rate_card_id
              AND c.shop_id = $2 AND v.is_sealed = false`,
          [rateCardVersionId, input.shopId],
        );
      }
      if (zoneMapId) {
        await client.query(
          `UPDATE commercial_zone_map SET is_sealed = true, version = version + 1
            WHERE zone_map_id = $1 AND shop_id = $2 AND is_sealed = false`,
          [zoneMapId, input.shopId],
        );
      }

      // §3.2: the freeze happens exactly at DRAFT → QUEUED (the DB trigger
      // enforces it — a snapshot write anywhere else raises). From
      // NEEDS_MANUAL_ASSIGNMENT / FAILED the member action first re-enters
      // DRAFT; that update carries NO snapshot (INV-10).
      if (shipment.booking_state !== 'DRAFT') {
        await client.query(
          `UPDATE shipment
              SET booking_state = 'DRAFT', manual_assignment_reason = NULL,
                  version = version + 1
            WHERE shop_id = $1 AND shipment_id = $2 AND booking_state = $3`,
          [input.shopId, input.shipmentId, shipment.booking_state],
        );
      }
      const { rowCount: queuedCount } = await client.query(
        `UPDATE shipment
            SET booking_state = 'QUEUED',
                manual_assignment_reason = NULL,
                service_id = $3,
                service_version_id = $4,
                courier_account_id = $5,
                collectible = $6,
                expected_cost_basis = $7,
                snapshot = $8,
                version = version + 1
          WHERE shop_id = $1 AND shipment_id = $2 AND booking_state = 'DRAFT'`,
        [
          input.shopId,
          input.shipmentId,
          sel.service_id,
          serviceVersion?.service_version_id ?? null,
          sel.courier_account_id,
          collectible,
          expectedCostBasis,
          JSON.stringify(snapshot),
        ],
      );
      if (queuedCount !== 1) {
        throw new Error(
          `DRAFT → QUEUED affected ${queuedCount} rows for shipment ${input.shipmentId}`,
        );
      }

      // The shipment-bound quote row (EDD feeds §9.7's delay flag, S-47).
      if (quote) {
        await client.query(
          `INSERT INTO quote
             (shop_id, shipment_id, courier_account_id, service_id, cost_source,
              rate_card_version_id, zone_map_id, provider_quote_ref, fetched_at,
              components_json, total, currency, edd_from, edd_to, edd_source,
              origin_pincode, destination_pincode, billable_weight_band, payment_mode)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'INR',
                   $12, $13, $14, $15, $16, $17, $18)`,
          [
            input.shopId,
            input.shipmentId,
            sel.courier_account_id,
            sel.service_id,
            sel.cost_source,
            rateCardVersionId,
            zoneMapId,
            quote.providerQuoteRef,
            quote.fetchedAt,
            JSON.stringify({ components: quote.components, rtoRule: quote.rtoRule }),
            quote.rateAvailable ? quote.total : null,
            quote.eddFrom,
            quote.eddTo,
            quote.eddSource,
            originPincode,
            destinationPincode,
            weights?.billableWeightKg ?? null,
            paymentMode,
          ],
        );
      }

      await client.query('COMMIT');

      // §12: booking is always audited. IDs and states only — no PII.
      await this.audit.record({
        shopId: input.shopId,
        actorKind: input.actorId ? 'MEMBER' : 'SYSTEM',
        actorId: input.actorId,
        action: 'booking.queued',
        objectType: 'shipment',
        objectId: input.shipmentId,
        before: { bookingState: shipment.booking_state },
        after: {
          bookingState: 'QUEUED',
          bookingIntentId,
          merchantReference,
          attemptNumber,
          serviceId: sel.service_id,
          expectedCostBasis,
        },
      });

      // §5.7: enqueue onto the `booking` queue, partitioned per Service (the
      // job name carries the service id).
      await this.queue.enqueueBooking({
        shopId: input.shopId,
        shipmentId: input.shipmentId,
        bookingIntentId,
        merchantReference,
        serviceId: sel.service_id,
        courierAccountId: sel.courier_account_id,
      });

      return {
        queued: true,
        bookingIntentId,
        merchantReference,
        attemptNumber,
        expectedCostBasis,
        collectible,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
