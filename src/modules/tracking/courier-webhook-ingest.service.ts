import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../database/database.module';
import {
  extractTrackEvent,
  normalizeAwb,
  normalizeOccurredAt,
  rawDedupeHash,
} from './tracking.util';
import { TrackingIngestQueueService } from './tracking-queue';
import type { CanonicalTrackEvent, IngestResult } from './tracking.types';
import type { TrackEvent } from '../courier-framework/adapter.types';

/**
 * §8.5 durable ingest tier — the ONLY writer of tracking_event_raw.
 *
 * Ordering contract (A1-10): the raw payload is persisted BEFORE the caller
 * acknowledges, so an ack is never sent for an event we could lose. All
 * normalization is asynchronous via the `tracking-ingest` queue.
 *
 * Dedupe (§8.5): provider event id preferred, else the canonical fingerprint
 * (raw status + normalized occurred-at + location + reason). The tables are
 * partitioned, so no unique index can enforce this — the ingest transaction
 * takes a transaction-scoped advisory lock on the dedupe hash and checks for
 * an existing row (migration 0010 header). A repeat lands as a DUPLICATE raw
 * row (visible in the ADD-18 payload viewer) and is never processed — the
 * ack still succeeds: a repeat is a no-op.
 *
 * Signature failures: the webhook controller rejects bad HMACs itself; when
 * it asks us to record one, the payload lands as SIGNATURE_FAILURE and is
 * never queued. The method stays tolerant — it never throws on bad JSON or
 * missing fields; unextractable payloads are stored and quarantined later
 * (INV-20).
 */
@Injectable()
export class CourierWebhookIngestService {
  private readonly logger = new Logger(CourierWebhookIngestService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly queue: TrackingIngestQueueService,
  ) {}

  /**
   * Persist one verified (or explicitly failed-signature) webhook payload.
   * Called by CourierWebhookController BEFORE it returns the 2xx ack (§8.5).
   */
  async ingestVerifiedWebhook(input: {
    courierAccountId: string;
    courierCode: string;
    shopId: string;
    rawBody: Buffer;
    signatureValid: boolean;
  }): Promise<IngestResult> {
    const payload = parsePayload(input.rawBody);
    if (!input.signatureValid) {
      // Rejected signatures are recorded, never processed (§8.1 behaviour
      // mirrored for couriers; ADD-18 surfaces them in the payload viewer).
      const rawEventId = await this.insertRaw({
        shopId: input.shopId,
        courierAccountId: input.courierAccountId,
        payload,
        source: 'WEBHOOK',
        signatureValid: false,
        dedupeHash: null,
        awbNormalized: null,
        parseResult: 'SIGNATURE_FAILURE',
      });
      return { rawEventId, parseResult: 'SIGNATURE_FAILURE', queued: false };
    }
    return this.persistAndQueue({
      shopId: input.shopId,
      courierAccountId: input.courierAccountId,
      payload,
      source: 'WEBHOOK',
    });
  }

  /**
   * §8.5 polling fallback: adapter `track(awb)` events enter through the
   * SAME raw table and the SAME normalization path as webhooks, with
   * source = POLL. Each TrackEvent is re-serialized to the canonical payload
   * shape so one extractor serves both sources.
   */
  async ingestPolledEvents(input: {
    shopId: string;
    courierAccountId: string;
    awb: string;
    events: TrackEvent[];
  }): Promise<IngestResult[]> {
    const results: IngestResult[] = [];
    for (const ev of input.events) {
      const payload: CanonicalTrackEvent = {
        awb: input.awb,
        rawStatus: ev.rawStatus,
        occurredAt: ev.occurredAt,
        locationText: ev.locationText,
        reasonText: ev.reasonText,
        providerEventId: ev.providerEventId,
      };
      results.push(
        await this.persistAndQueue({
          shopId: input.shopId,
          courierAccountId: input.courierAccountId,
          payload,
          source: 'POLL',
        }),
      );
    }
    return results;
  }

  /**
   * Insert the raw row under the dedupe guard and queue normalization.
   * Dedupe runs inside one transaction: advisory lock on the dedupe hash →
   * existence check → insert PENDING or DUPLICATE (migration 0010 header).
   */
  private async persistAndQueue(input: {
    shopId: string;
    courierAccountId: string;
    payload: unknown;
    source: 'WEBHOOK' | 'POLL';
  }): Promise<IngestResult> {
    const extracted = extractTrackEvent(input.payload);
    const awbNormalized = extracted ? normalizeAwb(extracted.awb) : null;
    const occurredAt = extracted
      ? (extracted && normalizeOccurredAt(extracted.occurredAt)) ?? new Date().toISOString()
      : null;
    const dedupeHash = extracted
      ? rawDedupeHash({
          shopId: input.shopId,
          courierAccountId: input.courierAccountId,
          awbNormalized: awbNormalized as string,
          event: { ...extracted, occurredAt: occurredAt as string },
        })
      : // Unextractable payloads still dedupe: identical redeliveries of the
        // same body are one logical event (§8.5 fingerprint spirit).
        `body:${createHash('sha256').update(stableStringify(input.payload)).digest('hex')}`;

    const client = await this.pool.connect();
    let rawEventId: string;
    let duplicate: boolean;
    try {
      await client.query('BEGIN');
      // Partitioned tables allow no unique dedupe index — lock + check.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [dedupeHash]);
      const existing = await client.query(
        `SELECT raw_event_id FROM tracking_event_raw
          WHERE shop_id = $1 AND dedupe_hash = $2
          LIMIT 1`,
        [input.shopId, dedupeHash],
      );
      duplicate = (existing.rowCount ?? 0) > 0;
      rawEventId = await this.insertRaw(
        {
          shopId: input.shopId,
          courierAccountId: input.courierAccountId,
          payload: input.payload,
          source: input.source,
          signatureValid: true,
          dedupeHash,
          awbNormalized,
          parseResult: duplicate ? 'DUPLICATE' : 'PENDING',
        },
        client,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    if (duplicate) {
      // §8.5: a repeat is a no-op; the ack still succeeds.
      return { rawEventId, parseResult: 'DUPLICATE', queued: false };
    }
    // Durable first, then queued — the worker can always re-read the row.
    await this.queue.enqueueRawEvent(rawEventId);
    return { rawEventId, parseResult: 'PENDING', queued: true };
  }

  private async insertRaw(
    input: {
      shopId: string;
      courierAccountId: string;
      payload: unknown;
      source: 'WEBHOOK' | 'POLL';
      signatureValid: boolean;
      dedupeHash: string | null;
      awbNormalized: string | null;
      parseResult: 'PENDING' | 'DUPLICATE' | 'SIGNATURE_FAILURE';
    },
    client?: PoolClient,
  ): Promise<string> {
    const db = client ?? this.pool;
    const { rows } = await db.query<{ raw_event_id: string }>(
      `INSERT INTO tracking_event_raw
         (shop_id, courier_account_id, awb_normalized, payload, source,
          signature_valid, dedupe_hash, parse_result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING raw_event_id`,
      [
        input.shopId,
        input.courierAccountId,
        input.awbNormalized,
        JSON.stringify(input.payload),
        input.source,
        input.signatureValid,
        input.dedupeHash,
        input.parseResult,
      ],
    );
    return rows[0].raw_event_id;
  }
}

/** Tolerant body parse: unparseable bodies are stored, never thrown (INV-20). */
function parsePayload(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { unparsed_body: rawBody.toString('utf8').slice(0, 4000) };
  }
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
