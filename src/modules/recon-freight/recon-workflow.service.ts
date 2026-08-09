import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import {
  OPEN_DISPUTE_STATES,
  ROW_TRANSITIONS,
  ReconRowAction,
  ReconWorkflowState,
  ResidualAcceptanceResult,
  RowActionResult,
  TERMINAL_WORKFLOW_STATES,
} from './recon-freight.types';

/**
 * §9.17.2 workflow actions on freight recon rows (Finance+ — the controller
 * declares 'recon.edit'; residual acceptance is 'recon.residual.accept').
 * Every transition is a single optimistic-concurrency-checked UPDATE
 * (INV-22) against the §3.14 transition table (ROW_TRANSITIONS), audited
 * with before/after (§12). The §10.4 trigger allows only workflow_state and
 * remark writes here — imported values and flags are immutable.
 *
 * ADD-42: dispute evidence (the courier's reweigh image object key) attaches
 * to the row; the dispute export references it.
 *
 * §3.18: after every transition the batch is re-evaluated — it reaches
 * RESOLVED only when every row is terminal AND control_total_state ≠
 * MISMATCH.
 */

interface RowRecord {
  row_id: string;
  batch_id: string;
  workflow_state: ReconWorkflowState;
  remark: string | null;
  dispute_evidence_object_key: string | null;
  version: number;
}

