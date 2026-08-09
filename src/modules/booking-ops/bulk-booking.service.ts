import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import { AuditService } from '../../audit/audit.service';
import { BookingService } from '../booking/booking.service';
import { QuoteCacheService } from '../booking/quote-cache.service';
import { computeWeights } from '../rate-engine/pricing';
import type { QuoteRequest } from '../courier-framework/adapter.types';
import type { payment_mode } from '../courier-framework/adapter.enum-types';
import type { ShipmentWorkingValuesWeek4 } from '../order-derivation/working-values-week4.types';
import { BulkBookingQueueService } from './bulk-booking-queue';
import {
  BULK_BOOKING_MAX_ORDERS,
  MAX_CONCURRENT_BULK_JOBS_PER_SHOP,
  BatchOrderResult,
  BatchVersionSnapshot,
  BookingBatchRow,
  BulkBookingJobData,
} from './booking-ops.types';

/**
 * §9.5.2 bulk booking. Up to 1,000 Orders per job, asynchronous with live
 * progress and a per-Order result — every outcome is recorded with its exact
 * structured reason, NEEDS_MANUAL_ASSIGNMENT included (INV-20).
 *
 *  - Enqueue: validate, enforce S-21 (2 concurrent bulk jobs per shop, a
 *    Redis counter — 429-style structured refusal when exceeded), snapshot
 *    Service + rate-card versions (§9.4.5; rules land later), insert the
 *    booking_batch row, enqueue ONE BullMQ job (jobId = batch_id).
 *  - Worker (processBatch): pre-resolve distinct §4.5 quote cache keys once
 *    before the booking stage (each distinct key fetched at most once per
 *    job — the QuoteCacheService then serves every order with that key),
 *    then run each order's DRAFT shipment through BookingService.queueBooking
 *    — reused, never duplicated. Progress is written per order.
 *  - Terminal state: SUCCEEDED when nothing failed, else PARTIAL (§3.27).
 *  - Retry (§9.5.2 one-click): creates a NEW batch containing only the failed
 *    orders, linked via version_snapshot.retryOf — a fresh §9.4.5 snapshot
 *    per A1-10 (later changes affect only later jobs), and queueBooking
 *    creates a new booking intent per order (§9.5.4). This is the documented
 *    choice over same-batch requeue.
 */

interface ShipmentCandidateRow {
  shipment_id: string;
  order_id: string;
  booking_state: string;
  service_id: string | null;
  pickup_location_id: string | null;
  awb_normalized: string | null;
  working_values: ShipmentWorkingValuesWeek4 | null;
}

/** Bookable source states for §3.2, in preference order. */
const BOOKABLE_STATES = ['DRAFT', 'FAILED', 'NEEDS_MANUAL_ASSIGNMENT'];

export type CreateBatchResult =
  | { created: true; batchId: string; state: 'QUEUED'; total: number }
  | {
      created: false;
      code: 'VALIDATION' | 'BULK_CONCURRENCY_EXCEEDED';
      message: string;
      limit?: number;
    };

@Injectable()
export class BulkBookingService {
  private readonly logger = new Logger(BulkBookingService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly audit: AuditService,
    private readonly booking: BookingService,
    private readonly quoteCache: QuoteCacheService,
    private readonly bulkQueue: BulkBookingQueueService,
  ) {}

  private activeKey(shopId: string): string {
    return `booking-ops:bulk:active:${shopId}`;
  }

  /** S-21: 2 concurrent bulk jobs per shop. Returns false when exceeded. */
  private async acquireBulkSlot(shopId: string): Promise<boolean> {
    const n = Number(await this.redis.incr(this.activeKey(shopId)));
    await this.redis.expire(this.activeKey(shopId), 24 * 3600); // crash safety
    if (n > MAX_CONCURRENT_BULK_JOBS_PER_SHOP) {
      await this.redis.decr(this.activeKey(shopId));
      return false;
    }
    return true;
  }

  private async releaseBulkSlot(shopId: string): Promise<void> {
    const n = Number(await this.redis.decr(this.activeKey(shopId)));
    if (n < 0) await this.redis.set(this.activeKey(shopId), '0');
  }

