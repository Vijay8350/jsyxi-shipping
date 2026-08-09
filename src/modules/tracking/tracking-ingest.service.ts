import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { MovementReducerService } from './movement-reducer.service';
import {
  eventDedupeKey,
  extractTrackEvent,
  foldRawStatus,
  normalizeAwb,
  normalizeOccurredAt,
} from './tracking.util';
import type {
  CarrierEventStatus,
  ProcessResult,
  RawEventRow,
  TrackingParseResult,
} from './tracking.types';

/**
 * §9.7 normalization — the asynchronous half of §8.5. One raw row in, one
 * normalized tracking_event (at most) and one reducer application out.
 * Plain injectable method: the BullMQ worker is a thin shell over
 * processRawEvent, and the ADD-18 replay calls the same method — dedupe at
 * this layer makes any repeat a no-op.
 *
 * Pipeline (INV-20 — nothing is silently dropped):
 *  1. Extract the canonical event. Unextractable → AWB_QUARANTINED.
 *  2. Resolve the F-19-normalized AWB to a Shipment in the same shop
 *     (INV-1). No Shipment → AWB_QUARANTINED + surfaced, never dropped.
 *  3. Map the case-folded raw status via courier_status_map (§3.6). No row
 *     → the event is stored with NULL carrier_event_status + review_flag,
 *     parse_result UNMAPPED_STATUS, and NO state changes; the §9.13 courier
 *     API error monitor reads these (TrackingDelayService.listUnmappedStatuses).
 *  4. Dedupe again at this layer (§2.5 dedupe_key — provider event id else
 *     fingerprint within the resolved Shipment): advisory lock + existence
 *     check, a duplicate is a no-op.
 *  5. Mapped events go to the §3.4 reducer — the only movement_state writer.
 */
