import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { Paise, paiseToRupees, rupeesToPaise } from '../../common/money';
import { LocalFilesystemObjectStore, OBJECT_STORE } from '../booking-ops/object-store';
import { BookingSnapshot, ExpectedCostBasis } from '../booking/booking.types';
import { NotificationService } from '../notifications/notification.service';
import { NOTIFICATION_EVENTS } from '../notifications/notifications.types';
import { ComponentRowInput, SlabInput, TariffInput } from '../rate-engine/pricing';
import { RowParseFailure, mapInvoiceRows, parseCsv } from './recon-csv';
import { controlTotal, matchGroup } from './recon-matching';
import { ReconSettingsService } from './recon-settings.service';
import {
  ChargeType,
  FREIGHT_IMPORT_MAX_ROWS,
  FreightColumnMap,
  FreightField,
  ParsedInvoiceRow,
  ShipmentReconView,
  weightMismatch,
} from './recon-freight.types';

/**
 * §9.17.2 freight batch processing: parse → match → insert, in ONE
 * transaction. The §10.4 trigger (migration 0015) makes imported values and
 * the four flags immutable after insert, so EVERYTHING — shipment
 * resolution, F-23/F-12 expectations, the three independent flags and
 * flag_review — is final before the row is written.
 *
 * INV-19: test shipments never reconcile — the AWB lookup excludes them, so
 * an invoice row naming a test AWB reads as flag_awb_not_found.
 * §5.7 control 4: logs carry batch ids and counts only — no file content.
 */

interface BatchForProcessing {
  batch_id: string;
  shop_id: string;
  courier_account_id: string;
  batch_reference: string;
  content_hash: string;
  column_map_id: string | null;
  declared_invoice_total: string | null;
  state: string;
  version: number;
}

interface GroupPlan {
  key: string;
  chargeType: ChargeType;
  chargeTypeUnmapped: boolean;
  rows: ParsedInvoiceRow[];
  rowIds: string[];
  shipment: ShipmentReconView | null;
  adjustmentTotal: Paise;
  /** Set for ADJUSTMENT groups once their target row is identified (RW-24). */
  adjustsRowId: string | null;
  /** Final per-group outcome (filled by compute()). */
  outcome: {
    flagAwbNotFound: boolean;
    flagAmountMismatch: boolean;
    flagReview: boolean;
    expectedAmount: string | null;
    auditedAmount: string | null;
  } | null;
}

const ADJUST_TARGET_PREFERENCE: readonly ChargeType[] = [
  'FORWARD',
  'RTO',
  'COD_FEE',
  'REATTEMPT',
  'OTHER',
];

@Injectable()
export class ReconProcessingService {
  private readonly logger = new Logger(ReconProcessingService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(OBJECT_STORE) private readonly store: LocalFilesystemObjectStore,
    private readonly settings: ReconSettingsService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
  ) {}

  /** The queue job's entry point — a plain method, BullMQ is a thin shell. */
  async processBatch(batchId: string): Promise<void> {
    const { rows } = await this.pool.query<BatchForProcessing>(
      `SELECT batch_id, shop_id, courier_account_id, batch_reference, content_hash,
              column_map_id, declared_invoice_total, state::text, version
         FROM recon_freight_batch WHERE batch_id = $1`,
      [batchId],
    );
    const batch = rows[0];
    if (!batch) throw new Error(`recon freight batch not found: ${batchId}`);
    if (batch.state !== 'UPLOADED' && batch.state !== 'PARSED') {
      return; // retry-safe: an already processed/failed batch is a no-op
    }

    let parsed: ParsedInvoiceRow[];
    try {
      parsed = await this.parseStoredFile(batch);
    } catch (err) {
      await this.failBatch(
        batch,
        err instanceof RowParseFailure ? err.message : 'file could not be read',
      );
      return;
    }
    if (parsed.length > FREIGHT_IMPORT_MAX_ROWS) {
      await this.failBatch(batch, `row limit exceeded (§5.1: ${FREIGHT_IMPORT_MAX_ROWS})`);
      return;
    }

    await this.markState(batch, 'PARSED');
    await this.matchAndPersist(batch, parsed);
  }

