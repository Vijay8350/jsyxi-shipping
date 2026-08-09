import { describe, expect, it } from 'vitest';
import { CodExpectationService } from '../../src/modules/recon-cod/cod-expectation.service';
import { CodImportService } from '../../src/modules/recon-cod/cod-import.service';
import { CodSettingsService } from '../../src/modules/recon-cod/cod-settings.service';
import {
  FnPool,
  mockAudit,
  batchRow,
  expectedRow,
  SQL,
  SHOP_ID,
  BATCH_ID,
  BATCH_ID_2,
  EXPECTED_ID,
} from './helpers';

/**
 * §9.17.3 allocation path: idempotent partial remittances accumulate against
 * one expectation; F-13 states recompute after each allocation; INV-20
 * surfaces unmatched AWBs; replays never double-allocate.
 */

function mk(pool: FnPool) {
  const audit = mockAudit();
  const settings = new CodSettingsService(pool.asPool(), audit as never);
  const expectations = new CodExpectationService(pool.asPool(), settings, audit as never);
  const service = new CodImportService(pool.asPool(), expectations, audit as never);
  return { service, audit };
}

const CSV_ONE = 'awb,amount\nDL123456789,600.00\n';

/** Wire the recompute read-path to report a given allocated sum and expected amount. */
function wireRecompute(
  pool: FnPool,
  opts: { allocated: string; expected?: string; dueAt?: string; state?: string },
) {
  pool.on(SQL.recomputeSelect, [
    expectedRow({
      expected_amount: opts.expected ?? '1000.0000',
      due_at: opts.dueAt ?? '2999-01-01', // far future: never past due in these tests
      state: opts.state ?? 'AWAITING',
      allocated: opts.allocated,
      timezone: 'Asia/Kolkata',
    }),
  ]);
  pool.on(SQL.shipmentAccount, [{ courier_account_id: null }]);
  pool.on(SQL.effectiveTolerance, [{ tol: '1.0000' }]);
}

function basePool(batchOverrides: Record<string, unknown> = {}) {
  const pool = new FnPool();
  pool.on(SQL.batchById, [batchRow(batchOverrides)]);
  pool.on(SQL.batchStateUpdate, [], 0);
  pool.on(SQL.batchFinalUpdate, [], 0);
  return pool;
}

