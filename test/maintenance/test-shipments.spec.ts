import { describe, expect, it } from 'vitest';
import {
  TEST_SHIPMENT_CARVE_OUT_TABLES,
  TestShipmentsService,
} from '../../src/modules/maintenance/test-shipments.service';
import { RETENTION_BATCH_SIZE } from '../../src/modules/maintenance/retention-horizons';
import {
  asPool,
  EMPTY,
  FakePool,
  mockAudit,
  mockErase,
  MEMBER,
  SHOP,
} from './helpers';

const S1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const S2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeService(pool: FakePool) {
  const erase = mockErase();
  const audit = mockAudit();
  const service = new TestShipmentsService(
    asPool(pool),
    erase as never,
    audit as never,
  );
  return { service, erase, audit };
}

const GUARD_OK = { entitlement_rows: 0, recon_rows: 0, gst_rows: 0 };

function happyPathPool(): FakePool {
  let batchCalls = 0;
  return new FakePool((sql, params) => {
    if (/awb_entitlement_ledger/.test(sql)) return { rows: [GUARD_OK] };
    if (/SELECT shipment_id, awb_normalized FROM shipment/.test(sql)) {
      batchCalls += 1;
      return batchCalls === 1
        ? {
            rows: [
              { shipment_id: S1, awb_normalized: 'AWB1' },
              { shipment_id: S2, awb_normalized: null },
            ],
          }
        : { rows: [] };
    }
    if (/SELECT document_id, object_key FROM document/.test(sql)) {
      return {
        rows: [
          { document_id: 'doc1', object_key: `shops/${SHOP}/labels/test.pdf` },
        ],
      };
    }
    if (/DELETE FROM/.test(sql)) return { rowCount: 1 };
    return EMPTY(sql, params);
  });
}

describe('TestShipmentsService.purgePreview (§9.5.7 step 1)', () => {
  it('reports counts for exactly the §5.3 carve-out table set', async () => {
    const pool = new FakePool(() => ({
      rows: [
        {
          shipment: 3,
          booking_intent: 4,
          tracking_event: 20,
          tracking_event_raw: 25,
          ndr_case: 1,
          ndr_action: 2,
          document: 5,
          rule_evaluation_trace: 6,
          shipment_line: 7,
        },
      ],
    }));
    const { service } = makeService(pool);
    const preview = await service.purgePreview(SHOP);

    // The preview shape IS the carve-out set — no more, no less (§5.3).
    expect(Object.keys(preview).sort()).toEqual(
      [...TEST_SHIPMENT_CARVE_OUT_TABLES].sort(),
    );
    expect(preview).toEqual({
      shipment: 3,
      booking_intent: 4,
      tracking_event: 20,
      tracking_event_raw: 25,
      ndr_case: 1,
      ndr_action: 2,
      document: 5,
      rule_evaluation_trace: 6,
      shipment_line: 7,
    });
    // shop-scoped (INV-1), read-only
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].params).toEqual([SHOP]);
    expect(pool.calls[0].sql).not.toMatch(/DELETE|UPDATE/);
  });
});

