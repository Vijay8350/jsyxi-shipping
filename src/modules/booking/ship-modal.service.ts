import { Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { EstimateCostService } from '../rate-engine/estimate-cost.service';
import { computeWeights } from '../rate-engine/pricing';
import { rupeesToPaise } from '../../common/money';
import type { QuoteRequest, QuoteResponse } from '../courier-framework/adapter.types';
import type { payment_mode } from '../courier-framework/adapter.enum-types';
import type { ShipmentWorkingValuesWeek4 } from '../order-derivation/working-values-week4.types';
import { QuoteCacheService } from './quote-cache.service';
import type { CostSource } from './booking.types';

/**
 * The §9.5.1 ship modal: the resolved package profile (F-20) with dimensions
 * and tare, the F-24 dead weight with any "no weight" lines called out, a
 * per-candidate cost estimate (RATE_CARD via the rate engine, LIVE_QUOTE via
 * the adapter with the §4.5 S-16 cache) and EDD, and — for orders with
 * §9.2.3 siblings — which parcel carries the Collectible, with the plain
 * COD-split warning.
 *
 * Everything here reads the shipment's working values: the estimate the
 * merchant sees is computed on exactly the values that freeze into the
 * snapshot at DRAFT → QUEUED (INV-8, RV-05).
 */

export interface ShipModalCandidate {
  merchantServiceId: string;
  serviceId: string;
  courierAccountId: string;
  serviceCode: string;
  serviceName: string;
  costSource: CostSource;
  accountMode: 'TEST' | 'LIVE';
  serviceable: boolean | null;
  failureReasons: string[];
  /** Null = "no estimate" (§3.7 NONE / §4.1 guard). */
  estimate: { total: string; currency: 'INR'; components: QuoteResponse['components'] } | null;
  eddFrom: string | null;
  eddTo: string | null;
  eddSource: 'PROVIDER' | 'RATE_CARD_SLA' | null;
  quoteFetchedAt: string | null;
  fromCache: boolean;
}

export interface ShipModalData {
  shipmentId: string;
  bookingState: string;
  packageProfile: {
    packageProfileId: string;
    name: string | null;
    lengthCm: string;
    widthCm: string;
    heightCm: string;
    tareKg: string;
    source: string;
  } | null;
  weight: {
    deadWeightKg: string;
    lineWeightTotalKg: string;
    tareKg: string;
    usedDefaultParcelWeight: boolean;
    /** INV-20: lines with no resolvable weight, called out on the modal. */
    noWeightLines: Array<{ orderLineId: string | null; sku: string | null; quantity: number }>;
    lines: unknown[];
  } | null;
  paymentMode: payment_mode;
  collectible: string;
  candidates: ShipModalCandidate[];
  /** §9.2.3 sibling information + the plain COD-split warning (§4.7). */
  cod: {
    orderCodOutstanding: string | null;
    siblingCount: number;
    splitWarning: boolean;
    /** The booked sibling carrying the Collectible, when there is one. */
    carrierShipmentId: string | null;
    /** True when booking this shipment first would claim the Collectible. */
    thisShipmentWouldCarry: boolean;
  };
}

interface CandidateRow {
  merchant_service_id: string;
  courier_account_id: string;
  service_id: string;
  service_code: string;
  service_name: string;
  cost_source: CostSource;
  account_mode: 'TEST' | 'LIVE';
}

@Injectable()
export class ShipModalService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly estimates: EstimateCostService,
    private readonly quoteCache: QuoteCacheService,
  ) {}

  async getShipModal(shopId: string, shipmentId: string): Promise<ShipModalData> {
    const { rows: shipmentRows } = await this.pool.query<{
      shipment_id: string;
      order_id: string;
      booking_state: string;
      pickup_location_id: string | null;
      working_values: ShipmentWorkingValuesWeek4 | null;
    }>(
      `SELECT shipment_id, order_id, booking_state, pickup_location_id, working_values
         FROM shipment WHERE shop_id = $1 AND shipment_id = $2`,
      [shopId, shipmentId],
    );
    const shipment = shipmentRows[0];
    if (!shipment) throw new NotFoundException('shipment not found');
    if (!['DRAFT', 'NEEDS_MANUAL_ASSIGNMENT'].includes(shipment.booking_state)) {
      // §10.4: working values are only meaningful pre-QUEUE; the snapshot is
      // the record from then on.
      throw new ConflictException({
        message: 'ship modal is only available before booking',
        bookingState: shipment.booking_state,
      });
    }
    const working = shipment.working_values;

    const { rows: orderRows } = await this.pool.query<{
      payment_mode: payment_mode;
      cod_outstanding: string | null;
      order_amount: string | null;
    }>(
      `SELECT payment_mode, cod_outstanding, order_amount
         FROM "order" WHERE shop_id = $1 AND order_id = $2`,
      [shopId, shipment.order_id],
    );
    const order = orderRows[0];

    const { rows: pickupRows } = await this.pool.query<{ pincode: string | null }>(
      `SELECT pincode FROM pickup_location
        WHERE shop_id = $1 AND pickup_location_id = $2`,
      [shopId, shipment.pickup_location_id],
    );
    const originPincode = pickupRows[0]?.pincode ?? null;

    // F-20 resolved profile (from working values) + its name.
    const workingProfile = working?.packageProfile ?? null;
    let profileName: string | null = null;
    if (workingProfile) {
      const { rows } = await this.pool.query<{ name: string }>(
        `SELECT name FROM package_profile
          WHERE shop_id = $1 AND package_profile_id = $2`,
        [shopId, workingProfile.packageProfileId],
      );
      profileName = rows[0]?.name ?? null;
    }

    const weightBlock = working?.weight ?? null;
    const paymentMode: payment_mode = working?.payment?.mode ?? order?.payment_mode ?? 'UNRESOLVED';

    // §4.7: the prospective claim for the estimate — booking this shipment
    // first on a COD order carries the full F-15.
    const { rows: siblingRows } = await this.pool.query<{
      shipment_id: string;
      booking_state: string;
      collectible: string;
      awb_normalized: string | null;
    }>(
      `SELECT shipment_id, booking_state, collectible, awb_normalized
         FROM shipment WHERE shop_id = $1 AND order_id = $2 AND shipment_id <> $3`,
      [shopId, shipment.order_id, shipmentId],
    );
    const carrier = siblingRows.find(
      (s) =>
        s.awb_normalized !== null &&
        s.booking_state !== 'VOID' &&
        rupeesToPaise(s.collectible) > 0n,
    );
    const prospectiveCollectible =
      paymentMode === 'COD' && !carrier && order?.cod_outstanding
        ? order.cod_outstanding
        : '0.00';

    // Candidate Services: every enabled merchant service on an active account.
    const { rows: candidates } = await this.pool.query<CandidateRow>(
      `SELECT ms.merchant_service_id, ms.courier_account_id, ms.service_id,
              s.code AS service_code, s.name AS service_name, s.cost_source,
              ca.mode AS account_mode
         FROM merchant_service ms
         JOIN service s ON s.service_id = ms.service_id
         JOIN courier_account ca ON ca.courier_account_id = ms.courier_account_id
        WHERE ms.shop_id = $1 AND ms.enabled AND s.is_active AND ca.disabled_at IS NULL
        ORDER BY ms.priority_tiebreak_order, s.code`,
      [shopId],
    );

    const shipDate = new Date().toISOString().slice(0, 10);
    const destinationPincode = working?.recipient?.pincode ?? '';
    const declaredValue = order?.order_amount ?? '0.00';
    const deadWeightKg = weightBlock?.deadWeightKg ?? '0.000';

    const results: ShipModalCandidate[] = [];
    for (const candidate of candidates) {
      const base: ShipModalCandidate = {
        merchantServiceId: candidate.merchant_service_id,
        serviceId: candidate.service_id,
        courierAccountId: candidate.courier_account_id,
        serviceCode: candidate.service_code,
        serviceName: candidate.service_name,
        costSource: candidate.cost_source,
        accountMode: candidate.account_mode,
        serviceable: null,
        failureReasons: [],
        estimate: null,
        eddFrom: null,
        eddTo: null,
        eddSource: null,
        quoteFetchedAt: null,
        fromCache: false,
      };
      // Billable-weight band per candidate (its own divisor/min/increment).
      const { rows: svRows } = await this.pool.query<{
        volumetric_divisor: string | null;
        min_billable_kg: string | null;
        billable_increment_kg: string | null;
      }>(
        `SELECT volumetric_divisor, min_billable_kg, billable_increment_kg
           FROM service_version
          WHERE service_id = $1 AND effective_from <= $2::date
          ORDER BY effective_from DESC LIMIT 1`,
        [candidate.service_id, shipDate],
      );
      const weights = workingProfile
        ? computeWeights({
            deadWeightKg,
            lengthCm: workingProfile.lengthCm,
            widthCm: workingProfile.widthCm,
            heightCm: workingProfile.heightCm,
            divisor: svRows[0]?.volumetric_divisor ?? null,
            minBillableKg: svRows[0]?.min_billable_kg ?? null,
            incrementKg: svRows[0]?.billable_increment_kg ?? null,
          })
        : null;

      let quote: QuoteResponse | null = null;
      if (candidate.cost_source === 'RATE_CARD') {
        const est = await this.estimates.estimateCost({
          shopId,
          serviceId: candidate.service_id,
          destinationPincode,
          deadWeightKg,
          lengthCm: workingProfile?.lengthCm ?? '0.00',
          widthCm: workingProfile?.widthCm ?? '0.00',
          heightCm: workingProfile?.heightCm ?? '0.00',
          paymentMode,
          collectible: prospectiveCollectible,
          declaredValue,
          shipDate,
        });
        quote = est.quote;
      } else if (candidate.cost_source === 'LIVE_QUOTE' && originPincode && destinationPincode) {
        const request: QuoteRequest = {
          courierAccountId: candidate.courier_account_id,
          serviceId: candidate.service_id,
          originPincode,
          destinationPincode,
          shipDate,
          pieces: 1, // INV-4
          deadWeightKg,
          lengthCm: workingProfile?.lengthCm ?? '0.00',
          widthCm: workingProfile?.widthCm ?? '0.00',
          heightCm: workingProfile?.heightCm ?? '0.00',
          paymentMode,
          collectible: prospectiveCollectible,
          declaredValue,
          pickupLocationId: shipment.pickup_location_id ?? '',
        };
        const cached = await this.quoteCache.findFresh(this.pool, {
          serviceId: candidate.service_id,
          originPincode,
          destinationPincode,
          billableWeightBand: weights?.billableWeightKg ?? null,
          paymentMode,
        });
        if (cached) {
          quote = cached;
          base.fromCache = true;
        } else {
          try {
            quote = await this.quoteCache.fetchAndStore(this.pool, {
              shopId,
              courierAccountId: candidate.courier_account_id,
              request,
              billableWeightBand: weights?.billableWeightKg ?? null,
            });
          } catch {
            // A quote failure never breaks the modal (§4.5: quotes run at
            // lower priority and may fail; the candidate shows no estimate).
            quote = null;
          }
        }
      }
      // COST_SOURCE = NONE → no quote, "no estimate" (§3.7).

      if (quote) {
        base.serviceable = quote.serviceable;
        base.failureReasons = quote.failureReasons;
        base.eddFrom = quote.eddFrom;
        base.eddTo = quote.eddTo;
        base.eddSource = quote.eddSource;
        base.quoteFetchedAt = quote.fetchedAt;
        if (quote.serviceable && quote.rateAvailable) {
          base.estimate = {
            total: quote.total,
            currency: 'INR',
            components: quote.components,
          };
        }
      }
      results.push(base);
    }

    return {
      shipmentId,
      bookingState: shipment.booking_state,
      packageProfile: workingProfile
        ? {
            packageProfileId: workingProfile.packageProfileId,
            name: profileName,
            lengthCm: workingProfile.lengthCm,
            widthCm: workingProfile.widthCm,
            heightCm: workingProfile.heightCm,
            tareKg: workingProfile.tareKg,
            source: workingProfile.source,
          }
        : null,
      weight: weightBlock
        ? {
            deadWeightKg: weightBlock.deadWeightKg,
            lineWeightTotalKg: weightBlock.lineWeightTotalKg,
            tareKg: weightBlock.tareKg,
            usedDefaultParcelWeight: weightBlock.usedDefaultParcelWeight,
            noWeightLines: weightBlock.lines
              .filter((l) => l.noWeight)
              .map((l) => ({ orderLineId: l.orderLineId, sku: l.sku, quantity: l.quantity })),
            lines: weightBlock.lines,
          }
        : null,
      paymentMode,
      collectible: prospectiveCollectible,
      candidates: results,
      cod: {
        orderCodOutstanding: order?.cod_outstanding ?? null,
        siblingCount: siblingRows.length,
        splitWarning:
          siblingRows.length > 0 &&
          paymentMode === 'COD' &&
          rupeesToPaise(order?.cod_outstanding ?? '0.00') > 0n,
        carrierShipmentId: carrier?.shipment_id ?? null,
        thisShipmentWouldCarry:
          !carrier && paymentMode === 'COD' && rupeesToPaise(order?.cod_outstanding ?? '0.00') > 0n,
      },
    };
  }
}
