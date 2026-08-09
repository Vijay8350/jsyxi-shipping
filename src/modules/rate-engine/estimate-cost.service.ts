import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import type { QuoteResponse, RtoRule } from '../courier-framework/adapter.types';
import {
  computeFreight,
  computeWeights,
  resolveZone,
  type TariffInput,
  type UnpriceableReason,
  type ZoneMatcher,
  type ZoneRuleInput,
} from './pricing';
import type {
  EstimateCostInput,
  PostalPincodeRow,
  RateCardComponentRow,
  RateCardRow,
  RateCardSlabRow,
  RateCardVersionRow,
  ServiceVersionRow,
  ZoneMapRow,
  ZoneRuleRow,
} from './rate-engine.types';

export interface EstimateCostResult {
  /** The §8.3 quote contract, synthesized from F-5…F-11 (§4.5). */
  quote: QuoteResponse;
  /** Null when unpriceable before version resolution (§4.1 zero/null guard). */
  rateCardVersionId: string | null;
  zoneMapId: string | null;
}

/**
 * estimateCost (§9.15, §4.5): the RATE_CARD cost source. Loads the effective
 * rate_card_version for the ship date, its zone map (with the FROZEN
 * postal_version_id — attributes never come from the current master, A1-05),
 * slabs, components and the service_version, then runs the pure F-1…F-11
 * pipeline and synthesizes the §8.3 QuoteResponse — the same shape a
 * LIVE_QUOTE adapter returns, so both cost sources compare directly.
 *
 * Zero/null guards (§4.1): any missing term makes the lane unpriceable —
 * rateAvailable = false with a structured reason, the §4.5 COST_SOURCE = NONE
 * behavior — NEVER a zero price. Serviceability follows zone resolution: an
 * unmatched lane is not serviceable on this service's own zone map.
 */
