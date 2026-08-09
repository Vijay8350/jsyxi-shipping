import { describe, expect, it } from 'vitest';
import { ReconWorkflowService } from '../../src/modules/recon-freight/recon-workflow.service';
import { AuditService } from '../../src/audit/audit.service';
import { ReconWorkflowState } from '../../src/modules/recon-freight/recon-freight.types';
import { BATCH_ID, FnPool, MEMBER_ID, ROW_ID, SHOP_ID, fakeAudit } from './helpers';

/**
 * §9.17.2 row workflow (§3.14 transitions), the §3.28 residual acceptance,
 * ADD-42 evidence attach, and the §3.18 batch RESOLVED gate. Every write is
 * INV-22 optimistic-concurrency checked and audited with before/after (§12).
 */

function row(state: ReconWorkflowState, version = 1) {
  return {
    row_id: ROW_ID,
    batch_id: BATCH_ID,
    workflow_state: state,
    remark: null,
    dispute_evidence_object_key: null,
    version,
    shop_id: SHOP_ID,
  };
}

function harness(pool: FnPool) {
  const audit = fakeAudit();
  const service = new ReconWorkflowService(pool.asPool(), audit as unknown as AuditService);
  return { service, audit };
}

function actPool(from: ReconWorkflowState, resolveRowCount = 0) {
  const pool = new FnPool();
  pool
    .on(/FROM recon_freight_row r\s+JOIN recon_freight_batch/, [row(from)])
    .on(/UPDATE recon_freight_row\s+SET workflow_state/, [], 1)
    .on(/UPDATE recon_freight_batch b\s+SET state = 'RESOLVED'/, [], resolveRowCount);
  return pool;
}

describe('§3.14 row transitions (§9.17.2, Finance+)', () => {
  it('accept: OPEN → ACCEPTED, audited with before/after', async () => {
    const pool = actPool('OPEN');
    const { service, audit } = harness(pool);
    const result = await service.act({
      shopId: SHOP_ID, rowId: ROW_ID, action: 'accept', expectedVersion: 1, actorMemberId: MEMBER_ID,
    });
    expect(result).toMatchObject({ ok: true, workflowState: 'ACCEPTED' });
    const update = pool.matching(/UPDATE recon_freight_row/)[0];
    expect(update.params[0]).toBe(ROW_ID);
    expect(update.params[1]).toBe(1); // INV-22
    expect(update.params[2]).toBe('ACCEPTED');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'recon.row_accept',
        before: expect.objectContaining({ workflowState: 'OPEN' }),
        after: expect.objectContaining({ workflowState: 'ACCEPTED' }),
      }),
    );
  });

  it('dispute: OPEN → DISPUTE_PREPARED requires the remark', async () => {
    const { service } = harness(actPool('OPEN'));
    const noRemark = await service.act({
      shopId: SHOP_ID, rowId: ROW_ID, action: 'dispute', expectedVersion: 1, actorMemberId: MEMBER_ID,
    });
    expect(noRemark).toEqual({ ok: false, code: 'REMARK_REQUIRED' });
    const pool = actPool('OPEN');
    const withRemark = await harness(pool).service.act({
      shopId: SHOP_ID, rowId: ROW_ID, action: 'dispute', remark: 'reweigh 1.5kg vs booked 1.0kg',
      expectedVersion: 1, actorMemberId: MEMBER_ID,
    });
    expect(withRemark).toMatchObject({ ok: true, workflowState: 'DISPUTE_PREPARED' });
  });

  it('submit: DISPUTE_PREPARED → SUBMITTED; resolve: SUBMITTED → RESOLVED; ignore: OPEN → IGNORED', async () => {
    for (const [from, action, to] of [
      ['DISPUTE_PREPARED', 'submit', 'SUBMITTED'],
      ['SUBMITTED', 'resolve', 'RESOLVED'],
      ['DISPUTE_PREPARED', 'resolve', 'RESOLVED'],
      ['OPEN', 'ignore', 'IGNORED'],
    ] as const) {
      const { service } = harness(actPool(from));
      const result = await service.act({
        shopId: SHOP_ID, rowId: ROW_ID, action, expectedVersion: 1, actorMemberId: MEMBER_ID,
      });
      expect(result).toMatchObject({ ok: true, workflowState: to });
    }
  });

  it('a transition not in the table does not exist (terminal rows are stuck)', async () => {
    for (const from of ['ACCEPTED', 'RESOLVED', 'IGNORED'] as const) {
      const { service } = harness(actPool(from));
      const result = await service.act({
        shopId: SHOP_ID, rowId: ROW_ID, action: 'accept', expectedVersion: 1, actorMemberId: MEMBER_ID,
      });
      expect(result).toMatchObject({ ok: false, code: 'INVALID_TRANSITION', currentState: from });
    }
    // OPEN → SUBMITTED is not a listed transition either.
    const { service } = harness(actPool('OPEN'));
    const skipped = await service.act({
      shopId: SHOP_ID, rowId: ROW_ID, action: 'submit', expectedVersion: 1, actorMemberId: MEMBER_ID,
    });
    expect(skipped).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
  });

  it('a version mismatch rejects and returns the current state (INV-22)', async () => {
    const pool = new FnPool();
    pool
      .on(/FROM recon_freight_row r\s+JOIN recon_freight_batch/, [row('OPEN', 7)])
      .on(/UPDATE recon_freight_row\s+SET workflow_state/, [], 0);
    const { service } = harness(pool);
    const result = await service.act({
      shopId: SHOP_ID, rowId: ROW_ID, action: 'accept', expectedVersion: 1, actorMemberId: MEMBER_ID,
    });
    expect(result).toEqual({ ok: false, code: 'VERSION_CONFLICT', currentState: 'OPEN', currentVersion: 7 });
  });

  it('shop scoping: a row of another Shop is not found (INV-1)', async () => {
    const pool = new FnPool();
    pool.on(/FROM recon_freight_row r\s+JOIN recon_freight_batch/, []);
    const { service } = harness(pool);
    const result = await service.act({
      shopId: SHOP_ID, rowId: ROW_ID, action: 'accept', expectedVersion: 1, actorMemberId: MEMBER_ID,
    });
    expect(result).toEqual({ ok: false, code: 'ROW_NOT_FOUND' });
  });
});

