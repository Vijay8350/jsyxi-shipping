import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import {
  OBJECT_ERASE,
  ObjectEraseStore,
} from '../health/object-erase';
import { RETENTION_BATCH_SIZE } from './retention-horizons';

/**
 * §5.3 test-data carve-out (RV-08): the tables a test Shipment and "every
 * child record it owns" span. The purge preview reports exactly this set —
 * no more, no less — and the audit of the delete names the same tables
 * (§9.5.7: "the action names how many rows in which tables will go").
 *
 * tracking_event_raw has no shipment_id (0010): a test Shipment owns the
 * raw payloads ingested under its AWB, so the raw link is awb_normalized.
 */
export const TEST_SHIPMENT_CARVE_OUT_TABLES = [
  'shipment',
  'booking_intent',
  'tracking_event',
  'tracking_event_raw',
  'ndr_case',
  'ndr_action',
  'document',
  'rule_evaluation_trace',
  'shipment_line',
] as const;

export type CarveOutTable = (typeof TEST_SHIPMENT_CARVE_OUT_TABLES)[number];

/** §9.5.7 preview: how many rows in which tables would go. */
export type PurgePreview = Record<CarveOutTable, number>;

/** Per-batch counts written to §12 audit (the carve-out set plus the two
 *  ADD-27 ndr_case children deleted for FK integrity — see purge()). */
export interface PurgeBatchCounts extends Partial<Record<CarveOutTable, number>> {
  ndr_buyer_response?: number;
  ndr_response_token?: number;
}

const TEST_SHIPMENT_CTE = `
  WITH test_shipments AS (
    SELECT shipment_id, awb_normalized FROM shipment
     WHERE shop_id = $1 AND is_test
  )`;
const IN_TEST = `IN (SELECT shipment_id FROM test_shipments)`;
const CASE_IN_TEST = `IN (
    SELECT ndr_case_id FROM ndr_case
     WHERE shop_id = $1 AND shipment_id ${IN_TEST})`;

/**
 * §9.5.7 test-shipment housekeeping + the §5.3 carve-out (RV-08, INV-19).
 * Owner-only at the HTTP layer (permission 'test_shipments.bulk_delete',
 * §10.2 — RolesGuard); this service holds the data logic.
 *
 * INV-19 guard: test Shipments never produce an entitlement ledger entry, a
 * usage record, a GST invoice or a reconciliation row (§5.3), so the carve-
 * out DELETEs never touch those tables. That is asserted by construction
 * BEFORE anything is deleted: a guard query proves zero such rows exist for
 * this shop's test shipments and the purge refuses to run otherwise.
 * (usage_record carries no shipment reference at all — 0002 — so no test
 * linkage is possible there by construction; the checkable tables are
 * awb_entitlement_ledger.shipment_id, recon_cod_expected.shipment_id and
 * gst_invoice by order.)
 *
 * NOTE (privileges): migrations 0001–0017 grant jsyxi_app no DELETE on
 * booking_intent (0003 revokes it), tracking_event, tracking_event_raw or
 * ndr_action — the carve-out postdates those grants. See the module header
 * for the required follow-up migration.
 */