describe('TestShipmentsService.purge (§9.5.7 step 2, §5.3 carve-out)', () => {
  it('runs the INV-19 guard query before anything else', async () => {
    const pool = happyPathPool();
    const { service } = makeService(pool);
    await service.purge(SHOP, MEMBER);

    expect(pool.calls[0].sql).toContain('awb_entitlement_ledger');
    expect(pool.calls[0].sql).toContain('recon_cod_expected');
    expect(pool.calls[0].sql).toContain('gst_invoice');
    expect(pool.matching(/DELETE FROM entitlement|DELETE FROM usage_record|DELETE FROM gst_invoice|DELETE FROM recon_/)).toHaveLength(0);
  });

  it('refuses to delete anything when the INV-19 guard finds financial rows', async () => {
    const pool = new FakePool((sql, params) => {
      if (/awb_entitlement_ledger/.test(sql)) {
        return { rows: [{ entitlement_rows: 1, recon_rows: 0, gst_rows: 0 }] };
      }
      return EMPTY(sql, params);
    });
    const { service, erase } = makeService(pool);

    await expect(service.purge(SHOP, MEMBER)).rejects.toThrow(/INV-19/);
    expect(pool.matching(/DELETE FROM/)).toHaveLength(0);
    expect(erase.deleted).toEqual([]);
  });

  it('deletes the batch in one transaction, children before the shipment, and audits per-table counts', async () => {
    const pool = happyPathPool();
    const { service, erase, audit } = makeService(pool);
    const totals = await service.purge(SHOP, MEMBER);

    // bounded batch select, shop-scoped (INV-1)
    const batchSelect = pool.matching(
      /SELECT shipment_id, awb_normalized FROM shipment\s+WHERE shop_id = \$1 AND is_test\s+LIMIT \$2/,
    );
    expect(batchSelect).toHaveLength(2); // loops until no test shipments remain
    expect(batchSelect[0].params).toEqual([SHOP, RETENTION_BATCH_SIZE]);

    // document bytes erased through the seam before the row delete
    expect(erase.deleted).toEqual([`shops/${SHOP}/labels/test.pdf`]);

    // one transaction per batch (§9.5.7)
    const begin = pool.calls.findIndex((c) => c.sql === 'BEGIN');
    const commit = pool.calls.findIndex((c) => c.sql === 'COMMIT');
    expect(begin).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(begin);
    const inTx = pool.calls.slice(begin + 1, commit).map((c) => c.sql);
    const deleteOrder = inTx
      .filter((sql) => /DELETE FROM/.test(sql))
      .map((sql) => /DELETE FROM (\w+)/.exec(sql)![1]);
    // children first, parent last; every carve-out child is deleted
    expect(deleteOrder).toEqual([
      'ndr_buyer_response',
      'ndr_response_token',
      'ndr_action',
      'ndr_case',
      'tracking_event_raw',
      'tracking_event',
      'rule_evaluation_trace',
      'document',
      'booking_intent',
      'shipment_line',
      'shipment',
    ]);
    // the final shipment DELETE re-asserts is_test and shop scope
    const shipmentDelete = inTx.find((sql) => /DELETE FROM shipment\b/.test(sql))!;
    expect(shipmentDelete).toContain('is_test');
    expect(shipmentDelete).toContain('shop_id');

    // §12: one audit row per batch with the per-table counts
    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0] as {
      actorKind: string;
      actorId: string;
      action: string;
      after: Record<string, number>;
    };
    expect(entry.actorKind).toBe('MEMBER');
    expect(entry.actorId).toBe(MEMBER);
    expect(entry.action).toBe('maintenance.test_shipments.bulk_delete');
    for (const table of TEST_SHIPMENT_CARVE_OUT_TABLES) {
      expect(entry.after).toHaveProperty(table);
    }
    expect(entry.after.shipment).toBe(1); // fake pool: 1 per DELETE

    // totals accumulate across batches
    expect(totals.shipment).toBe(1);
    expect(totals.tracking_event_raw).toBe(1);
  });

  it('skips the raw-payload delete when the batch has no AWBs', async () => {
    let batchCalls = 0;
    const pool = new FakePool((sql, params) => {
      if (/awb_entitlement_ledger/.test(sql)) return { rows: [GUARD_OK] };
      if (/SELECT shipment_id, awb_normalized FROM shipment/.test(sql)) {
        batchCalls += 1;
        return batchCalls === 1
          ? { rows: [{ shipment_id: S1, awb_normalized: null }] }
          : { rows: [] };
      }
      if (/DELETE FROM/.test(sql)) return { rowCount: 0 };
      return EMPTY(sql, params);
    });
    const { service } = makeService(pool);
    await service.purge(SHOP, MEMBER);
    expect(pool.matching(/DELETE FROM tracking_event_raw/)).toHaveLength(0);
  });

  it('is a no-op when the shop has no test shipments (guard still runs)', async () => {
    const pool = new FakePool((sql, params) => {
      if (/awb_entitlement_ledger/.test(sql)) return { rows: [GUARD_OK] };
      return EMPTY(sql, params);
    });
    const { service, audit, erase } = makeService(pool);
    const totals = await service.purge(SHOP, MEMBER);

    expect(totals).toEqual({});
    expect(pool.matching(/DELETE FROM/)).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
    expect(erase.deleted).toEqual([]);
  });

  it('refuses to erase a document key outside the shop prefix (INV-1)', async () => {
    let batchCalls = 0;
    const pool = new FakePool((sql, params) => {
      if (/awb_entitlement_ledger/.test(sql)) return { rows: [GUARD_OK] };
      if (/SELECT shipment_id, awb_normalized FROM shipment/.test(sql)) {
        batchCalls += 1;
        return batchCalls === 1
          ? { rows: [{ shipment_id: S1, awb_normalized: 'AWB1' }] }
          : { rows: [] };
      }
      if (/SELECT document_id, object_key FROM document/.test(sql)) {
        return {
          rows: [
            {
              document_id: 'doc1',
              object_key: 'shops/00000000-0000-0000-0000-000000000000/x.pdf',
            },
          ],
        };
      }
      return EMPTY(sql, params);
    });
    const { service, erase } = makeService(pool);

    await expect(service.purge(SHOP, MEMBER)).rejects.toThrow(/shop prefix/);
    expect(erase.deleted).toEqual([]);
    expect(pool.matching(/DELETE FROM/)).toHaveLength(0);
  });
});