  private async parseStoredFile(batch: BatchForProcessing): Promise<ParsedInvoiceRow[]> {
    if (!batch.column_map_id) throw new RowParseFailure('no column map declared', 0);
    const { rows: maps } = await this.pool.query<{
      courier_id: string;
      mappings_json: unknown;
      charge_type_column: string | null;
      charge_type_value_map: unknown;
    }>(
      `SELECT courier_id, mappings_json, charge_type_column, charge_type_value_map
         FROM import_column_map
        WHERE column_map_id = $1 AND kind = 'FREIGHT'`,
      [batch.column_map_id],
    );
    const mapRow = maps[0];
    if (!mapRow) throw new RowParseFailure('column map not found', 0);
    const columnMap: FreightColumnMap = {
      columnMapId: batch.column_map_id,
      courierId: mapRow.courier_id,
      name: '',
      mappings: (mapRow.mappings_json ?? {}) as Partial<Record<FreightField, string>>,
      chargeTypeColumn: mapRow.charge_type_column,
      chargeTypeValueMap: (mapRow.charge_type_value_map ?? null) as Record<string, ChargeType> | null,
    };

    const bytes = await this.store.get(
      `shops/${batch.shop_id}/recon/imports/${batch.content_hash}`,
    );
    const grid = parseCsv(bytes.toString('utf8'));
    return mapInvoiceRows(grid, columnMap); // throws RowParseFailure (§3.18 FAILED)
  }