@Injectable()
export class EstimateCostService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  private unpriceable(reason: UnpriceableReason, serviceable: boolean): EstimateCostResult {
    return {
      quote: {
        serviceable,
        failureReasons: [reason], // §8.3 structured codes, not free text
        rateAvailable: false,
        components: [],
        total: '0.00', // never presented as a price — rateAvailable is false
        currency: 'INR',
        rtoRule: null,
        eddFrom: null,
        eddTo: null,
        eddSource: null, // rate cards carry no EDD source (§8.3)
        fetchedAt: new Date().toISOString(),
        providerQuoteRef: null,
        capabilityFlags: [],
      },
      rateCardVersionId: null,
      zoneMapId: null,
    };
  }

  private async pincodeAttributes(
    postalVersionId: string,
    pincode: string,
  ): Promise<{
    city: string | null;
    district: string | null;
    state: string | null;
    region: string | null;
    isMetro: boolean;
    isSpecial: boolean;
  } | null> {
    const { rows } = await this.pool.query<PostalPincodeRow>(
      `SELECT city, district, state, region, is_metro, is_special
         FROM postal_pincode
        WHERE postal_version_id = $1 AND pincode = $2`,
      [postalVersionId, pincode],
    );
    const row = rows[0];
    if (!row) return null; // absent from the frozen master — missing data = no match (§4.3)
    return {
      city: row.city,
      district: row.district,
      state: row.state,
      region: row.region,
      isMetro: row.is_metro,
      isSpecial: row.is_special,
    };
  }

  async estimateCost(input: EstimateCostInput): Promise<EstimateCostResult> {
    // Origin is the Shop's single active pickup location (INV-3, §4.3).
    const { rows: pickups } = await this.pool.query<{ pincode: string | null }>(
      `SELECT pincode FROM pickup_location WHERE shop_id = $1 AND is_active`,
      [input.shopId],
    );
    const originPincode = pickups[0]?.pincode ?? null;
    if (originPincode === null) return this.unpriceable('ORIGIN_MISSING', false);

    const { rows: cards } = await this.pool.query<RateCardRow>(
      `SELECT * FROM rate_card WHERE shop_id = $1 AND service_id = $2`,
      [input.shopId, input.serviceId],
    );
    const card = cards[0];
    if (!card) return this.unpriceable('RATE_CARD_MISSING', false); // §4.1 guard

    // Effective interval containing the ship date (§9.15 — non-overlapping,
    // so at most one row can match).
    const { rows: versions } = await this.pool.query<RateCardVersionRow>(
      `SELECT * FROM rate_card_version
        WHERE rate_card_id = $1
          AND effective_from <= $2::date
          AND (effective_to IS NULL OR effective_to >= $2::date)
        ORDER BY effective_from DESC
        LIMIT 1`,
      [card.rate_card_id, input.shipDate],
    );
    const version = versions[0];
    if (!version) return this.unpriceable('RATE_CARD_VERSION_MISSING', false); // §4.1

    const { rows: serviceVersions } = await this.pool.query<ServiceVersionRow>(
      `SELECT * FROM service_version
        WHERE service_id = $1 AND effective_from <= $2::date
        ORDER BY effective_from DESC
        LIMIT 1`,
      [input.serviceId, input.shipDate],
    );
    const serviceVersion = serviceVersions[0];
    if (!serviceVersion) return this.unpriceable('SERVICE_VERSION_MISSING', false); // §4.1
    if (serviceVersion.volumetric_divisor === null) {
      return this.unpriceable('DIVISOR_MISSING', false); // §4.1
    }

    // F-1…F-3 (§4.2).
    const weights = computeWeights({
      deadWeightKg: input.deadWeightKg,
      lengthCm: input.lengthCm,
      widthCm: input.widthCm,
      heightCm: input.heightCm,
      divisor: serviceVersion.volumetric_divisor,
      minBillableKg: serviceVersion.min_billable_kg,
      incrementKg: serviceVersion.billable_increment_kg,
    });
    if (weights === null) return this.unpriceable('DIVISOR_MISSING', false);

    // F-4 (§4.3): rules of the version's zone map, attributes from the map's
    // FROZEN postal_version_id — never the current master (A1-05).
    const { rows: maps } = await this.pool.query<ZoneMapRow>(
      `SELECT * FROM commercial_zone_map
        WHERE zone_map_id = $1 AND shop_id = $2`,
      [version.zone_map_id, input.shopId],
    );
    const zoneMap = maps[0];
    if (!zoneMap) return this.unpriceable('ZONE_NOT_MATCHED', false);
    const { rows: ruleRows } = await this.pool.query<ZoneRuleRow>(
      `SELECT * FROM commercial_zone_rule
        WHERE zone_map_id = $1
        ORDER BY position ASC`,
      [zoneMap.zone_map_id],
    );
    const rules: ZoneRuleInput[] = ruleRows.map((r) => ({
      originMatcher: r.origin_matcher as ZoneMatcher,
      destinationMatcher: r.destination_matcher as ZoneMatcher,
      zone: r.zone,
      position: r.position,
    }));
    const [originAttrs, destinationAttrs] = await Promise.all([
      this.pincodeAttributes(zoneMap.postal_version_id, originPincode),
      this.pincodeAttributes(zoneMap.postal_version_id, input.destinationPincode),
    ]);
    const zone = resolveZone(
      rules,
      { pincode: originPincode, attributes: originAttrs },
      { pincode: input.destinationPincode, attributes: destinationAttrs },
    );
    if (zone === null) {
      // §4.3 no match → unpriceable for this lane; the merchant's own zone
      // map does not serve it, so the service is not serviceable here.
      return this.unpriceable('ZONE_NOT_MATCHED', false);
    }

    const { rows: slabRows } = await this.pool.query<RateCardSlabRow>(
      `SELECT * FROM rate_card_slab WHERE rate_card_version_id = $1`,
      [version.rate_card_version_id],
    );
    const { rows: componentRows } = await this.pool.query<RateCardComponentRow>(
      `SELECT * FROM rate_card_component WHERE rate_card_version_id = $1 ORDER BY position`,
      [version.rate_card_version_id],
    );
    const tariff: TariffInput = {
      fuelPct: version.fuel_pct,
      codFlat: version.cod_flat,
      codPct: version.cod_pct,
      gstPct: version.gst_pct,
      taxableComponents: version.taxable_components,
      slabs: slabRows.map((s) => ({
        zone: s.zone,
        baseWeightKg: s.base_weight_kg,
        baseRate: s.base_rate,
        additionalStepKg: s.additional_step_kg,
        additionalRate: s.additional_rate,
      })),
      components: componentRows.map((c) => ({
        code: c.code,
        label: c.label,
        basis: c.basis,
        value: c.value,
        isTaxable: c.is_taxable,
        position: c.position,
      })),
    };

    // F-5…F-11 (§4.4).
    const result = computeFreight(tariff, {
      zone,
      billableWeightKg: weights.billableWeightKg,
      paymentMode: input.paymentMode,
      collectible: input.collectible,
      declaredValue: input.declaredValue,
    });
    if (!result.priceable) {
      // Zone resolved but the version carries no slab for it — the lane is
      // serviceable, the price is not (§4.1 guard, §4.5 NONE behavior).
      return {
        ...this.unpriceable(result.reason, true),
        rateCardVersionId: version.rate_card_version_id,
        zoneMapId: zoneMap.zone_map_id,
      };
    }

    const rtoRule: RtoRule = { basis: version.rto_basis, pct: version.rto_pct };
    return {
      quote: {
        serviceable: true,
        failureReasons: [],
        rateAvailable: true,
        components: result.breakdown.components,
        total: result.breakdown.f11Total, // INV-15 sum of rounded components
        currency: 'INR',
        rtoRule, // the version's F-12 terms, consumed by reconciliation (§4.4)
        eddFrom: null,
        eddTo: null,
        eddSource: null, // rate cards have no EDD source at v1 (§8.3)
        fetchedAt: new Date().toISOString(),
        providerQuoteRef: null, // synthesized locally — no provider call
        capabilityFlags: [],
      },
      rateCardVersionId: version.rate_card_version_id,
      zoneMapId: zoneMap.zone_map_id,
    };
  }
}