  /** §9.4.5: Service + rate-card versions at enqueue (rules land later). */
  private async captureVersionSnapshot(
    shopId: string,
    retryOf?: string,
  ): Promise<BatchVersionSnapshot> {
    const { rows: services } = await this.pool.query<{
      service_id: string;
      service_version_id: string | null;
    }>(
      `SELECT ms.service_id,
              (SELECT sv.service_version_id FROM service_version sv
                WHERE sv.service_id = ms.service_id AND sv.effective_from <= CURRENT_DATE
                ORDER BY sv.effective_from DESC LIMIT 1) AS service_version_id
         FROM merchant_service ms
        WHERE ms.shop_id = $1 AND ms.enabled
        ORDER BY ms.service_id`,
      [shopId],
    );
    const { rows: rateCards } = await this.pool.query<{
      rate_card_id: string;
      rate_card_version_id: string;
    }>(
      `SELECT rc.rate_card_id, rcv.rate_card_version_id
         FROM rate_card rc
         JOIN rate_card_version rcv ON rcv.rate_card_id = rc.rate_card_id
        WHERE rc.shop_id = $1
          AND rcv.effective_from <= now()
          AND (rcv.effective_to IS NULL OR rcv.effective_to > now())
        ORDER BY rc.rate_card_id`,
      [shopId],
    );
    return {
      capturedAt: new Date().toISOString(),
      rules: null,
      services: services.map((s) => ({
        serviceId: s.service_id,
        serviceVersionId: s.service_version_id,
      })),
      rateCardVersions: rateCards.map((r) => ({
        rateCardId: r.rate_card_id,
        rateCardVersionId: r.rate_card_version_id,
      })),
      ...(retryOf ? { retryOf } : {}),
    };
  }

  async createBatch(args: {
    shopId: string;
    actorId: string | null;
    orderIds: string[];
    retryOf?: string;
  }): Promise<CreateBatchResult> {
    const orderIds = [...new Set(args.orderIds ?? [])].filter((id) => typeof id === 'string' && id);
    if (orderIds.length === 0 || orderIds.length > BULK_BOOKING_MAX_ORDERS) {
      return {
        created: false,
        code: 'VALIDATION',
        message: `orderIds must contain 1..${BULK_BOOKING_MAX_ORDERS} orders (§9.5.2)`,
        limit: BULK_BOOKING_MAX_ORDERS,
      };
    }
    // S-21: the per-shop bulk-job quota — a 429-style structured refusal.
    if (!(await this.acquireBulkSlot(args.shopId))) {
      return {
        created: false,
        code: 'BULK_CONCURRENCY_EXCEEDED',
        message: `at most ${MAX_CONCURRENT_BULK_JOBS_PER_SHOP} concurrent bulk jobs per shop (S-21)`,
        limit: MAX_CONCURRENT_BULK_JOBS_PER_SHOP,
      };
    }
    try {
      const versionSnapshot = await this.captureVersionSnapshot(args.shopId, args.retryOf);
      const { rows } = await this.pool.query<{ batch_id: string }>(
        `INSERT INTO booking_batch
           (shop_id, requested_by, state, total, results, version_snapshot)
         VALUES ($1, $2, 'QUEUED', $3, '[]', $4)
         RETURNING batch_id`,
        [args.shopId, args.actorId, orderIds.length, JSON.stringify(versionSnapshot)],
      );
      const batchId = rows[0].batch_id;
      await this.audit.record({
        shopId: args.shopId,
        actorKind: args.actorId ? 'MEMBER' : 'SYSTEM',
        actorId: args.actorId,
        action: 'booking_bulk.batch_created', // §12
        objectType: 'booking_batch',
        objectId: batchId,
        after: { total: orderIds.length, retryOf: args.retryOf },
      });
      await this.bulkQueue.enqueueBulkJob({
        shopId: args.shopId,
        batchId,
        orderIds,
        requestedBy: args.actorId,
      });
      return { created: true, batchId, state: 'QUEUED', total: orderIds.length };
    } catch (err) {
      await this.releaseBulkSlot(args.shopId);
      throw err;
    }
  }

