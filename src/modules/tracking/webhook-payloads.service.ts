import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { TrackingIngestService } from './tracking-ingest.service';
import { maskPayload } from './tracking.util';
import type { ProcessResult, TrackingParseResult, TrackingSource } from './tracking.types';

/**
 * ADD-18 webhook management surface: the last-20-raw-payloads debugging view
 * and the merchant-side replay. Read paths are shop-scoped (INV-1); payloads
 * are masked before display — the payload jsonb is raw courier data and may
 * carry recipient PII (INV-18, §5.7 control 4).
 */

/** ADD-18: the viewer always shows the last 20 payloads. */
export const PAYLOAD_VIEWER_LIMIT = 20;

export interface MaskedRawPayload {
  raw_event_id: string;
  received_at: string;
  source: TrackingSource;
  parse_result: TrackingParseResult;
  signature_valid: boolean;
  awb_normalized: string | null;
  /** Masked per INV-18 / §5.7 control 4 — never the raw jsonb. */
  payload: unknown;
}

@Injectable()
export class WebhookPayloadsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly ingest: TrackingIngestService,
  ) {}

  /** ADD-18: last 20 raw payloads for one courier account, masked. */
  async listPayloads(shopId: string, courierAccountId: string): Promise<MaskedRawPayload[]> {
    await this.assertAccount(shopId, courierAccountId);
    const { rows } = await this.pool.query<{
      raw_event_id: string;
      received_at: string;
      source: TrackingSource;
      parse_result: TrackingParseResult;
      signature_valid: boolean;
      awb_normalized: string | null;
      payload: unknown;
    }>(
      `SELECT raw_event_id, received_at, source, parse_result,
              signature_valid, awb_normalized, payload
         FROM tracking_event_raw
        WHERE shop_id = $1 AND courier_account_id = $2
        ORDER BY received_at DESC
        LIMIT ${PAYLOAD_VIEWER_LIMIT}`,
      [shopId, courierAccountId],
    );
    return rows.map((r) => ({ ...r, payload: maskPayload(r.payload) }));
  }

  /**
   * ADD-18 replay one payload — merchant-side (distinct from the admin §8.6
   * DLQ replay). Re-runs the same processRawEvent the worker calls; the
   * normalized-layer dedupe makes a repeat a no-op, so replay is idempotent.
   * Audited (§12). SIGNATURE_FAILURE rows stay untouched — replay never
   * legitimizes a bad signature.
   */
  async replayPayload(input: {
    shopId: string;
    courierAccountId: string;
    rawEventId: string;
    memberId: string;
  }): Promise<ProcessResult> {
    await this.assertAccount(input.shopId, input.courierAccountId);
    const { rows } = await this.pool.query<{ raw_event_id: string }>(
      `SELECT raw_event_id FROM tracking_event_raw
        WHERE shop_id = $1 AND courier_account_id = $2 AND raw_event_id = $3`,
      [input.shopId, input.courierAccountId, input.rawEventId],
    );
    if (rows.length === 0) throw new NotFoundException('raw payload not found for this account');

    const result = await this.ingest.processRawEvent(input.rawEventId);
    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'MEMBER',
      actorId: input.memberId,
      action: 'tracking.webhook_payload.replay', // §12, ADD-18
      objectType: 'tracking_event_raw',
      objectId: input.rawEventId,
      after: {
        courierAccountId: input.courierAccountId,
        parseResult: result.parseResult,
        stateChanged: result.stateChanged,
      },
    });
    return result;
  }

  /** INV-1: the account must belong to the caller's shop. */
  private async assertAccount(shopId: string, courierAccountId: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `SELECT courier_account_id FROM courier_account
        WHERE courier_account_id = $1 AND shop_id = $2`,
      [courierAccountId, shopId],
    );
    if ((rowCount ?? 0) === 0) throw new NotFoundException('courier account not found');
  }
}
