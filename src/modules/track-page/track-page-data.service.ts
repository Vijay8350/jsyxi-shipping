import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import {
  MovementState,
  TrackPageBranding,
  TrackPageConfigView,
  TrackShipmentPageData,
  TrackTimelineEvent,
} from './track-page.types';

/**
 * Page-data builder (§9.16) shared by both access paths.
 *
 * Exposes: status (movement_state), timeline (tracking_event, newest first),
 * EDD (snapshot quote when present), courier name only when S-35 is on, item
 * summary (title / variant / quantity / thumbnail:null) only when S-36 is on.
 *
 * NEVER exposes address, contact data, credentials or order totals (§9.16):
 * this builder reads `snapshot.recipient` for NOTHING, and never reads
 * `snapshot.expectedQuote.total` — only its EDD triple. Redaction (recipient
 * nulled by the privacy module, §5.5) does not break the page: everything
 * below renders from the tracking timeline and non-PII snapshot parts.
 */

/** The shipment row shape both paths resolve to (parameterized, INV-1). */
export interface TrackShipmentRow {
  shipment_id: string;
  shop_id: string;
  order_id: string;
  movement_state: MovementState;
  awb_raw: string | null;
  is_test: boolean;
  snapshot: {
    recipient?: unknown; // ignored on purpose — §9.16 never renders it
    lines?: Array<{
      title?: string | null;
      variant?: string | null;
      quantity?: number;
    }> | null;
    expectedQuote?: {
      eddFrom?: string | null;
      eddTo?: string | null;
      eddSource?: string | null;
    } | null;
  } | null;
  courier_name: string | null;
}

interface TrackingEventRow {
  carrier_event_status: string | null;
  raw_status: string;
  occurred_at: string | Date;
  location_text: string | null;
  reason_text: string | null;
}

@Injectable()
export class TrackPageDataService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** §9.16 timeline: tracking_event rows, newest first (shop-scoped, INV-1). */
  async loadTimeline(
    shopId: string,
    shipmentId: string,
  ): Promise<TrackTimelineEvent[]> {
    const result = await this.pool.query<TrackingEventRow>(
      `SELECT carrier_event_status, raw_status, occurred_at, location_text, reason_text
         FROM tracking_event
        WHERE shop_id = $1 AND shipment_id = $2
        ORDER BY occurred_at DESC`,
      [shopId, shipmentId],
    );
    return result.rows.map((row) => ({
      status: row.carrier_event_status,
      rawStatus: row.raw_status,
      occurredAt:
        row.occurred_at instanceof Date
          ? row.occurred_at.toISOString()
          : String(row.occurred_at),
      locationText: row.location_text,
      reasonText: row.reason_text,
    }));
  }

  /**
   * Build the page data for one shipment. Pure mapping — the denylist test
   * serializes this and asserts no recipient/contact/total field can appear.
   */
  buildShipmentData(
    row: TrackShipmentRow,
    timeline: TrackTimelineEvent[],
    config: TrackPageConfigView,
  ): TrackShipmentPageData {
    const quote = row.snapshot?.expectedQuote ?? null;
    const edd =
      quote && (quote.eddFrom || quote.eddTo)
        ? {
            from: quote.eddFrom ?? null,
            to: quote.eddTo ?? null,
            source: quote.eddSource ?? null,
          }
        : null;

    return {
      status: row.movement_state,
      awb: row.awb_raw,
      isTest: row.is_test, // §9.23 persistent test marker
      // S-35: courier name only when the toggle is on.
      courierName: config.showCourierName ? row.courier_name : null,
      edd,
      // S-36: title, variant, quantity, thumbnail only (A1-07). Thumbnails
      // are NOT stored at v1 (no product image sync) — always null.
      items: config.showItemSummary
        ? (row.snapshot?.lines ?? []).map((line) => ({
            title: line.title ?? null,
            variant: line.variant ?? null,
            quantity: line.quantity ?? 0,
            thumbnail: null,
          }))
        : null,
      timeline,
    };
  }

  /** Branding block for the hosted page / snippet (S-31–S-34, S-49). */
  branding(config: TrackPageConfigView): TrackPageBranding {
    return {
      theme: config.theme,
      buttonColour: config.buttonColour,
      logoObjectKey: config.logoObjectKey,
      orderBoxLabel: config.orderBoxLabel,
      contactBoxLabel: config.contactBoxLabel,
    };
  }
}