describe('§3.18 batch RESOLVED gate', () => {
  it('the last terminal row resolves the batch when control total is not MISMATCH', async () => {
    const pool = actPool('OPEN', 1); // gate UPDATE matched a row
    const { service } = harness(pool);
    const result = await service.act({
      shopId: SHOP_ID, rowId: ROW_ID, action: 'accept', expectedVersion: 1, actorMemberId: MEMBER_ID,
    });
    expect(result).toMatchObject({ ok: true, batchResolved: true });
    const gate = pool.matching(/SET state = 'RESOLVED'/)[0];
    expect(gate.sql).toContain("control_total_state <> 'MISMATCH'"); // §3.28 gate
    expect(gate.sql).toContain('NOT EXISTS'); // every row terminal
  });

  it('rows remaining open keep the batch MATCHED', async () => {
    const { service } = harness(actPool('OPEN', 0));
    const result = await service.act({
      shopId: SHOP_ID, rowId: ROW_ID, action: 'accept', expectedVersion: 1, actorMemberId: MEMBER_ID,
    });
    expect(result).toMatchObject({ ok: true, batchResolved: false });
  });
});

describe('§3.28 residual acceptance (Finance+)', () => {
  function batchPool(controlState: string, updateRowCount = 1) {
    const pool = new FnPool();
    pool
      .on(/FROM recon_freight_batch\s+WHERE batch_id/, [
        { control_total_state: controlState, state: 'MATCHED', version: 2 },
      ])
      .on(/SET control_total_state = 'ACCEPTED_WITH_REMARK'/, [], updateRowCount)
      .on(/UPDATE recon_freight_batch b\s+SET state = 'RESOLVED'/, [], 0);
    return pool;
  }

  it('a MISMATCH batch is accepted with a remark → ACCEPTED_WITH_REMARK, audited', async () => {
    const pool = batchPool('MISMATCH');
    const { service, audit } = harness(pool);
    const result = await service.acceptResidual({
      shopId: SHOP_ID, batchId: BATCH_ID, remark: 'courier credit note expected',
      expectedVersion: 2, actorMemberId: MEMBER_ID,
    });
    expect(result).toMatchObject({ ok: true, controlTotalState: 'ACCEPTED_WITH_REMARK' });
    const update = pool.matching(/ACCEPTED_WITH_REMARK/)[0];
    expect(update.params[2]).toBe('courier credit note expected');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'recon.residual_accepted',
        before: expect.objectContaining({ controlTotalState: 'MISMATCH' }),
      }),
    );
  });

  it('the remark is mandatory (the DB CHECK backs it)', async () => {
    const { service } = harness(batchPool('MISMATCH'));
    const result = await service.acceptResidual({
      shopId: SHOP_ID, batchId: BATCH_ID, remark: '   ', expectedVersion: 2, actorMemberId: MEMBER_ID,
    });
    expect(result).toEqual({ ok: false, code: 'REMARK_REQUIRED' });
  });

  it('ACCEPTED_WITH_REMARK is terminal (§3.28)', async () => {
    const { service } = harness(batchPool('ACCEPTED_WITH_REMARK'));
    const result = await service.acceptResidual({
      shopId: SHOP_ID, batchId: BATCH_ID, remark: 'again', expectedVersion: 2, actorMemberId: MEMBER_ID,
    });
    expect(result).toMatchObject({ ok: false, code: 'INVALID_STATE' });
  });
});

describe('ADD-42 dispute evidence', () => {
  it('attaches the reweigh image object key and audits it', async () => {
    const pool = new FnPool();
    pool
      .on(/FROM recon_freight_row r\s+JOIN recon_freight_batch/, [row('DISPUTE_PREPARED')])
      .on(/SET dispute_evidence_object_key/, [], 1);
    const { service, audit } = harness(pool);
    const key = `shops/${SHOP_ID}/reweigh/img-1.png`;
    const result = await service.attachEvidence({
      shopId: SHOP_ID, rowId: ROW_ID, objectKey: key, expectedVersion: 1, actorMemberId: MEMBER_ID,
    });
    expect(result.ok).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'recon.row_evidence_attached',
        after: { disputeEvidenceObjectKey: key },
      }),
    );
  });

  it('refuses keys outside the Shop prefix (INV-1)', async () => {
    const pool = new FnPool();
    pool.on(/FROM recon_freight_row r\s+JOIN recon_freight_batch/, [row('OPEN')]);
    const { service } = harness(pool);
    const result = await service.attachEvidence({
      shopId: SHOP_ID, rowId: ROW_ID, objectKey: 'shops/other-shop/x.png',
      expectedVersion: 1, actorMemberId: MEMBER_ID,
    });
    expect(result.ok).toBe(false);
    expect(pool.matching(/SET dispute_evidence_object_key/)).toHaveLength(0);
  });
});
