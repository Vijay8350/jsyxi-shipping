import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import { AdapterCallerService } from '../courier-framework/adapter-caller.service';
import { CourierWebhookIngestService } from './courier-webhook-ingest.service';
import { TERMINAL_MOVEMENT_STATES } from './movement-reducer.service';
import type { MovementState } from './tracking.types';

/**
 * §8.5 polling fallback. Couriers without push webhooks (or during a webhook
 * outage) are polled through the adapter's `track(awb)`; the returned events
 * enter the SAME raw table and normalization path as webhooks (source POLL).
 *
 * Cohorts (§8.5):
 *  - NEW: CONFIRMED shipments still in NOT_SHIPPED — polled every 2 hours.
 *  - IN_TRANSIT: any non-terminal movement state — polled every 4 hours.
 *  - Terminal movement states (§3.4) are never polled — polling stops there.
 *
 * Quotas (S-21 spirit): per courier account the sweep is strictly sequential
 * (concurrency 1) so one merchant's polling fan-out cannot starve shared
 * workers; the adapter call itself passes through the per-account rate
 * limiter and circuit breaker in AdapterCallerService. A per-shipment Redis
 * throttle key additionally pins the 2h/4h cadence even if sweeps overlap.
 */

export type PollCohort = 'NEW' | 'IN_TRANSIT';

/** Cohort → poll cadence (§8.5). */
export const POLL_INTERVAL_MS: Record<PollCohort, number> = {
  NEW: 2 * 3600_000,
  IN_TRANSIT: 4 * 3600_000,
};

/** §3.4 non-terminal movement states beyond NOT_SHIPPED. */
const IN_TRANSIT_STATES: MovementState[] = [
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'NDR',
  'RTO_INITIATED',
  'RTO_IN_TRANSIT',
  'RTO_OUT_FOR_DELIVERY',
];

export interface PollCandidate {
  shipment_id: string;
  shop_id: string;
  courier_account_id: string;
  awb_raw: string | null;
  awb_normalized: string;
  movement_state: MovementState;
}

export interface PollSweepResult {
  cohort: PollCohort;
  candidates: number;
  polled: number;
  throttled: number;
  failed: number;
  /** Shipment ids whose track call failed — ids only (§5.7 control 4). */
  failedShipmentIds: string[];
}

@Injectable()
export class TrackingPollingService {
  private readonly logger = new Logger(TrackingPollingService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly adapterCaller: AdapterCallerService,
    // forwardRef: polling → ingest → tracking-queue → polling is a file-level
    // import cycle (live boot proved it).
    @Inject(forwardRef(() => CourierWebhookIngestService))
    private readonly ingest: CourierWebhookIngestService,
  ) {}

  /**
   * The cohort query (INV-1 shop scoping comes from the account join; the
   * sweep is platform-wide per account). Terminal states are excluded here —
   * this is where "stopping at a terminal state" (§8.5) lives.
   */
  async listPollCandidates(cohort: PollCohort): Promise<PollCandidate[]> {
    const states = cohort === 'NEW' ? ['NOT_SHIPPED'] : IN_TRANSIT_STATES;
    const { rows } = await this.pool.query<PollCandidate>(
      `SELECT s.shipment_id, s.shop_id, s.courier_account_id,
              s.awb_raw, s.awb_normalized, s.movement_state
         FROM shipment s
         JOIN courier_account ca
           ON ca.courier_account_id = s.courier_account_id
          AND ca.shop_id = s.shop_id
        WHERE s.booking_state = 'CONFIRMED'
          AND s.awb_normalized IS NOT NULL
          AND s.movement_state = ANY($1::movement_state[])
          AND ca.disabled_at IS NULL
        ORDER BY s.booked_at ASC NULLS FIRST`,
      [states],
    );
    // Defensive: the query already excludes terminal states; assert the
    // cohort invariant here so a future edit cannot silently re-include one.
    return rows.filter((r) => !TERMINAL_MOVEMENT_STATES.has(r.movement_state));
  }

  /**
   * One sweep of a cohort. Per account strictly sequential (concurrency 1,
   * S-21 spirit); each shipment throttled to its cohort cadence (§8.5).
   */
  async runPollSweep(cohort: PollCohort, now = new Date()): Promise<PollSweepResult> {
    const candidates = await this.listPollCandidates(cohort);
    const result: PollSweepResult = {
      cohort,
      candidates: candidates.length,
      polled: 0,
      throttled: 0,
      failed: 0,
      failedShipmentIds: [],
    };
    for (const candidate of candidates) {
      if (await this.recentlyPolled(candidate.shipment_id, cohort, now)) {
        result.throttled += 1;
        continue;
      }
      try {
        const events = await this.adapterCaller.call(
          candidate.shop_id,
          candidate.courier_account_id,
          'track',
          (adapter) => adapter.track(candidate.awb_raw ?? candidate.awb_normalized),
        );
        // Same normalization path as webhooks, source POLL (§8.5).
        await this.ingest.ingestPolledEvents({
          shopId: candidate.shop_id,
          courierAccountId: candidate.courier_account_id,
          awb: candidate.awb_raw ?? candidate.awb_normalized,
          events,
        });
        await this.markPolled(candidate.shipment_id, cohort, now);
        result.polled += 1;
      } catch (err) {
        // A failed poll never drops the shipment from future sweeps; the
        // breaker/limiter state lives in AdapterCallerService. Ids only.
        this.logger.warn(
          `poll failed for shipment ${candidate.shipment_id}: ${(err as Error).name}`,
        );
        result.failed += 1;
        result.failedShipmentIds.push(candidate.shipment_id);
      }
    }
    return result;
  }

  private throttleKey(shipmentId: string, cohort: PollCohort): string {
    return `track:poll:${cohort}:${shipmentId}`;
  }

  private async recentlyPolled(
    shipmentId: string,
    cohort: PollCohort,
    now: Date,
  ): Promise<boolean> {
    const last = await this.redis.get(this.throttleKey(shipmentId, cohort));
    if (!last) return false;
    return now.getTime() - Number(last) < POLL_INTERVAL_MS[cohort];
  }

  private async markPolled(shipmentId: string, cohort: PollCohort, now: Date): Promise<void> {
    // Key expires well past the cadence; the timestamp inside is authoritative.
    await this.redis.set(
      this.throttleKey(shipmentId, cohort),
      String(now.getTime()),
      'EX',
      Math.ceil((POLL_INTERVAL_MS[cohort] * 2) / 1000),
    );
  }
}