@Injectable()
export class ReconWorkflowService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  private async loadRow(
    shopId: string,
    rowId: string,
  ): Promise<(RowRecord & { shop_id: string }) | null> {
    const { rows } = await this.pool.query<RowRecord & { shop_id: string }>(
      `SELECT r.row_id, r.batch_id, r.workflow_state::text AS workflow_state,
              r.remark, r.dispute_evidence_object_key, r.version, b.shop_id
         FROM recon_freight_row r
         JOIN recon_freight_batch b ON b.batch_id = r.batch_id
        WHERE r.row_id = $1 AND b.shop_id = $2`,
      [rowId, shopId],
    );
    return rows[0] ?? null;
  }

  /** §3.18 batch gate; returns true when this call moved batch → RESOLVED. */
  private async maybeResolveBatch(batchId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE recon_freight_batch b
          SET state = 'RESOLVED', version = version + 1
        WHERE b.batch_id = $1
          AND b.state = 'MATCHED'
          AND b.control_total_state <> 'MISMATCH'   -- §3.28/§3.18
          AND NOT EXISTS (
            SELECT 1 FROM recon_freight_row r
             WHERE r.batch_id = b.batch_id
               AND r.workflow_state <> ALL ($2::recon_workflow_state[])
          )`,
      [batchId, TERMINAL_WORKFLOW_STATES],
    );
    return rowCount === 1;
  }

  /** §9.17.2 row actions: accept · dispute remark · submit · resolve · ignore. */
  async act(input: {
    shopId: string;
    rowId: string;
    action: ReconRowAction;
    remark?: string;
    expectedVersion: number;
    actorMemberId: string;
  }): Promise<RowActionResult> {
    const transition = ROW_TRANSITIONS[input.action];
    const row = await this.loadRow(input.shopId, input.rowId);
    if (!row) return { ok: false, code: 'ROW_NOT_FOUND' };
    if (!transition.from.includes(row.workflow_state)) {
      return {
        ok: false,
        code: 'INVALID_TRANSITION',
        currentState: row.workflow_state,
        currentVersion: row.version,
      };
    }
    if (transition.remarkRequired && (input.remark ?? '').trim() === '') {
      return { ok: false, code: 'REMARK_REQUIRED' };
    }

    const { rowCount } = await this.pool.query(
      `UPDATE recon_freight_row
          SET workflow_state = $3,
              remark = COALESCE($4, remark),
              version = version + 1
        WHERE row_id = $1 AND version = $2 AND workflow_state = $5`,
      [
        input.rowId,
        input.expectedVersion,
        transition.to,
        input.remark ?? null,
        row.workflow_state,
      ],
    );
    if (rowCount !== 1) {
      // INV-22: reject with the current state for refresh-and-reapply.
      const current = await this.loadRow(input.shopId, input.rowId);
      return {
        ok: false,
        code: 'VERSION_CONFLICT',
        currentState: current?.workflow_state,
        currentVersion: current?.version,
      };
    }

    const batchResolved = await this.maybeResolveBatch(row.batch_id);
    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'MEMBER',
      actorId: input.actorMemberId,
      action: `recon.row_${input.action}`, // §12
      objectType: 'recon_freight_row',
      objectId: input.rowId,
      before: { workflowState: row.workflow_state, remark: row.remark, version: row.version },
      after: {
        workflowState: transition.to,
        remark: input.remark ?? row.remark,
        batchResolved,
      },
    });
    return { ok: true, rowId: input.rowId, workflowState: transition.to, batchResolved };
  }

  /** ADD-42: attach the courier's reweigh image/scan (object key) to a row. */
  async attachEvidence(input: {
    shopId: string;
    rowId: string;
    objectKey: string;
    expectedVersion: number;
    actorMemberId: string;
  }): Promise<RowActionResult> {
    const row = await this.loadRow(input.shopId, input.rowId);
    if (!row) return { ok: false, code: 'ROW_NOT_FOUND' };
    // INV-1: the key must live under the Shop's own object prefix.
    if (
      !input.objectKey.startsWith(`shops/${input.shopId}/`) ||
      input.objectKey.includes('..')
    ) {
      return { ok: false, code: 'INVALID_TRANSITION' };
    }
    const { rowCount } = await this.pool.query(
      `UPDATE recon_freight_row
          SET dispute_evidence_object_key = $3, version = version + 1
        WHERE row_id = $1 AND version = $2`,
      [input.rowId, input.expectedVersion, input.objectKey],
    );
    if (rowCount !== 1) {
      const current = await this.loadRow(input.shopId, input.rowId);
      return {
        ok: false,
        code: 'VERSION_CONFLICT',
        currentState: current?.workflow_state,
        currentVersion: current?.version,
      };
    }
    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'MEMBER',
      actorId: input.actorMemberId,
      action: 'recon.row_evidence_attached', // §12, ADD-42
      objectType: 'recon_freight_row',
      objectId: input.rowId,
      before: { disputeEvidenceObjectKey: row.dispute_evidence_object_key },
      after: { disputeEvidenceObjectKey: input.objectKey },
    });
    return { ok: true, rowId: input.rowId, workflowState: row.workflow_state, batchResolved: false };
  }

  /**
   * §3.28: Finance+ accepts the control-total residual with a remark →
   * ACCEPTED_WITH_REMARK (terminal; the DB CHECK backs the non-empty
   * remark). Audited.
   */
  async acceptResidual(input: {
    shopId: string;
    batchId: string;
    remark: string;
    expectedVersion: number;
    actorMemberId: string;
  }): Promise<ResidualAcceptanceResult> {
    if (input.remark.trim() === '') {
      return { ok: false, code: 'REMARK_REQUIRED' };
    }
    const { rows } = await this.pool.query<{
      control_total_state: 'WITHIN_THRESHOLD' | 'MISMATCH' | 'ACCEPTED_WITH_REMARK';
      state: string;
      version: number;
    }>(
      `SELECT control_total_state::text, state::text, version
         FROM recon_freight_batch
        WHERE batch_id = $1 AND shop_id = $2`,
      [input.batchId, input.shopId],
    );
    const batch = rows[0];
    if (!batch) return { ok: false, code: 'BATCH_NOT_FOUND' };
    // ACCEPTED_WITH_REMARK is terminal (§3.28); FAILED holds nothing.
    if (batch.control_total_state === 'ACCEPTED_WITH_REMARK' || batch.state !== 'MATCHED') {
      return {
        ok: false,
        code: 'INVALID_STATE',
        currentControlTotalState: batch.control_total_state,
        currentVersion: batch.version,
      };
    }
    const { rowCount } = await this.pool.query(
      `UPDATE recon_freight_batch
          SET control_total_state = 'ACCEPTED_WITH_REMARK',
              residual_remark = $3,
              version = version + 1
        WHERE batch_id = $1 AND version = $2
          AND control_total_state <> 'ACCEPTED_WITH_REMARK'`,
      [input.batchId, input.expectedVersion, input.remark],
    );
    if (rowCount !== 1) {
      return {
        ok: false,
        code: 'VERSION_CONFLICT',
        currentControlTotalState: batch.control_total_state,
        currentVersion: batch.version,
      };
    }
    const batchResolved = await this.maybeResolveBatch(input.batchId);
    await this.audit.record({
      shopId: input.shopId,
      actorKind: 'MEMBER',
      actorId: input.actorMemberId,
      action: 'recon.residual_accepted', // §12, §3.28
      objectType: 'recon_freight_batch',
      objectId: input.batchId,
      before: { controlTotalState: batch.control_total_state, version: batch.version },
      after: {
        controlTotalState: 'ACCEPTED_WITH_REMARK',
        residualRemark: input.remark,
        batchResolved,
      },
    });
    return {
      ok: true,
      batchId: input.batchId,
      controlTotalState: 'ACCEPTED_WITH_REMARK',
      batchResolved,
    };
  }

  /** Count of open-dispute rows in one batch (§3.14 counting rule). */
  async openDisputeRowCount(batchId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM recon_freight_row
        WHERE batch_id = $1 AND workflow_state = ANY ($2::recon_workflow_state[])`,
      [batchId, OPEN_DISPUTE_STATES],
    );
    return Number(rows[0]?.n ?? '0');
  }
}