describe('processBatch — partial allocations (§15.3 acceptance case)', () => {
  it('two remittance files accumulate against one expectation to TALLIED', async () => {
    // File 1: ₹600 against an expected ₹1,000 → SHORT (₹600 < ₹999 lower bound).
    const pool1 = basePool();
    pool1.on(SQL.expectationForAwb, [{ expected_id: EXPECTED_ID, state: 'AWAITING' }]);
    pool1.on(SQL.insertAllocation, [{ allocation_id: 'a1' }]);
    wireRecompute(pool1, { allocated: '600.0000' });
    const { service: svc1 } = mk(pool1);

    const r1 = await svc1.processBatch({ shopId: SHOP_ID, batchId: BATCH_ID, contentText: CSV_ONE });

    expect(r1).toMatchObject({ state: 'MATCHED', matched: 1, unmatched: 0 });
    const recomputeUpdates1 = pool1.matching(SQL.recomputeUpdate);
    expect(recomputeUpdates1).toHaveLength(1);
    expect(recomputeUpdates1[0].params[1]).toBe('SHORT');

    // File 2: the remaining ₹400 → cumulative ₹1,000 → TALLIED.
    const pool2 = basePool({ cod_batch_id: BATCH_ID_2 });
    pool2.on(SQL.expectationForAwb, [{ expected_id: EXPECTED_ID, state: 'SHORT' }]);
    pool2.on(SQL.insertAllocation, [{ allocation_id: 'a2' }]);
    wireRecompute(pool2, { allocated: '1000.0000', state: 'SHORT' });
    const { service: svc2 } = mk(pool2);

    const r2 = await svc2.processBatch({
      shopId: SHOP_ID,
      batchId: BATCH_ID_2,
      contentText: 'awb,amount\nDL123456789,400.00\n',
    });

    expect(r2).toMatchObject({ state: 'MATCHED', matched: 1 });
    const recomputeUpdates2 = pool2.matching(SQL.recomputeUpdate);
    expect(recomputeUpdates2).toHaveLength(1);
    expect(recomputeUpdates2[0].params[1]).toBe('TALLIED');

    // Allocation rows are append-only, keyed batch + row index + awb.
    const insert1 = pool1.matching(SQL.insertAllocation)[0];
    const insert2 = pool2.matching(SQL.insertAllocation)[0];
    expect(insert1.params[3]).toBe(`cod:${BATCH_ID}:1:DL123456789`);
    expect(insert2.params[3]).toBe(`cod:${BATCH_ID_2}:1:DL123456789`);
  });

  it('F-13 boundary: cumulative ₹998.99 → SHORT, ₹1,001.01 → EXCESS (₹1.00 tolerance)', async () => {
    const poolShort = basePool();
    poolShort.on(SQL.expectationForAwb, [{ expected_id: EXPECTED_ID, state: 'AWAITING' }]);
    poolShort.on(SQL.insertAllocation, [{ allocation_id: 'a1' }]);
    wireRecompute(poolShort, { allocated: '998.9900' });
    const { service: svcShort } = mk(poolShort);
    await svcShort.processBatch({ shopId: SHOP_ID, batchId: BATCH_ID, contentText: CSV_ONE });
    expect(poolShort.matching(SQL.recomputeUpdate)[0].params[1]).toBe('SHORT');

    const poolExcess = basePool();
    poolExcess.on(SQL.expectationForAwb, [{ expected_id: EXPECTED_ID, state: 'AWAITING' }]);
    poolExcess.on(SQL.insertAllocation, [{ allocation_id: 'a2' }]);
    wireRecompute(poolExcess, { allocated: '1001.0100' });
    const { service: svcExcess } = mk(poolExcess);
    await svcExcess.processBatch({ shopId: SHOP_ID, batchId: BATCH_ID, contentText: CSV_ONE });
    expect(poolExcess.matching(SQL.recomputeUpdate)[0].params[1]).toBe('EXCESS');
  });

  it('idempotency-key replay: ON CONFLICT DO NOTHING → no double allocation, no recompute', async () => {
    const pool = basePool();
    pool.on(SQL.expectationForAwb, [{ expected_id: EXPECTED_ID, state: 'AWAITING' }]);
    pool.on(SQL.insertAllocation, [], 0); // key already exists
    const { service } = mk(pool);

    const result = await service.processBatch({ shopId: SHOP_ID, batchId: BATCH_ID, contentText: CSV_ONE });

    expect(result).toMatchObject({ state: 'MATCHED', matched: 0, unmatched: 0 });
    expect(pool.matching(SQL.recomputeSelect)).toHaveLength(0);
  });

  it('replay of an already-processed batch is a SKIPPED no-op', async () => {
    const pool = new FnPool();
    pool.on(SQL.batchById, [batchRow({ state: 'MATCHED' })]);
    const { service } = mk(pool);

    const result = await service.processBatch({ shopId: SHOP_ID, batchId: BATCH_ID, contentText: CSV_ONE });

    expect(result.state).toBe('SKIPPED');
    expect(pool.matching(SQL.insertAllocation)).toHaveLength(0);
  });

  it('INV-20: an AWB with no expectation is surfaced on the batch, never dropped', async () => {
    const pool = basePool();
    pool.on(SQL.expectationForAwb, []); // no expectation for this AWB
    const { service } = mk(pool);

    const result = await service.processBatch({ shopId: SHOP_ID, batchId: BATCH_ID, contentText: CSV_ONE });

    expect(result).toMatchObject({ state: 'MATCHED', matched: 0, unmatched: 1 });
    const final = pool.matching(SQL.batchFinalUpdate)[0];
    expect(final.params[3]).toBe(1); // unmatched_count
    const unmatched = JSON.parse(final.params[4] as string);
    expect(unmatched).toEqual([
      { rowIndex: 1, awb: 'DL123456789', amount: '600.00', reason: 'NO_EXPECTATION' },
    ]);
  });

  it('row-level problems (bad amount, formula content) are surfaced, processing continues', async () => {
    const pool = basePool();
    pool.on(SQL.expectationForAwb, [{ expected_id: EXPECTED_ID, state: 'AWAITING' }]);
    pool.on(SQL.insertAllocation, [{ allocation_id: 'a1' }]);
    wireRecompute(pool, { allocated: '600.0000' });
    const { service } = mk(pool);

    const csv = [
      'awb,amount',
      'DL123456789,600.00', // valid
      'DL999,not-a-number', // INVALID_AMOUNT
      '=HYPERLINK("http://x"),5.00', // FORMULA_CONTENT (§8.7)
    ].join('\n');
    const result = await service.processBatch({ shopId: SHOP_ID, batchId: BATCH_ID, contentText: csv });

    expect(result).toMatchObject({ state: 'MATCHED', matched: 1, unmatched: 2 });
    const unmatched = JSON.parse(pool.matching(SQL.batchFinalUpdate)[0].params[4] as string);
    expect(unmatched.map((u: { reason: string }) => u.reason)).toEqual([
      'INVALID_AMOUNT',
      'FORMULA_CONTENT',
    ]);
  });

  it('F-19 normalization: lowercase / hyphenated / spaced AWBs match the normalized key', async () => {
    const pool = basePool();
    pool.on(SQL.expectationForAwb, [{ expected_id: EXPECTED_ID, state: 'AWAITING' }]);
    pool.on(SQL.insertAllocation, [{ allocation_id: 'a1' }]);
    wireRecompute(pool, { allocated: '600.0000' });
    const { service } = mk(pool);

    await service.processBatch({
      shopId: SHOP_ID,
      batchId: BATCH_ID,
      contentText: 'awb,amount\n dl-1234 56789 ,600.00\n',
    });

    const lookup = pool.matching(SQL.expectationForAwb)[0];
    expect(lookup.params[2]).toBe('DL123456789');
  });

  it('a structural parse failure marks the batch FAILED with no rows (§3.18), audited', async () => {
    const pool = basePool();
    const { service, audit } = mk(pool);

    const result = await service.processBatch({
      shopId: SHOP_ID,
      batchId: BATCH_ID,
      contentText: 'waybill,remitted\nX,1.00\n', // unmapped headers with default map
    });

    expect(result.state).toBe('FAILED');
    expect(pool.matching(SQL.insertAllocation)).toHaveLength(0);
    const failedUpdate = pool.matching(/SET state = 'FAILED'/);
    expect(failedUpdate).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      actorKind: 'SYSTEM',
      action: 'recon_cod.batch.failed',
      before: { state: 'UPLOADED' },
      after: { state: 'FAILED' },
    });
  });

  it('a remittance against an RTO_UNCOLLECTED expectation is recorded but never recomputed (INV-17)', async () => {
    const pool = basePool();
    pool.on(SQL.expectationForAwb, [{ expected_id: EXPECTED_ID, state: 'RTO_UNCOLLECTED' }]);
    pool.on(SQL.insertAllocation, [{ allocation_id: 'a1' }]);
    const { service } = mk(pool);

    const result = await service.processBatch({ shopId: SHOP_ID, batchId: BATCH_ID, contentText: CSV_ONE });

    expect(result.matched).toBe(1); // the money fact is stored
    expect(pool.matching(SQL.recomputeSelect)).toHaveLength(0); // terminal state untouched
  });
});