@Injectable()
export class TrackingIngestService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly reducer: MovementReducerService,
  ) {}

  async processRawEvent(rawEventId: string): Promise<ProcessResult> {
    const raw = await this.loadRaw(rawEventId);
    if (raw.parse_result === 'SIGNATURE_FAILURE') {
      // Recorded at ingest for the ADD-18 viewer; never processed (§8.5).
      return this.result(raw, raw.parse_result, null, null, null, false, false);
    }

    const extracted = extractTrackEvent(raw.payload);
    if (!extracted) {
      await this.setParseResult(raw, 'AWB_QUARANTINED');
      return this.result(raw, 'AWB_QUARANTINED', null, null, null, false, false);
    }
    const awbNormalized = normalizeAwb(extracted.awb);
    const occurredAt =
      normalizeOccurredAt(extracted.occurredAt) ?? new Date(raw.received_at).toISOString();

    // Resolve the AWB inside the shop (INV-1; INV-6 gives at most one
    // active AWB per shop+courier account).
    const shipment = await this.resolveShipment(raw.shop_id, awbNormalized);
    if (!shipment) {
      await this.setParseResult(raw, 'AWB_QUARANTINED', awbNormalized);
      return this.result(raw, 'AWB_QUARANTINED', null, null, null, false, false);
    }

    // §3.6: case-folded raw status → the only mapping target.
    const carrierStatus = await this.mapStatus(raw, shipment.courier_account_id, extracted.rawStatus);

    const dedupeKey = eventDedupeKey({
      shipmentId: shipment.shipment_id,
      event: { ...extracted, occurredAt },
    });

    // Normalized-layer dedupe + insert in one transaction (migration 0010:
    // partitioned tables carry no unique dedupe index).
    const client = await this.pool.connect();
    let eventId: string | null = null;
    let duplicate = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${raw.shop_id}:${dedupeKey}`,
      ]);
      const existing = await client.query(
        `SELECT event_id FROM tracking_event
          WHERE shipment_id = $1 AND dedupe_key = $2
          LIMIT 1`,
        [shipment.shipment_id, dedupeKey],
      );
      if ((existing.rowCount ?? 0) > 0) {
        duplicate = true;
      } else {
        const inserted = await client.query<{ event_id: string }>(
          `INSERT INTO tracking_event
             (shop_id, shipment_id, carrier_event_status, raw_status,
              occurred_at, location_text, reason_text, provider_event_id,
              dedupe_key, review_flag)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING event_id`,
          [
            raw.shop_id,
            shipment.shipment_id,
            carrierStatus,
            extracted.rawStatus,
            occurredAt,
            extracted.locationText,
            extracted.reasonText,
            extracted.providerEventId,
            dedupeKey,
            carrierStatus === null, // unmapped → review (§3.6, INV-20)
          ],
        );
        eventId = inserted.rows[0].event_id;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    if (duplicate) {
      await this.setParseResult(raw, 'DUPLICATE', awbNormalized);
      return this.result(raw, 'DUPLICATE', shipment.shipment_id, null, carrierStatus, false, false);
    }

    if (carrierStatus === null) {
      // §3.6: stored, alerted (the §9.13 monitor reads it), nothing changes.
      await this.setParseResult(raw, 'UNMAPPED_STATUS', awbNormalized);
      await this.touchAccountHealth(raw);
      return this.result(raw, 'UNMAPPED_STATUS', shipment.shipment_id, eventId, null, false, true);
    }

    const outcome = await this.reducer.applyEvent({
      shopId: raw.shop_id,
      shipmentId: shipment.shipment_id,
      eventId: eventId as string,
      status: carrierStatus,
      occurredAt,
    });
    await this.setParseResult(raw, 'ACCEPTED', awbNormalized);
    await this.touchAccountHealth(raw);
    return this.result(
      raw,
      'ACCEPTED',
      shipment.shipment_id,
      eventId,
      carrierStatus,
      outcome.stateChanged,
      outcome.reviewFlag,
    );
  }

  private async loadRaw(rawEventId: string): Promise<RawEventRow> {
    const { rows } = await this.pool.query<RawEventRow>(
      `SELECT raw_event_id, shop_id, courier_account_id, awb_normalized,
              payload, received_at, source, signature_valid, dedupe_hash,
              parse_result
         FROM tracking_event_raw
        WHERE raw_event_id = $1
        LIMIT 1`,
      [rawEventId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('raw tracking event not found');
    return row;
  }

  private async resolveShipment(
    shopId: string,
    awbNormalized: string,
  ): Promise<{ shipment_id: string; courier_account_id: string | null } | null> {
    const { rows } = await this.pool.query<{
      shipment_id: string;
      courier_account_id: string | null;
    }>(
      `SELECT shipment_id, courier_account_id
         FROM shipment
        WHERE shop_id = $1 AND awb_normalized = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [shopId, awbNormalized],
    );
    return rows[0] ?? null;
  }

  /** §3.6 mapping via the courier master (case-folded, migration 0006). */
  private async mapStatus(
    raw: RawEventRow,
    shipmentAccountId: string | null,
    rawStatus: string,
  ): Promise<CarrierEventStatus | null> {
    const accountId = raw.courier_account_id ?? shipmentAccountId;
    if (!accountId) return null;
    const { rows } = await this.pool.query<{ carrier_event_status: CarrierEventStatus }>(
      `SELECT m.carrier_event_status
         FROM courier_status_map m
         JOIN courier_account ca ON ca.courier_id = m.courier_id
        WHERE ca.courier_account_id = $1 AND m.raw_status = $2`,
      [accountId, foldRawStatus(rawStatus)],
    );
    return rows[0]?.carrier_event_status ?? null;
  }

  /**
   * §8.5 health: events flowing → last_event_received_at stamped and the
   * account back to HEALTHY (§3.21). DISCONNECTED/DISABLED are explicit
   * states an inbound event does not silently override (RW-17: none is
   * terminal — the outbound health transitions own those).
   */
  private async touchAccountHealth(raw: RawEventRow): Promise<void> {
    if (!raw.courier_account_id) return;
    await this.pool.query(
      `UPDATE courier_account
          SET last_event_received_at = now(),
              health_state = CASE
                WHEN health_state IN ('UNVERIFIED', 'DEGRADED') THEN 'HEALTHY'
                ELSE health_state
              END
        WHERE courier_account_id = $1 AND shop_id = $2`,
      [raw.courier_account_id, raw.shop_id],
    );
  }

  private async setParseResult(
    raw: RawEventRow,
    parseResult: TrackingParseResult,
    awbNormalized?: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE tracking_event_raw
          SET parse_result = $2,
              awb_normalized = COALESCE($3, awb_normalized)
        WHERE raw_event_id = $1`,
      [raw.raw_event_id, parseResult, awbNormalized ?? null],
    );
  }

  private result(
    raw: RawEventRow,
    parseResult: TrackingParseResult,
    shipmentId: string | null,
    eventId: string | null,
    carrierEventStatus: CarrierEventStatus | null,
    stateChanged: boolean,
    reviewFlag: boolean,
  ): ProcessResult {
    return {
      rawEventId: raw.raw_event_id,
      parseResult,
      shipmentId,
      eventId,
      carrierEventStatus,
      stateChanged,
      reviewFlag,
    };
  }
}