@Injectable()
export class TestShipmentsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(OBJECT_ERASE) private readonly erase: ObjectEraseStore,
    private readonly audit: AuditService,
  ) {}

  /**
   * §9.5.7 step 1: the counts per table that WOULD go, over exactly the
   * §5.3 carve-out set. Read-only.
   */
  async purgePreview(shopId: string): Promise<PurgePreview> {
    const { rows } = await this.pool.query<PurgePreview>(
      `${TEST_SHIPMENT_CTE}
       SELECT
         (SELECT count(*)::int FROM test_shipments) AS shipment,
         (SELECT count(*)::int FROM booking_intent
            WHERE shipment_id ${IN_TEST}) AS booking_intent,
         (SELECT count(*)::int FROM tracking_event
            WHERE shop_id = $1 AND shipment_id ${IN_TEST}) AS tracking_event,
         (SELECT count(*)::int FROM tracking_event_raw
            WHERE shop_id = $1 AND awb_normalized IN (
              SELECT awb_normalized FROM test_shipments
               WHERE awb_normalized IS NOT NULL)) AS tracking_event_raw,
         (SELECT count(*)::int FROM ndr_case
            WHERE shop_id = $1 AND shipment_id ${IN_TEST}) AS ndr_case,
         (SELECT count(*)::int FROM ndr_action
            WHERE ndr_case_id ${CASE_IN_TEST}) AS ndr_action,
         (SELECT count(*)::int FROM document
            WHERE shop_id = $1 AND shipment_id ${IN_TEST}) AS document,
         (SELECT count(*)::int FROM rule_evaluation_trace
            WHERE shop_id = $1 AND shipment_id ${IN_TEST}) AS rule_evaluation_trace,
         (SELECT count(*)::int FROM shipment_line
            WHERE shipment_id ${IN_TEST}) AS shipment_line`,
      [shopId],
    );
    const counts = rows[0];
    // Return keyed by the carve-out list so the shape is exactly that set.
    return Object.fromEntries(
      TEST_SHIPMENT_CARVE_OUT_TABLES.map((t) => [t, counts?.[t] ?? 0]),
    ) as PurgePreview;
  }

  /**
   * INV-19 guard — MUST run before any DELETE. Proves zero entitlement /
   * GST / recon rows are linked to this shop's test shipments; throws
   * otherwise and nothing is deleted.
   */
  async assertTestIsolation(shopId: string): Promise<void> {
    const { rows } = await this.pool.query<{
      entitlement_rows: number;
      recon_rows: number;
      gst_rows: number;
    }>(
      `${TEST_SHIPMENT_CTE}
       SELECT
         (SELECT count(*)::int FROM awb_entitlement_ledger
            WHERE shop_id = $1 AND shipment_id ${IN_TEST}) AS entitlement_rows,
         (SELECT count(*)::int FROM recon_cod_expected
            WHERE shop_id = $1 AND shipment_id ${IN_TEST}) AS recon_rows,
         (SELECT count(*)::int FROM gst_invoice g
            WHERE g.shop_id = $1
              AND EXISTS (SELECT 1 FROM shipment s
                           WHERE s.order_id = g.order_id AND s.is_test)
              AND NOT EXISTS (SELECT 1 FROM shipment s2
                               WHERE s2.order_id = g.order_id AND NOT s2.is_test)
         ) AS gst_rows`,
      [shopId],
    );
    const { entitlement_rows, recon_rows, gst_rows } = rows[0] ?? {
      entitlement_rows: 0,
      recon_rows: 0,
      gst_rows: 0,
    };
    if (entitlement_rows > 0 || recon_rows > 0 || gst_rows > 0) {
      // INV-19 breach is a data-integrity alarm, never a normal flow.
      throw new Error(
        'INV-19 violated: test shipments have financial rows; purge refused',
      );
    }
  }

  /**
   * §9.5.7 step 2: the irreversible delete. One transaction per batch of
   * ≤ RETENTION_BATCH_SIZE test shipments; document object bytes are erased
   * via the OBJECT_ERASE seam just before the transaction (the object store
   * is not transactional; erase is idempotent, so a retried run is safe).
   * Each committed batch writes ONE §12 audit row with the per-table counts.
   */
  async purge(shopId: string, memberId: string): Promise<PurgeBatchCounts> {
    // INV-19 guard first — before any object erasure or DELETE.
    await this.assertTestIsolation(shopId);

    const totals: PurgeBatchCounts = {};
    for (;;) {
      const { rows: batch } = await this.pool.query<{
        shipment_id: string;
        awb_normalized: string | null;
      }>(
        `SELECT shipment_id, awb_normalized FROM shipment
          WHERE shop_id = $1 AND is_test
          LIMIT $2`,
        [shopId, RETENTION_BATCH_SIZE],
      );
      if (batch.length === 0) break;
      const counts = await this.purgeBatch(shopId, batch);
      for (const [table, n] of Object.entries(counts)) {
        const key = table as keyof PurgeBatchCounts;
        totals[key] = (totals[key] ?? 0) + (n ?? 0);
      }
      await this.audit.record({
        shopId,
        actorKind: 'MEMBER',
        actorId: memberId,
        action: 'maintenance.test_shipments.bulk_delete',
        objectType: 'shipment',
        after: counts,
        reason: '§9.5.7 test-shipment bulk delete (§5.3 carve-out, RV-08)',
      });
    }
    return totals;
  }

  private async purgeBatch(
    shopId: string,
    batch: Array<{ shipment_id: string; awb_normalized: string | null }>,
  ): Promise<PurgeBatchCounts> {
    const shipmentIds = batch.map((s) => s.shipment_id);
    const awbs = batch
      .map((s) => s.awb_normalized)
      .filter((a): a is string => a !== null);

    // document rows carry object bytes; collect and erase first (INV-1:
    // only keys under this shop's own prefix are passed to the store).
    const { rows: docs } = await this.pool.query<{
      document_id: string;
      object_key: string;
    }>(
      `SELECT document_id, object_key FROM document
        WHERE shop_id = $1 AND shipment_id = ANY($2::uuid[])`,
      [shopId, shipmentIds],
    );
    for (const doc of docs) {
      if (!doc.object_key.startsWith(`shops/${shopId}/`)) {
        throw new Error(`object key outside shop prefix refused`);
      }
      await this.erase.delete(doc.object_key);
    }
    const documentIds = docs.map((d) => d.document_id);

    const client = await this.pool.connect();
    const counts: PurgeBatchCounts = {};
    try {
      await client.query('BEGIN');
      const del = async (
        table: keyof PurgeBatchCounts,
        sql: string,
        params: unknown[],
      ): Promise<void> => {
        const { rowCount } = await client.query(sql, params);
        counts[table] = rowCount ?? 0;
      };

      // §5.3: references block deletion — detach job result references to
      // this batch's documents before removing the document rows.
      await client.query(
        `UPDATE document_job SET result_document_id = NULL
          WHERE result_document_id = ANY($1::uuid[])`,
        [documentIds],
      );
      await client.query(
        `UPDATE report_job SET result_document_id = NULL
          WHERE result_document_id = ANY($1::uuid[])`,
        [documentIds],
      );

      // Children first, parent last (shipment FK is (shipment_id,
      // created_at) from booking_intent and shipment_line).
      // ndr_buyer_response / ndr_response_token are ADD-27 children of
      // ndr_case; the §5.3 carve-out predates them and they are deleted
      // here purely for FK integrity (no carve-out row is append-only).
      await del(
        'ndr_buyer_response',
        `DELETE FROM ndr_buyer_response
          WHERE shop_id = $1 AND ndr_case_id IN (
            SELECT ndr_case_id FROM ndr_case
             WHERE shop_id = $1 AND shipment_id = ANY($2::uuid[]))`,
        [shopId, shipmentIds],
      );
      await del(
        'ndr_response_token',
        `DELETE FROM ndr_response_token
          WHERE shop_id = $1 AND ndr_case_id IN (
            SELECT ndr_case_id FROM ndr_case
             WHERE shop_id = $1 AND shipment_id = ANY($2::uuid[]))`,
        [shopId, shipmentIds],
      );
      await del(
        'ndr_action',
        `DELETE FROM ndr_action
          WHERE ndr_case_id IN (
            SELECT ndr_case_id FROM ndr_case
             WHERE shop_id = $1 AND shipment_id = ANY($2::uuid[]))`,
        [shopId, shipmentIds],
      );
      await del(
        'ndr_case',
        `DELETE FROM ndr_case
          WHERE shop_id = $1 AND shipment_id = ANY($2::uuid[])`,
        [shopId, shipmentIds],
      );
      if (awbs.length > 0) {
        // §5.3: a test Shipment owns the raw payloads ingested under its
        // AWB (tracking_event_raw has no shipment_id — 0010).
        await del(
          'tracking_event_raw',
          `DELETE FROM tracking_event_raw
            WHERE shop_id = $1 AND awb_normalized = ANY($2::text[])`,
          [shopId, awbs],
        );
      } else {
        counts.tracking_event_raw = 0;
      }
      await del(
        'tracking_event',
        `DELETE FROM tracking_event
          WHERE shop_id = $1 AND shipment_id = ANY($2::uuid[])`,
        [shopId, shipmentIds],
      );
      await del(
        'rule_evaluation_trace',
        `DELETE FROM rule_evaluation_trace
          WHERE shop_id = $1 AND shipment_id = ANY($2::uuid[])`,
        [shopId, shipmentIds],
      );
      await del(
        'document',
        `DELETE FROM document
          WHERE shop_id = $1 AND document_id = ANY($2::uuid[])`,
        [shopId, documentIds],
      );
      await del(
        'booking_intent',
        `DELETE FROM booking_intent
          WHERE shipment_id = ANY($1::uuid[])`,
        [shipmentIds],
      );
      await del(
        'shipment_line',
        `DELETE FROM shipment_line
          WHERE shipment_id = ANY($1::uuid[])`,
        [shipmentIds],
      );
      await del(
        'shipment',
        `DELETE FROM shipment
          WHERE shop_id = $1 AND shipment_id = ANY($2::uuid[]) AND is_test`,
        [shopId, shipmentIds],
      );

      await client.query('COMMIT');
      return counts;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