  /** Shop-scoped batch read (INV-1). Null = not this shop's batch. */
  async getBatch(shopId: string, batchId: string): Promise<BookingBatchRow | null> {
    const { rows } = await this.pool.query<BookingBatchRow>(
      `SELECT batch_id, shop_id, requested_by, state, total, processed,
              succeeded, failed, results, version_snapshot, version,
              created_at, updated_at
         FROM booking_batch
        WHERE shop_id = $1 AND batch_id = $2`,
      [shopId, batchId],
    );
    return rows[0] ?? null;
  }

  /**
   * §9.5.2 retry: a NEW batch over only the failed orders, linked to this one
   * via version_snapshot.retryOf (the documented choice — see header).
   */
  async retryFailed(args: {
    shopId: string;
    batchId: string;
    actorId: string | null;
  }): Promise<CreateBatchResult | { created: false; code: 'NOTHING_TO_RETRY' | 'NOT_TERMINAL'; message: string }> {
    const batch = await this.getBatch(args.shopId, args.batchId);
    if (!batch) return { created: false, code: 'NOT_TERMINAL', message: 'batch not found' };
    if (!['SUCCEEDED', 'PARTIAL', 'FAILED'].includes(batch.state)) {
      return { created: false, code: 'NOT_TERMINAL', message: `batch is ${batch.state}` };
    }
    const failedOrderIds = (batch.results ?? [])
      .filter((r) => r.status === 'FAILED')
      .map((r) => r.orderId);
    if (failedOrderIds.length === 0) {
      return { created: false, code: 'NOTHING_TO_RETRY', message: 'no failed orders in batch' };
    }
    return this.createBatch({
      shopId: args.shopId,
      actorId: args.actorId,
      orderIds: failedOrderIds,
      retryOf: args.batchId,
    });
  }

  /* ------------------------------------------------------------------------
   * The worker path (BullMQ shell calls this; plain method, unit-testable).
   * --------------------------------------------------------------------- */

