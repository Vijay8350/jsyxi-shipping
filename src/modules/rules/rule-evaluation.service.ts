import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { MerchantServicesService } from '../courier-framework/merchant-services.service';
import { EstimateCostService } from '../rate-engine/estimate-cost.service';
import {
  computeWeights,
  resolveZone,
  type ZoneRuleInput,
} from '../rate-engine/pricing';
import type { payment_mode } from '../courier-framework/adapter.enum-types';
import type { QuoteRequest } from '../courier-framework/adapter.types';
import type { ShipmentWorkingValuesWeek4 } from '../order-derivation/working-values-week4.types';
import { QuoteCacheService } from '../booking/quote-cache.service';
import {
  evaluate,
  type CandidateFacts,
  type ConditionDef,
  type EvaluateInput,
  type EvaluationResult,
  type OrderFacts,
  type RuleDef,
} from './evaluate';
import type {
  RuleActionServiceRow,
  RuleConditionRow,
  RuleConditionGroupRow,
  RuleRow,
} from './rules.types';

/** F-18 / S-18: EDD staleness threshold, default 6 hours (§4.9). */
export const EDD_STALE_MS = 6 * 60 * 60 * 1000;

interface Queryable {
  query: Pool['query'];
}

export interface ShipmentForEvaluation {
  shipment_id: string;
  shop_id: string;
  order_id: string;
  pickup_location_id: string | null;
  service_id: string | null;
  booking_state: string;
  is_test: boolean;
  working_values: ShipmentWorkingValuesWeek4 | null;
  version: number;
  created_at: string;
}

/** The parcel facts every candidate quote/volumetric is computed against. */
interface ParcelFacts {
  originPincode: string;
  destinationPincode: string;
  shipDate: string;
  deadWeightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  paymentMode: payment_mode;
  collectible: string;
  declaredValue: string;
  pickupLocationId: string;
}

interface MerchantServiceCandidateRow {
  merchant_service_id: string;
  courier_account_id: string;
  service_id: string;
  enabled: boolean;
  priority_tiebreak_order: number;
  cost_source: 'RATE_CARD' | 'LIVE_QUOTE' | 'NONE';
  service_active: boolean;
  account_disabled_at: string | null;
}

export interface LoadedEvaluation {
  shipment: ShipmentForEvaluation;
  input: EvaluateInput;
}

/**
 * The loader around the pure §9.4.4 core: resolves every operand the core
 * needs — order facts from the Shipment's working values and the "order"
 * columns, ADD-01/02 from the CURRENT postal zone master (never the address
 * string), the shop's rules with ADD-13 groups and ADD-15/16 fields, S-22,
 * and per-candidate facts (isBookable gate, RATE_CARD estimates, LIVE_QUOTE
 * through the §4.5 cache — ADD-05/ADD-10 never force an uncached call —
 * per-Service F-1 volumetrics and per-rate-card F-4 zones for ADD-03).
 *
 * All queries are shop-scoped (INV-1) and parameterized.
 */