  /** §3.18 FAILED: holds no rows, not idempotency-blocking; §8.6 DLQ + audit. */
  private async failBatch(batch: BatchForProcessing, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE recon_freight_batch SET state = 'FAILED', version = version + 1
        WHERE batch_id = $1 AND version = $2`,
      [batch.batch_id, batch.version],
    );
    await this.pool.query(
      `INSERT INTO dlq_item (shop_id, queue, payload, error)
       VALUES ($1, 'recon-processing', $2, $3)`,
      [batch.shop_id, JSON.stringify({ batchId: batch.batch_id }), error],
    );
    await this.audit.record({
      shopId: batch.shop_id,
      actorKind: 'SYSTEM',
      action: 'recon.freight_batch_failed', // §12
      objectType: 'recon_freight_batch',
      objectId: batch.batch_id,
      before: { state: batch.state },
      after: { state: 'FAILED' },
      reason: error,
    });
    this.logger.warn(`freight batch ${batch.batch_id} FAILED: ${error}`);
  }

  private async markState(batch: BatchForProcessing, state: 'PARSED'): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE recon_freight_batch SET state = $3, version = version + 1
        WHERE batch_id = $1 AND version = $2`,
      [batch.batch_id, batch.version, state],
    );
    if (rowCount !== 1) throw new Error(`batch ${batch.batch_id} version conflict`); // INV-22
    batch.version += 1;
  }

  /* ------------------------------------------------------------------------
   * Matching (§4.8)
   * --------------------------------------------------------------------- */

  private async loadShipments(
    shopId: string,
    courierAccountId: string,
    awbs: string[],
  ): Promise<Map<string, ShipmentReconView>> {
    const result = new Map<string, ShipmentReconView>();
    if (awbs.length === 0) return result;
    const { rows } = await this.pool.query<{
      shipment_id: string;
      awb_normalized: string;
      expected_cost_basis: ExpectedCostBasis | null;
      provider_confirmed_charge: string | null;
      snapshot: BookingSnapshot | null;
    }>(
      `SELECT DISTINCT ON (s.awb_normalized)
              s.shipment_id, s.awb_normalized, s.expected_cost_basis::text,
              -- §3.25: the confirmed charge, persisted at CONFIRMED
              -- (migration 0016); §4.8 FORWARD expectations read it.
              s.provider_confirmed_charge::text,
              s.snapshot
         FROM shipment s
        WHERE s.shop_id = $1 AND s.awb_normalized = ANY($2)
          AND s.is_test = false            -- INV-19
        ORDER BY s.awb_normalized,
                 (s.courier_account_id = $3) DESC,
                 s.created_at DESC`,
      [shopId, awbs, courierAccountId],
    );
    for (const r of rows) {
      result.set(r.awb_normalized, {
        shipmentId: r.shipment_id,
        awbNormalized: r.awb_normalized,
        expectedCostBasis: r.expected_cost_basis,
        providerConfirmedCharge: r.provider_confirmed_charge,
        snapshot: r.snapshot,
      });
    }
    return result;
  }

  /** The sealed tariff behind a snapshot's rateCardVersionId (INV-8/INV-11). */
  private async loadTariff(
    shopId: string,
    rateCardVersionId: string,
  ): Promise<TariffInput | null> {
    const { rows: versions } = await this.pool.query<{
      fuel_pct: string;
      cod_flat: string;
      cod_pct: string;
      gst_pct: string;
      taxable_components: string[];
    }>(
      `SELECT v.fuel_pct, v.cod_flat, v.cod_pct, v.gst_pct, v.taxable_components
         FROM rate_card_version v
         JOIN rate_card rc ON rc.rate_card_id = v.rate_card_id
        WHERE v.rate_card_version_id = $1 AND rc.shop_id = $2`,
      [rateCardVersionId, shopId],
    );
    const v = versions[0];
    if (!v) return null;
    const { rows: slabRows } = await this.pool.query<SlabInput & Record<string, never>>(
      `SELECT zone, base_weight_kg AS "baseWeightKg", base_rate AS "baseRate",
              additional_step_kg AS "additionalStepKg", additional_rate AS "additionalRate"
         FROM rate_card_slab WHERE rate_card_version_id = $1`,
      [rateCardVersionId],
    );
    const { rows: componentRows } = await this.pool.query<
      ComponentRowInput & Record<string, never>
    >(
      `SELECT code, label, basis, value, is_taxable AS "isTaxable", position
         FROM rate_card_component WHERE rate_card_version_id = $1 ORDER BY position`,
      [rateCardVersionId],
    );
    return {
      fuelPct: v.fuel_pct,
      codFlat: v.cod_flat,
      codPct: v.cod_pct,
      gstPct: v.gst_pct,
      taxableComponents: v.taxable_components,
      slabs: slabRows,
      components: componentRows,
    };
  }

  private async matchAndPersist(
    batch: BatchForProcessing,
    parsed: ParsedInvoiceRow[],
  ): Promise<void> {
    const tolerances = await this.settings.effective(batch.shop_id, batch.courier_account_id);

    // Group by (AWB, charge_type) — §4.8 flags are per group; same-type rows
    // for one AWB are summed before comparison (A2-05).
    const groups = new Map<string, GroupPlan>();
    for (const row of parsed) {
      const key = `${row.awbNormalized}|||${row.chargeType}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          chargeType: row.chargeType,
          chargeTypeUnmapped: row.chargeTypeUnmapped,
          rows: [],
          rowIds: [],
          shipment: null,
          adjustmentTotal: 0n,
          adjustsRowId: null,
          outcome: null,
        };
        groups.set(key, group);
      }
      group.rows.push(row);
      group.rowIds.push(randomUUID()); // pre-generated so RW-24 links are known pre-insert
      group.chargeTypeUnmapped = group.chargeTypeUnmapped || row.chargeTypeUnmapped;
    }

    const awbs = [...new Set(parsed.map((r) => r.awbNormalized).filter((a) => a !== ''))];
    const shipments = await this.loadShipments(batch.shop_id, batch.courier_account_id, awbs);
    for (const group of groups.values()) {
      group.shipment = shipments.get(group.rows[0].awbNormalized) ?? null;
    }

    // Tariffs for the snapshots involved (sealed versions — INV-11).
    const tariffs = new Map<string, TariffInput | null>();
    for (const group of groups.values()) {
      const rcvId = group.shipment?.snapshot?.rateCardVersionId ?? null;
      if (rcvId !== null && !tariffs.has(rcvId)) {
        tariffs.set(rcvId, await this.loadTariff(batch.shop_id, rcvId));
      }
    }

    // RW-24: resolve ADJUSTMENT groups to the row they adjust BEFORE target
    // groups finalize, so a same-batch target's comparison includes the sum.
    const adjustmentGroups = [...groups.values()].filter((g) => g.chargeType === 'ADJUSTMENT');
    const targetGroups = new Map<string, GroupPlan>();
    for (const g of groups.values()) {
      if (g.chargeType !== 'ADJUSTMENT') targetGroups.set(g.key, g);
    }
    const sameBatchTarget = (awb: string): GroupPlan | null => {
      const candidates = ADJUST_TARGET_PREFERENCE.map((ct) =>
        targetGroups.get(`${awb}|||${ct}`),
      ).filter((g): g is GroupPlan => g !== undefined);
      return candidates[0] ?? null;
    };

    interface CrossBatchTarget {
      rowId: string;
      invoicedAmount: string | null;
      expectedAmount: string | null;
      priorAdjustments: Paise;
    }
    const crossBatchTargets = new Map<string, CrossBatchTarget | null>();
    for (const adj of adjustmentGroups) {
      const awb = adj.rows[0].awbNormalized;
      const local = sameBatchTarget(awb);
      if (local) {
        adj.adjustsRowId = local.rowIds[0];
        const sum = adj.rows.reduce<Paise>(
          (acc, r) => acc + (r.invoicedAmount === null ? 0n : rupeesToPaise(r.invoicedAmount)),
          0n,
        );
        local.adjustmentTotal += sum; // RW-24: added to the row's invoiced total
        continue;
      }
      // Earlier batch: the most recent non-ADJUSTMENT row for the AWB.
      const { rows } = await this.pool.query<{
        row_id: string;
        invoiced_amount: string | null;
        expected_amount: string | null;
        prior_adjustments: string | null;
      }>(
        `SELECT r.row_id, r.invoiced_amount, r.expected_amount,
                (SELECT coalesce(sum(a.amount), 0)::text
                   FROM recon_freight_adjustment a WHERE a.row_id = r.row_id) AS prior_adjustments
           FROM recon_freight_row r
           JOIN recon_freight_batch b ON b.batch_id = r.batch_id
          WHERE b.shop_id = $1 AND r.awb_normalized = $2 AND r.charge_type <> 'ADJUSTMENT'
          ORDER BY (r.charge_type = 'FORWARD') DESC, b.uploaded_at DESC, r.created_at DESC
          LIMIT 1`,
        [batch.shop_id, awb],
      );
      const t = rows[0];
      if (t) {
        adj.adjustsRowId = t.row_id;
        crossBatchTargets.set(adj.key, {
          rowId: t.row_id,
          invoicedAmount: t.invoiced_amount,
          expectedAmount: t.expected_amount,
          priorAdjustments: rupeesToPaise(t.prior_adjustments ?? '0'),
        });
      } else {
        crossBatchTargets.set(adj.key, null);
      }
    }

    // Finalize non-ADJUSTMENT groups via the pure §4.8 core.
    for (const group of targetGroups.values()) {
      // Same-type rows are summed before comparison (§4.8); any unparseable
      // amount in the group makes the total unusable → null → flag_review.
      const invoicedTotal = group.rows.some((r) => r.invoicedAmount === null)
        ? null
        : group.rows.reduce<Paise>((acc, r) => acc + rupeesToPaise(r.invoicedAmount!), 0n);
      const weight = group.rows.find((r) => r.invoicedWeightKg !== null)?.invoicedWeightKg ?? null;
      const result = matchGroup({
        awbNormalized: group.rows[0].awbNormalized,
        chargeType: group.chargeType,
        chargeTypeUnmapped: group.chargeTypeUnmapped,
        invoicedAmountTotal: invoicedTotal,
        adjustmentTotal: group.adjustmentTotal,
        shipment: group.shipment,
        freightTolerance: tolerances.freightTolerance,
        weightToleranceGrams: tolerances.weightToleranceGrams,
        tariff: group.shipment?.snapshot?.rateCardVersionId
          ? (tariffs.get(group.shipment.snapshot.rateCardVersionId) ?? null)
          : null,
        invoicedWeightKg: weight,
      });
      group.outcome = result;
    }

    // Finalize ADJUSTMENT groups (§4.8 ADJUSTMENT row, RW-24).
    for (const adj of adjustmentGroups) {
      const awb = adj.rows[0].awbNormalized;
      if (adj.adjustsRowId === null) {
        // No linked row identifiable → no expectation, flag_review (§4.8).
        adj.outcome = {
          flagAwbNotFound: adj.shipment === null,
          flagAmountMismatch: false,
          flagReview: true,
          expectedAmount: null,
          auditedAmount: null,
        };
        continue;
      }
      const local = [...targetGroups.values()].find((g) => g.rowIds[0] === adj.adjustsRowId);
      if (local?.outcome) {
        // Same-batch target: the adjustment inherits the re-compared outcome.
        adj.outcome = { ...local.outcome, flagAwbNotFound: false };
        continue;
      }
      const cross = crossBatchTargets.get(adj.key);
      if (!cross || cross.expectedAmount === null || cross.invoicedAmount === null) {
        adj.outcome = {
          flagAwbNotFound: false,
          flagAmountMismatch: false,
          flagReview: true, // target carried no expectation (§4.8)
          expectedAmount: cross?.expectedAmount ?? null,
          auditedAmount: null,
        };
        continue;
      }
      const sum = adj.rows.reduce<Paise>(
        (acc, r) => acc + (r.invoicedAmount === null ? 0n : rupeesToPaise(r.invoicedAmount)),
        0n,
      );
      const compared =
        rupeesToPaise(cross.invoicedAmount) + cross.priorAdjustments + sum;
      const diff = compared - rupeesToPaise(cross.expectedAmount);
      const abs = diff < 0n ? -diff : diff;
      adj.outcome = {
        flagAwbNotFound: false,
        flagAmountMismatch: abs > tolerances.freightTolerance,
        flagReview: false,
        expectedAmount: cross.expectedAmount,
        auditedAmount: null,
      };
    }

    /* ---------------- one transaction: rows + links + control total ------- */
    let matchedSum: Paise = 0n;
    let reviewSum: Paise = 0n;
    for (const group of groups.values()) {
      const amount = group.rows.reduce<Paise>(
        (acc, r) => acc + (r.invoicedAmount === null ? 0n : rupeesToPaise(r.invoicedAmount)),
        0n,
      );
      if (group.outcome!.flagReview || group.outcome!.flagAwbNotFound) {
        reviewSum += amount;
      } else {
        matchedSum += amount;
      }
    }
    const declared = rupeesToPaise(batch.declared_invoice_total ?? '0');
    const control = controlTotal(declared, matchedSum, reviewSum);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const group of groups.values()) {
        const snapshotBillable = group.shipment?.snapshot?.weights.billableWeightKg ?? null;
        for (let i = 0; i < group.rows.length; i++) {
          const row = group.rows[i];
          const outcome = group.outcome!;
          await client.query(
            `INSERT INTO recon_freight_row
               (row_id, batch_id, awb_normalized, charge_type, invoiced_amount,
                invoiced_weight_kg, shipper_company, invoice_reference, invoice_date,
                shipment_date, origin_station, destination_station, filename, remark,
                flag_awb_not_found, flag_weight_mismatch, flag_amount_mismatch,
                flag_review, workflow_state, expected_amount, audited_amount,
                shipment_id, adjusts_row_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,$11,$12,$13,$14,
                     $15,$16,$17,$18,'OPEN',$19,$20,$21,$22)`,
            [
              group.rowIds[i],
              batch.batch_id,
              row.awbNormalized,
              group.chargeType,
              row.invoicedAmount,
              row.invoicedWeightKg,
              row.shipperCompany,
              row.invoiceReference,
              row.invoiceDate,
              row.shipmentDate,
              row.originStation,
              row.destinationStation,
              null,
              row.remark,
              outcome.flagAwbNotFound,
              // §4.8: weight mismatch is per ROW (weights never sum).
              weightMismatch(row.invoicedWeightKg, snapshotBillable, tolerances.weightToleranceGrams),
              outcome.flagAmountMismatch,
              outcome.flagReview,
              outcome.expectedAmount,
              outcome.auditedAmount,
              group.shipment?.shipmentId ?? null,
              group.chargeType === 'ADJUSTMENT' ? group.adjustsRowId : null,
            ],
          );
        }
        if (group.chargeType === 'ADJUSTMENT' && group.adjustsRowId !== null) {
          // RW-24 / A1-06: append-only link, never an overwrite of the target.
          for (const row of group.rows) {
            await client.query(
              `INSERT INTO recon_freight_adjustment (row_id, adjusting_batch_id, amount, note)
               VALUES ($1, $2, $3, $4)`,
              [
                group.adjustsRowId,
                batch.batch_id,
                row.invoicedAmount ?? '0.00',
                row.remark,
              ],
            );
          }
        }
      }

      // F-14 control total (§3.28) and the MATCHED state, INV-22 checked.
      const { rowCount } = await client.query(
        `UPDATE recon_freight_batch
            SET state = 'MATCHED', residual = $3, control_total_state = $4,
                version = version + 1
          WHERE batch_id = $1 AND version = $2`,
        [batch.batch_id, batch.version, paiseToRupees(control.residual), control.state],
      );
      if (rowCount !== 1) throw new Error(`batch ${batch.batch_id} version conflict`);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    const flaggedRows = [...groups.values()].reduce(
      (n, g) =>
        n +
        (g.outcome!.flagReview ||
        g.outcome!.flagAwbNotFound ||
        g.outcome!.flagAmountMismatch ||
        g.rows.some((r) =>
          weightMismatch(
            r.invoicedWeightKg,
            g.shipment?.snapshot?.weights.billableWeightKg ?? null,
            tolerances.weightToleranceGrams,
          ),
        )
          ? g.rows.length
          : 0),
      0,
    );

    await this.audit.record({
      shopId: batch.shop_id,
      actorKind: 'SYSTEM',
      action: 'recon.freight_batch_processed', // §12
      objectType: 'recon_freight_batch',
      objectId: batch.batch_id,
      before: { state: 'PARSED' },
      after: {
        state: 'MATCHED',
        rows: parsed.length,
        flaggedRows,
        controlTotalState: control.state,
        residual: paiseToRupees(control.residual),
      },
    });

    // §9.21: disputes open or control-total MISMATCH → Finance, immediate.
    // INV-21: notify() never throws into this path.
    if (flaggedRows > 0 || control.state === 'MISMATCH') {
      await this.notifications.notify(
        batch.shop_id,
        NOTIFICATION_EVENTS.RECON_BATCH_DISPUTED,
        {
          subject: `Freight recon batch ${batch.batch_reference} needs review`,
          body:
            control.state === 'MISMATCH'
              ? `Batch ${batch.batch_reference}: control total MISMATCH (residual ${paiseToRupees(control.residual)}), ${flaggedRows} flagged row(s).`
              : `Batch ${batch.batch_reference}: ${flaggedRows} flagged row(s).`,
          link: `/recon/freight/batches/${batch.batch_id}`,
        },
      );
    }
    this.logger.log(
      `freight batch ${batch.batch_id} MATCHED: ${parsed.length} rows, ${flaggedRows} flagged, control ${control.state}`,
    );
  }
}