  async processBatch(data: BulkBookingJobData): Promise<void> {
    const batch = await this.getBatch(data.shopId, data.batchId);
    if (!batch) return; // gone — nothing to do
    if (['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(batch.state)) {
      return; // terminal states are never regressed (INV-17)
    }
    if (batch.state === 'QUEUED') {
      await this.pool.query(
        `UPDATE booking_batch SET state = 'RUNNING', version = version + 1
          WHERE shop_id = $1 AND batch_id = $2 AND state = 'QUEUED'`,
        [data.shopId, data.batchId],
      );
    }

    // Resume semantics: a BullMQ redrive skips orders already recorded.
    const results: BatchOrderResult[] = Array.isArray(batch.results) ? [...batch.results] : [];
    const done = new Set(results.map((r) => r.orderId));
    let { processed, succeeded, failed } = batch;

    try {
      const shipments = await this.loadShipments(data.shopId, data.orderIds);
      await this.warmQuoteCache(data.shopId, shipments);

      for (const orderId of data.orderIds) {
        if (done.has(orderId)) continue;
        const result = await this.processOneOrder(data.shopId, orderId, shipments);
        results.push(result);
        processed += 1;
        if (result.status === 'QUEUED') succeeded += 1;
        else failed += 1;
        // §9.5.2 live progress: counters + results are visible per order.
        await this.pool.query(
          `UPDATE booking_batch
              SET processed = $3, succeeded = $4, failed = $5, results = $6,
                  version = version + 1
            WHERE shop_id = $1 AND batch_id = $2`,
          [data.shopId, data.batchId, processed, succeeded, failed, JSON.stringify(results)],
        );
      }

      // §3.27: all succeeded → SUCCEEDED; some skipped/failed → PARTIAL.
      const terminal = failed === 0 ? 'SUCCEEDED' : 'PARTIAL';
      await this.pool.query(
        `UPDATE booking_batch SET state = $3, version = version + 1
          WHERE shop_id = $1 AND batch_id = $2`,
        [data.shopId, data.batchId, terminal],
      );
      await this.audit.record({
        shopId: data.shopId,
        actorKind: 'SYSTEM',
        action: 'booking_bulk.batch_completed', // §12
        objectType: 'booking_batch',
        objectId: data.batchId,
        after: { state: terminal, total: batch.total, processed, succeeded, failed },
      });
    } finally {
      await this.releaseBulkSlot(data.shopId);
    }
  }

  private async loadShipments(
    shopId: string,
    orderIds: string[],
  ): Promise<Map<string, ShipmentCandidateRow[]>> {
    const { rows } = await this.pool.query<ShipmentCandidateRow>(
      `SELECT shipment_id, order_id, booking_state, service_id,
              pickup_location_id, awb_normalized, working_values
         FROM shipment
        WHERE shop_id = $1 AND order_id = ANY($2::uuid[])
        ORDER BY created_at`,
      [shopId, orderIds],
    );
    const byOrder = new Map<string, ShipmentCandidateRow[]>();
    for (const row of rows) {
      const list = byOrder.get(row.order_id) ?? [];
      list.push(row);
      byOrder.set(row.order_id, list);
    }
    return byOrder;
  }

  private async processOneOrder(
    shopId: string,
    orderId: string,
    shipments: Map<string, ShipmentCandidateRow[]>,
  ): Promise<BatchOrderResult> {
    const candidates = shipments.get(orderId) ?? [];
    if (candidates.length === 0) {
      // INV-20: reported, never silently skipped.
      return { orderId, shipmentId: null, status: 'FAILED', code: 'ORDER_NOT_FOUND' };
    }
    const shipment =
      candidates.find((s) => BOOKABLE_STATES.includes(s.booking_state)) ?? null;
    if (!shipment) {
      // Already booked / in flight — reported with the current state.
      return {
        orderId,
        shipmentId: candidates[0].shipment_id,
        status: 'FAILED',
        code: 'NO_BOOKABLE_SHIPMENT',
        currentState: candidates[0].booking_state,
      };
    }
    // The single booking path, reused (§9.5.1/§9.5.2): snapshot freeze, new
    // intent, queue enqueue all live inside queueBooking.
    const outcome = await this.booking.queueBooking({
      shopId,
      shipmentId: shipment.shipment_id,
      actorId: null, // bulk worker is a system actor
    });
    if (outcome.queued) {
      // ✓ queued-with-intent — the AWB lands asynchronously in the §5.7
      // booking worker and is read back from the shipment.
      return {
        orderId,
        shipmentId: shipment.shipment_id,
        status: 'QUEUED',
        bookingIntentId: outcome.bookingIntentId,
        merchantReference: outcome.merchantReference,
      };
    }
    // ✗ with the exact structured reason (INV-20): NEEDS_MANUAL_ASSIGNMENT
    // carries its §3.30 reason, INV-7 its failing checks, §9.5.6 its flag.
    return {
      orderId,
      shipmentId: shipment.shipment_id,
      status: 'FAILED',
      code: outcome.code,
      failures: outcome.failures,
      manualAssignmentReason: outcome.manualAssignmentReason,
      approvalNeeded: outcome.approvalNeeded,
      currentState: outcome.currentState,
    };
  }

  /**
   * §4.5 quote pre-resolution: group the batch's shipments by (service,
   * origin, destination, billable-weight band, payment mode) and warm each
   * distinct LIVE_QUOTE cache key exactly once before the booking stage.
   * Best-effort: a warm-up failure never blocks the batch — the booking
   * stage fetches through the same cache (at-most-once-per-key still holds).
   */
  private async warmQuoteCache(
    shopId: string,
    shipments: Map<string, ShipmentCandidateRow[]>,
  ): Promise<void> {
    const bookable = [...shipments.values()]
      .flat()
      .filter((s) => BOOKABLE_STATES.includes(s.booking_state) && s.service_id);
    if (bookable.length === 0) return;

    const serviceIds = [...new Set(bookable.map((s) => s.service_id as string))];
    const { rows: services } = await this.pool.query<{
      service_id: string;
      cost_source: string;
      courier_account_id: string;
    }>(
      `SELECT s.service_id, s.cost_source, ms.courier_account_id
         FROM service s
         JOIN merchant_service ms
           ON ms.service_id = s.service_id AND ms.shop_id = $1
        WHERE s.service_id = ANY($2::uuid[])`,
      [shopId, serviceIds],
    );
    const liveQuote = new Map(
      services.filter((s) => s.cost_source === 'LIVE_QUOTE').map((s) => [s.service_id, s]),
    );
    if (liveQuote.size === 0) return;

    const pickupIds = [...new Set(bookable.map((s) => s.pickup_location_id).filter(Boolean))];
    const { rows: pickups } = await this.pool.query<{
      pickup_location_id: string;
      pincode: string | null;
    }>(
      `SELECT pickup_location_id, pincode FROM pickup_location
        WHERE shop_id = $1 AND pickup_location_id = ANY($2::uuid[])`,
      [shopId, pickupIds],
    );
    const pickupPincode = new Map(pickups.map((p) => [p.pickup_location_id, p.pincode]));

    const { rows: versions } = await this.pool.query<{
      service_id: string;
      volumetric_divisor: string | null;
      min_billable_kg: string | null;
      billable_increment_kg: string | null;
    }>(
      `SELECT DISTINCT ON (service_id) service_id, volumetric_divisor,
              min_billable_kg, billable_increment_kg
         FROM service_version
        WHERE service_id = ANY($1::uuid[]) AND effective_from <= CURRENT_DATE
        ORDER BY service_id, effective_from DESC`,
      [serviceIds],
    );
    const serviceVersion = new Map(versions.map((v) => [v.service_id, v]));

    // Distinct §4.5 keys, first shipment of each group supplies the request.
    const distinct = new Map<string, { shipment: ShipmentCandidateRow; band: string | null }>();
    for (const shipment of bookable) {
      const svc = liveQuote.get(shipment.service_id as string);
      if (!svc) continue;
      const working = shipment.working_values;
      const destinationPincode = working?.recipient?.pincode ?? '';
      const originPincode = pickupPincode.get(shipment.pickup_location_id ?? '') ?? '';
      const paymentMode: payment_mode = working?.payment?.mode ?? 'UNRESOLVED';
      const deadWeightKg = working?.weight?.deadWeightKg ?? '0.000';
      const dims = working?.packageProfile ?? null;
      const sv = serviceVersion.get(shipment.service_id as string);
      const weights = dims
        ? computeWeights({
            deadWeightKg,
            lengthCm: dims.lengthCm,
            widthCm: dims.widthCm,
            heightCm: dims.heightCm,
            divisor: sv?.volumetric_divisor ?? null,
            minBillableKg: sv?.min_billable_kg ?? null,
            incrementKg: sv?.billable_increment_kg ?? null,
          })
        : null;
      const band = weights?.billableWeightKg ?? null;
      const key = JSON.stringify([
        shipment.service_id,
        originPincode,
        destinationPincode,
        band,
        paymentMode,
      ]);
      if (!distinct.has(key)) distinct.set(key, { shipment, band });
    }

    const shipDate = new Date().toISOString().slice(0, 10);
    for (const { shipment, band } of distinct.values()) {
      const svc = liveQuote.get(shipment.service_id as string);
      if (!svc) continue;
      const working = shipment.working_values;
      const request: QuoteRequest = {
        courierAccountId: svc.courier_account_id,
        serviceId: shipment.service_id as string,
        originPincode: pickupPincode.get(shipment.pickup_location_id ?? '') ?? '',
        destinationPincode: working?.recipient?.pincode ?? '',
        shipDate,
        pieces: 1, // INV-4
        deadWeightKg: working?.weight?.deadWeightKg ?? '0.000',
        lengthCm: working?.packageProfile?.lengthCm ?? '0.00',
        widthCm: working?.packageProfile?.widthCm ?? '0.00',
        heightCm: working?.packageProfile?.heightCm ?? '0.00',
        paymentMode: working?.payment?.mode ?? 'UNRESOLVED',
        collectible: working?.payment?.collectible ?? '0.00',
        declaredValue: '0.00',
        pickupLocationId: shipment.pickup_location_id ?? '',
      };
      try {
        await this.quoteCache.getLiveQuote(this.pool, {
          shopId,
          courierAccountId: svc.courier_account_id,
          request,
          billableWeightBand: band,
        });
      } catch (err) {
        // Non-fatal (§4.5 budget): the booking stage re-fetches through the
        // same cache. IDs and error class only — §5.7 control 4.
        this.logger.warn(
          `quote pre-resolution failed for service ${shipment.service_id}: ${(err as Error).name}`,
        );
      }
    }
  }
}