@Injectable()
export class RuleEvaluationService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly merchantServices: MerchantServicesService,
    private readonly estimates: EstimateCostService,
    private readonly quoteCache: QuoteCacheService,
  ) {}

  /** Convenience composition used by the routing service and the simulator:
   *  load the facts, run the pure core. No persistence here. */
  async evaluateLoaded(input: EvaluateInput): Promise<EvaluationResult> {
    return evaluate(input);
  }

  /* ------------------------------ rules ---------------------------------- */

  private async loadRules(db: Queryable, shopId: string): Promise<RuleDef[]> {
    const { rows: rules } = await db.query<RuleRow>(
      `SELECT rule_id, shop_id, name, pickup_location_id, is_active, position,
              action_type, excluded_service_ids, active_from, active_to, version,
              created_at, updated_at
         FROM rule WHERE shop_id = $1
        ORDER BY position ASC, created_at ASC`,
      [shopId],
    );
    if (rules.length === 0) return [];
    const ruleIds = rules.map((r) => r.rule_id);
    const [{ rows: groups }, { rows: conditions }, { rows: actionServices }] =
      await Promise.all([
        db.query<RuleConditionGroupRow>(
          `SELECT group_id, rule_id, position FROM rule_condition_group
            WHERE rule_id = ANY($1::uuid[]) ORDER BY position ASC`,
          [ruleIds],
        ),
        db.query<RuleConditionRow>(
          `SELECT condition_id, rule_id, group_id, field, operator, value_json
             FROM rule_condition WHERE rule_id = ANY($1::uuid[])`,
          [ruleIds],
        ),
        db.query<RuleActionServiceRow>(
          `SELECT action_service_id, rule_id, service_id, position
             FROM rule_action_service WHERE rule_id = ANY($1::uuid[])
            ORDER BY position ASC`,
          [ruleIds],
        ),
      ]);

    // IN_SAVED_ZONE: inline the zone's pincodes into the condition value so
    // the core stays pure. A missing zone inlines as empty — missing data =
    // no match (§3.9).
    const zoneIds = [
      ...new Set(
        conditions
          .filter((c) => c.operator === 'IN_SAVED_ZONE')
          .map((c) => (c.value_json as { zoneId?: string }).zoneId)
          .filter((z): z is string => typeof z === 'string'),
      ),
    ];
    const zonePincodes = new Map<string, string[]>();
    if (zoneIds.length > 0) {
      const { rows: zones } = await db.query<{ saved_zone_id: string; pincodes: string[] }>(
        `SELECT saved_zone_id, pincodes FROM saved_zone
          WHERE shop_id = $1 AND saved_zone_id = ANY($2::uuid[])`,
        [shopId, zoneIds],
      );
      for (const z of zones) zonePincodes.set(z.saved_zone_id, z.pincodes);
    }

    const conditionsByGroup = new Map<string, ConditionDef[]>();
    for (const c of conditions) {
      const value = { ...(c.value_json as ConditionDef['value']) };
      if (c.operator === 'IN_SAVED_ZONE') {
        const zoneId = (c.value_json as { zoneId?: string }).zoneId;
        value.pincodes = zoneId ? (zonePincodes.get(zoneId) ?? []) : [];
      }
      const list = conditionsByGroup.get(c.group_id) ?? [];
      list.push({ field: c.field, operator: c.operator, value });
      conditionsByGroup.set(c.group_id, list);
    }

    const groupsByRule = new Map<string, RuleDef['groups']>();
    for (const g of groups) {
      const list = groupsByRule.get(g.rule_id) ?? [];
      list.push({
        position: g.position,
        conditions: conditionsByGroup.get(g.group_id) ?? [],
      });
      groupsByRule.set(g.rule_id, list);
    }

    const servicesByRule = new Map<string, string[]>();
    for (const s of actionServices) {
      const list = servicesByRule.get(s.rule_id) ?? [];
      list.push(s.service_id);
      servicesByRule.set(s.rule_id, list);
    }

    return rules.map((r) => ({
      ruleId: r.rule_id,
      name: r.name,
      version: r.version,
      isActive: r.is_active,
      position: r.position,
      actionType: r.action_type,
      excludedServiceIds: r.excluded_service_ids ?? [],
      activeFrom: r.active_from,
      activeTo: r.active_to,
      groups: groupsByRule.get(r.rule_id) ?? [],
      actionServiceIds: servicesByRule.get(r.rule_id) ?? [],
    }));
  }

  /* ---------------------------- S-22 chain -------------------------------- */

  /** S-22 stores ordered merchant_service ids (jsonb); evaluation works at
   *  Service level, so map through merchant_service (INV-1 shop scope). */
  private async loadDefaultChain(
    db: Queryable,
    shopId: string,
  ): Promise<{ chainServiceIds: string[]; chainMerchantServiceIds: string[] }> {
    const { rows } = await db.query<{ default_chain: string[] | null }>(
      `SELECT default_chain FROM order_sync_settings WHERE shop_id = $1`,
      [shopId],
    );
    const chain = rows[0]?.default_chain ?? null;
    if (!chain || chain.length === 0) {
      return { chainServiceIds: [], chainMerchantServiceIds: [] };
    }
    const { rows: msRows } = await db.query<{
      merchant_service_id: string;
      service_id: string;
    }>(
      `SELECT merchant_service_id, service_id FROM merchant_service
        WHERE shop_id = $1 AND merchant_service_id = ANY($2::uuid[])`,
      [shopId, chain],
    );
    const byId = new Map(msRows.map((r) => [r.merchant_service_id, r.service_id]));
    const chainServiceIds: string[] = [];
    for (const id of chain) {
      const serviceId = byId.get(id);
      if (serviceId && !chainServiceIds.includes(serviceId)) chainServiceIds.push(serviceId);
    }
    return { chainServiceIds, chainMerchantServiceIds: chain };
  }

  /* ------------------------- postal master (ADD-01/02) --------------------- */

  /** The CURRENT published postal zone master (ADD-01/02 read this, never
   *  the Shopify address string; F-4's frozen-version rule is for zone
   *  maps, not for these operands). */
  private async currentPostalAttributes(
    db: Queryable,
    pincode: string | null,
  ): Promise<{ state: string | null; city: string | null }> {
    if (!pincode) return { state: null, city: null };
    const { rows } = await db.query<{ state: string | null; city: string | null }>(
      `SELECT pp.state, pp.city
         FROM postal_pincode pp
         JOIN postal_zone_master_version v ON v.postal_version_id = pp.postal_version_id
        WHERE pp.pincode = $1 AND v.published_at IS NOT NULL
        ORDER BY v.effective_from DESC, v.published_at DESC
        LIMIT 1`,
      [pincode],
    );
    return { state: rows[0]?.state ?? null, city: rows[0]?.city ?? null };
  }

  /* ------------------------- zone resolution (ADD-03) ---------------------- */

  /** F-4 against a rate card's zone map, attributes from the map's FROZEN
   *  postal_version_id (A1-05). Same logic as booking's private
   *  resolveLaneZone — duplicated because that method is private and the
   *  booking files are outside this block's edit scope. */
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

  /* ---------------------------- candidates --------------------------------- */

  private async loadCandidates(
    db: Queryable,
    shopId: string,
    serviceIds: string[],
    parcel: ParcelFacts,
  ): Promise<CandidateFacts[]> {
    if (serviceIds.length === 0) return [];
    const { rows } = await db.query<MerchantServiceCandidateRow>(
      `SELECT ms.merchant_service_id, ms.courier_account_id, ms.service_id,
              ms.enabled, ms.priority_tiebreak_order, s.cost_source,
              s.is_active AS service_active, ca.disabled_at AS account_disabled_at
         FROM merchant_service ms
         JOIN service s ON s.service_id = ms.service_id
         JOIN courier_account ca ON ca.courier_account_id = ms.courier_account_id
        WHERE ms.shop_id = $1 AND ms.service_id = ANY($2::uuid[])
        ORDER BY ms.enabled DESC, ms.priority_tiebreak_order ASC, s.code ASC`,
      [shopId, serviceIds],
    );
    const rowByService = new Map<string, MerchantServiceCandidateRow>();
    for (const r of rows) {
      if (!rowByService.has(r.service_id)) rowByService.set(r.service_id, r);
    }

    const { rows: svRows } = await db.query<{
      service_id: string;
      volumetric_divisor: string | null;
      min_billable_kg: string | null;
      billable_increment_kg: string | null;
    }>(
      `SELECT DISTINCT ON (service_id)
              service_id, volumetric_divisor, min_billable_kg, billable_increment_kg
         FROM service_version
        WHERE service_id = ANY($1::uuid[]) AND effective_from <= $2::date
        ORDER BY service_id, effective_from DESC`,
      [serviceIds, parcel.shipDate],
    );
    const svByService = new Map(svRows.map((r) => [r.service_id, r]));

    const out: CandidateFacts[] = [];
    for (const serviceId of serviceIds) {
      const row = rowByService.get(serviceId);
      if (!row) {
        out.push({
          serviceId,
          courierAccountId: null,
          costSource: 'NONE',
          bookable: false,
          notBookableReason: 'NO_MERCHANT_SERVICE',
          priorityTiebreakOrder: 0,
          quote: null,
          quoteError: null,
          zone: null,
          volumetricWeightKg: null,
        });
        continue;
      }

      // §9.3.2: the isBookable gate — only enabled Services are candidates.
      const gateFlags = row.enabled && row.service_active && !row.account_disabled_at;
      const bookable =
        gateFlags &&
        (await this.merchantServices.isBookable(shopId, row.courier_account_id, serviceId));
      const notBookableReason = bookable
        ? null
        : !row.enabled
          ? 'MERCHANT_SERVICE_DISABLED'
          : !row.service_active
            ? 'SERVICE_INACTIVE'
            : row.account_disabled_at
              ? 'COURIER_ACCOUNT_DISABLED'
              : 'MERCHANT_SERVICE_DISABLED';

      // ADD-10: F-1 with THIS Service's divisor (per-Service, §4.2).
      const sv = svByService.get(serviceId);
      const weights = sv
        ? computeWeights({
            deadWeightKg: parcel.deadWeightKg,
            lengthCm: parcel.lengthCm,
            widthCm: parcel.widthCm,
            heightCm: parcel.heightCm,
            divisor: sv.volumetric_divisor,
            minBillableKg: sv.min_billable_kg,
            incrementKg: sv.billable_increment_kg,
          })
        : null;

      let quote: CandidateFacts['quote'] = null;
      let quoteError: string | null = null;
      let zone: string | null = null;

      if (row.cost_source === 'RATE_CARD') {
        const est = await this.estimates.estimateCost({
          shopId,
          serviceId,
          destinationPincode: parcel.destinationPincode,
          deadWeightKg: parcel.deadWeightKg,
          lengthCm: parcel.lengthCm,
          widthCm: parcel.widthCm,
          heightCm: parcel.heightCm,
          paymentMode: parcel.paymentMode,
          collectible: parcel.collectible,
          declaredValue: parcel.declaredValue,
          shipDate: parcel.shipDate,
        });
        quote = {
          serviceable: est.quote.serviceable,
          failureReasons: est.quote.failureReasons,
          rateAvailable: est.quote.rateAvailable,
          total: est.quote.rateAvailable ? est.quote.total : null,
          eddFrom: est.quote.eddFrom,
          eddTo: est.quote.eddTo,
          fetchedAt: est.quote.fetchedAt,
        };
        // ADD-03: F-4 against THIS rate card's zone map.
        if (est.zoneMapId) {
          zone = await this.resolveLaneZone(
            db,
            shopId,
            est.zoneMapId,
            parcel.originPincode,
            parcel.destinationPincode,
          );
        }
      } else if (row.cost_source === 'LIVE_QUOTE') {
        const request: QuoteRequest = {
          courierAccountId: row.courier_account_id,
          serviceId,
          originPincode: parcel.originPincode,
          destinationPincode: parcel.destinationPincode,
          shipDate: parcel.shipDate,
          pieces: 1, // INV-4
          deadWeightKg: parcel.deadWeightKg,
          lengthCm: parcel.lengthCm,
          widthCm: parcel.widthCm,
          heightCm: parcel.heightCm,
          paymentMode: parcel.paymentMode,
          collectible: parcel.collectible,
          declaredValue: parcel.declaredValue,
          pickupLocationId: parcel.pickupLocationId,
        };
        try {
          // §4.5 cache-first (S-16 TTL): ADD-05/ADD-10 evaluation never
          // forces an uncached call — a fresh cache row wins, only a miss
          // or a stale row fetches (quote budget S-17, QUOTE priority).
          const q = await this.quoteCache.getLiveQuote(db, {
            shopId,
            courierAccountId: row.courier_account_id,
            request,
            billableWeightBand: weights?.billableWeightKg ?? null,
          });
          quote = {
            serviceable: q.serviceable,
            failureReasons: q.failureReasons,
            rateAvailable: q.rateAvailable,
            total: q.rateAvailable ? q.total : null,
            eddFrom: q.eddFrom,
            eddTo: q.eddTo,
            fetchedAt: q.fetchedAt,
          };
        } catch (err) {
          // §4.5: a failed quote excludes from CHEAPEST / FASTEST but never
          // from PRIORITY_CHAIN; it is not a serviceability verdict.
          quoteError = `quote call failed: ${(err as Error).name}`;
        }
      }
      // COST_SOURCE = NONE: no quote, no estimate (§4.5) — price/EDD fields
      // stay null and the §4.5 per-action rule treats it accordingly.

      out.push({
        serviceId,
        courierAccountId: row.courier_account_id,
        costSource: row.cost_source,
        bookable,
        notBookableReason,
        priorityTiebreakOrder: row.priority_tiebreak_order,
        quote,
        quoteError,
        zone,
        volumetricWeightKg: weights?.volumetricWeightKg ?? null,
      });
    }
    return out;
  }

  /* ------------------------------ assembly -------------------------------- */

  private async shopTimezone(db: Queryable, shopId: string): Promise<string> {
    const { rows } = await db.query<{ timezone: string }>(
      `SELECT timezone FROM store_settings WHERE shop_id = $1`,
      [shopId],
    );
    return rows[0]?.timezone ?? 'Asia/Kolkata'; // S-2 default (§5.2)
  }

  /**
   * Load everything the pure core needs for one Shipment. Returns null when
   * the Shipment does not exist in this Shop (INV-1).
   */
  async loadForShipment(
    db: Queryable,
    shopId: string,
    shipmentId: string,
    now: Date,
    forUpdate = false,
  ): Promise<LoadedEvaluation | null> {
    const { rows: shipmentRows } = await db.query<ShipmentForEvaluation>(
      `SELECT shipment_id, shop_id, order_id, pickup_location_id, service_id,
              booking_state, is_test, working_values, version, created_at
         FROM shipment
        WHERE shop_id = $1 AND shipment_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [shopId, shipmentId],
    );
    const shipment = shipmentRows[0];
    if (!shipment) return null;

    const { rows: orderRows } = await db.query<{
      payment_mode: payment_mode;
      order_amount: string | null;
      cod_outstanding: string | null;
      checkout_shipping_title: string | null;
      checkout_shipping_amount: string | null;
      risk_flag: string | null;
    }>(
      `SELECT payment_mode, order_amount, cod_outstanding,
              checkout_shipping_title, checkout_shipping_amount, risk_flag
         FROM "order" WHERE shop_id = $1 AND order_id = $2`,
      [shopId, shipment.order_id],
    );
    const order = orderRows[0];

    const working = shipment.working_values;
    const lines = working?.lines ?? [];
    const destinationPincode = working?.recipient?.pincode ?? null;

    const [{ state: destState, city: destCity }, timezone, rules, chain] = await Promise.all([
      this.currentPostalAttributes(db, destinationPincode),
      this.shopTimezone(db, shopId),
      this.loadRules(db, shopId),
      this.loadDefaultChain(db, shopId),
    ]);

    const { rows: pickupRows } = await db.query<{ pincode: string | null }>(
      `SELECT pincode FROM pickup_location
        WHERE shop_id = $1 AND pickup_location_id = $2`,
      [shopId, shipment.pickup_location_id],
    );
    const originPincode = pickupRows[0]?.pincode ?? '';

    const paymentMode: payment_mode =
      working?.payment?.mode ?? order?.payment_mode ?? 'UNRESOLVED';
    const collectible = working?.payment?.collectible ?? '0.00';
    const profile = working?.packageProfile ?? null;

    const orderFacts: OrderFacts = {
      deadWeightKg: working?.weight?.deadWeightKg ?? null, // F-24 (§3.9)
      orderAmount: order?.order_amount ?? null, // F-17
      paymentMode,
      destinationPincode,
      skus: lines.map((l) => l.sku ?? null),
      tags: [...new Set(lines.flatMap((l) => l.tags ?? []))],
      destState, // ADD-01 — postal master, not the address string
      destCity, // ADD-02
      codAmount: order?.cod_outstanding ?? null, // ADD-04 — F-15, not F-17
      checkoutShippingTitle: order?.checkout_shipping_title ?? null, // ADD-06
      checkoutShippingAmount: order?.checkout_shipping_amount ?? null, // ADD-07
      // ADD-08: sum of allocated quantities on the Shipment.
      itemCount: lines.reduce((n, l) => n + (l.quantity ?? 0), 0),
      // ADD-09: PRODUCT = line titles; VENDOR / COLLECTIONS ride the
      // additive-friendly working-values lines (absent → missing data =
      // no match, §3.9, visible in the trace).
      products: lines.map((l) => l.title ?? null),
      vendors: lines.map(
        (l) => (l as { vendor?: string | null }).vendor ?? null,
      ),
      collections: lines.flatMap(
        (l) => (l as { collections?: string[] }).collections ?? [],
      ),
      riskFlag: order?.risk_flag ?? null, // ADD-11
    };

    const candidateServiceIds = [
      ...new Set([
        ...rules.flatMap((r) => r.actionServiceIds),
        ...chain.chainServiceIds,
      ]),
    ];
    const parcel: ParcelFacts = {
      originPincode,
      destinationPincode: destinationPincode ?? '',
      shipDate: now.toISOString().slice(0, 10),
      deadWeightKg: working?.weight?.deadWeightKg ?? '0.000',
      lengthCm: profile?.lengthCm ?? '0.00',
      widthCm: profile?.widthCm ?? '0.00',
      heightCm: profile?.heightCm ?? '0.00',
      paymentMode,
      collectible,
      declaredValue: order?.order_amount ?? '0.00',
      pickupLocationId: shipment.pickup_location_id ?? '',
    };
    const candidates = await this.loadCandidates(db, shopId, candidateServiceIds, parcel);

    return {
      shipment,
      input: {
        now,
        shopTimezone: timezone,
        eddStaleMs: EDD_STALE_MS,
        rules,
        order: orderFacts,
        candidates,
        defaultChainServiceIds: chain.chainServiceIds.length > 0 ? chain.chainServiceIds : null,
      },
    };
  }

  /**
   * §9.4.6 simulator input: the same operand resolution for a hand-made
   * sample order. Nothing is persisted by the caller.
   */
  async loadForSample(
    shopId: string,
    sample: {
      destinationPincode: string;
      deadWeightKg: string;
      lengthCm: string;
      widthCm: string;
      heightCm: string;
      paymentMode: payment_mode;
      collectible: string;
      orderAmount: string | null;
      codAmount: string | null;
      skus: string[];
      tags: string[];
      checkoutShippingTitle: string | null;
      checkoutShippingAmount: string | null;
      itemCount: number | null;
      riskFlag: string | null;
    },
    now: Date,
  ): Promise<EvaluateInput> {
    const db = this.pool;
    const [{ state: destState, city: destCity }, timezone, rules, chain] = await Promise.all([
      this.currentPostalAttributes(db, sample.destinationPincode),
      this.shopTimezone(db, shopId),
      this.loadRules(db, shopId),
      this.loadDefaultChain(db, shopId),
    ]);
    const { rows: pickupRows } = await db.query<{ pincode: string | null }>(
      `SELECT pincode FROM pickup_location WHERE shop_id = $1 AND is_active`,
      [shopId],
    );
    const originPincode = pickupRows[0]?.pincode ?? '';

    const orderFacts: OrderFacts = {
      deadWeightKg: sample.deadWeightKg,
      orderAmount: sample.orderAmount,
      paymentMode: sample.paymentMode,
      destinationPincode: sample.destinationPincode,
      skus: sample.skus,
      tags: sample.tags,
      destState,
      destCity,
      codAmount: sample.codAmount,
      checkoutShippingTitle: sample.checkoutShippingTitle,
      checkoutShippingAmount: sample.checkoutShippingAmount,
      itemCount: sample.itemCount,
      products: [],
      vendors: [],
      collections: [],
      riskFlag: sample.riskFlag,
    };

    const candidateServiceIds = [
      ...new Set([
        ...rules.flatMap((r) => r.actionServiceIds),
        ...chain.chainServiceIds,
      ]),
    ];
    const parcel: ParcelFacts = {
      originPincode,
      destinationPincode: sample.destinationPincode,
      shipDate: now.toISOString().slice(0, 10),
      deadWeightKg: sample.deadWeightKg,
      lengthCm: sample.lengthCm,
      widthCm: sample.widthCm,
      heightCm: sample.heightCm,
      paymentMode: sample.paymentMode,
      collectible: sample.collectible,
      declaredValue: sample.orderAmount ?? '0.00',
      pickupLocationId: '',
    };
    const candidates = await this.loadCandidates(db, shopId, candidateServiceIds, parcel);

    return {
      now,
      shopTimezone: timezone,
      eddStaleMs: EDD_STALE_MS,
      rules,
      order: orderFacts,
      candidates,
      defaultChainServiceIds: chain.chainServiceIds.length > 0 ? chain.chainServiceIds : null,
    };
  }
}
