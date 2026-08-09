import { describe, expect, it } from 'vitest';
import { ReconImportService, UploadBatchInput } from '../../src/modules/recon-freight/recon-import.service';
import { ReconFreightQueue } from '../../src/modules/recon-freight/recon-queue';
import { AuditService } from '../../src/audit/audit.service';
import { LocalFilesystemObjectStore } from '../../src/modules/booking-ops/object-store';
import {
  ACCOUNT_ID,
  BATCH_ID,
  COURIER_ID,
  FnPool,
  MAP_ID,
  MEMBER_ID,
  SHOP_ID,
  fakeAudit,
  fakeQueue,
  fakeStore,
} from './helpers';

/**
 * §9.17.1 import: §8.7 quarantine + declared metadata, INV-14 idempotent
 * re-upload, §3.18 FAILED re-upload allowed, §13.5 batch reference.
 */

const CSV = Buffer.from('AWB,Amount\nDL1,10.00\n', 'utf8');

function input(overrides: Partial<UploadBatchInput> = {}): UploadBatchInput {
  return {
    shopId: SHOP_ID,
    memberId: MEMBER_ID,
    filename: 'invoice.csv',
    csvBytes: CSV,
    courierAccountId: ACCOUNT_ID,
    columnMapId: MAP_ID,
    declaredInvoiceTotal: '10.00',
    taxTreatment: 'TAX_INCLUSIVE',
    invoiceReference: 'INV-2026-09',
    invoiceDate: '2026-07-31',
    ...overrides,
  };
}

function harness(pool: FnPool) {
  const store = fakeStore(() => 'sig');
  const queue = fakeQueue();
  const audit = fakeAudit();
  const service = new ReconImportService(
    pool.asPool(),
    store as unknown as LocalFilesystemObjectStore,
    queue as unknown as ReconFreightQueue,
    audit as unknown as AuditService,
  );
  return { service, store, queue, audit };
}

/** Pool stubs for the happy path up to the hash lookup. */
function basePool(): FnPool {
  const pool = new FnPool();
  pool
    .on(/SELECT iana_timezone FROM shop/, [{ iana_timezone: 'Asia/Kolkata' }])
    .on(/FROM courier_account/, [{ courier_id: COURIER_ID }])
    .on(/FROM import_column_map/, [{ courier_id: COURIER_ID, kind: 'FREIGHT' }]);
  return pool;
}

describe('§8.7 / §5.1 quarantine', () => {
  it('rejects an empty file', async () => {
    const { service } = harness(new FnPool());
    const result = await service.upload(input({ csvBytes: Buffer.alloc(0) }));
    expect(result).toEqual({ ok: false, code: 'EMPTY_FILE' });
  });

  it('rejects files over 50 MB (§5.1)', async () => {
    const { service } = harness(new FnPool());
    const big = Buffer.alloc(50 * 1024 * 1024 + 1, 0x61);
    const result = await service.upload(input({ csvBytes: big }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FILE_TOO_LARGE');
  });

  it('rejects files over 250,000 rows (§5.1)', async () => {
    const { service } = harness(new FnPool());
    const many = Buffer.from(`AWB,Amount\n${'DL1,1.00\n'.repeat(250_001)}`);
    const result = await service.upload(input({ csvBytes: many }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TOO_MANY_ROWS');
  });

  it('rejects archives / binary content (§8.7)', async () => {
    const { service } = harness(new FnPool());
    const zip = Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), CSV]);
    const result = await service.upload(input({ csvBytes: zip }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ARCHIVE_OR_BINARY');
  });

  it('rejects a future-dated invoice (§5.2)', async () => {
    const { service } = harness(basePool());
    const result = await service.upload(input({ invoiceDate: '2999-01-01' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FUTURE_INVOICE_DATE');
  });

  it('requires the §8.7 declarations (account, map, tax treatment, reference)', async () => {
    const { service } = harness(basePool());
    for (const patch of [
      { declaredInvoiceTotal: 'abc' },
      { taxTreatment: 'MAYBE' as never },
      { invoiceReference: '  ' },
    ]) {
      const result = await service.upload(input(patch));
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a column map of the wrong kind or courier', async () => {
    const pool = new FnPool();
    pool
      .on(/SELECT iana_timezone FROM shop/, [{ iana_timezone: 'Asia/Kolkata' }])
      .on(/FROM courier_account/, [{ courier_id: COURIER_ID }])
      .on(/FROM import_column_map/, [{ courier_id: COURIER_ID, kind: 'COD' }]);
    const { service } = harness(pool);
    const result = await service.upload(input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('COLUMN_MAP_KIND');
  });
});

describe('INV-14 import idempotency', () => {
  it('same content hash for the shop → no-op returning the existing batch', async () => {
    const pool = basePool();
    pool.on(/FROM recon_freight_batch\s+WHERE shop_id/, [
      { batch_id: BATCH_ID, state: 'MATCHED', batch_reference: 'FREIGHT-20260731-1', version: 3 },
    ]);
    const { service, store, queue } = harness(pool);
    const result = await service.upload(input());
    expect(result).toEqual({
      ok: true,
      batchId: BATCH_ID,
      batchReference: 'FREIGHT-20260731-1',
      reused: true,
      reprocessing: false,
    });
    expect(store.put).not.toHaveBeenCalled();
    expect(queue.enqueueProcessBatch).not.toHaveBeenCalled();
    expect(pool.matching(/INSERT INTO recon_freight_batch/)).toHaveLength(0);
  });

  it('a FAILED batch is not idempotency-blocking: it is revived and reprocessed (§3.18)', async () => {
    const pool = basePool();
    pool
      .on(/FROM recon_freight_batch\s+WHERE shop_id/, [
        { batch_id: BATCH_ID, state: 'FAILED', batch_reference: 'FREIGHT-20260731-1', version: 2 },
      ])
      .on(/UPDATE recon_freight_batch\s+SET state = 'UPLOADED'/, [
        { batch_id: BATCH_ID, state: 'UPLOADED', batch_reference: 'FREIGHT-20260731-1', version: 3 },
      ]);
    const { service, queue, audit } = harness(pool);
    const result = await service.upload(input());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.batchId).toBe(BATCH_ID);
      expect(result.reused).toBe(false);
      expect(result.reprocessing).toBe(true);
    }
    expect(queue.enqueueProcessBatch).toHaveBeenCalledWith(BATCH_ID);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'recon.freight_batch_reuploaded' }),
    );
  });

  it('a new file inserts UPLOADED with a §13.5 reference, stores content-addressed, enqueues', async () => {
    const pool = basePool();
    pool
      .on(/count\(\*\)::text AS n FROM recon_freight_batch/, [{ n: '2' }])
      .on(/INSERT INTO recon_freight_batch/, [
        { batch_id: BATCH_ID, state: 'UPLOADED', batch_reference: 'FREIGHT-20260731-3', version: 1 },
      ]);
    const { service, store, queue, audit } = harness(pool);
    const result = await service.upload(input());
    expect(result).toEqual({
      ok: true,
      batchId: BATCH_ID,
      batchReference: 'FREIGHT-20260731-3', // §13.5 seq = prior count + 1
      reused: false,
      reprocessing: false,
    });
    // INV-1 shop-scoped, content-addressed object path.
    const [key] = store.put.mock.calls[0];
    expect(key).toMatch(new RegExp(`^shops/${SHOP_ID}/recon/imports/[0-9a-f]{64}$`));
    expect(queue.enqueueProcessBatch).toHaveBeenCalledWith(BATCH_ID);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'recon.freight_batch_uploaded' }),
    );
    // The declared total is stored rupee-denominated (§4.1).
    const insert = pool.matching(/INSERT INTO recon_freight_batch/)[0];
    expect(insert.params).toContain('10.00');
  });

  it('a concurrent insert race degrades to the INV-14 no-op', async () => {
    const pool = basePool();
    let lookups = 0;
    pool
      .on(/count\(\*\)::text AS n FROM recon_freight_batch/, [{ n: '0' }])
      .on(/INSERT INTO recon_freight_batch/, [], 0) // ON CONFLICT DO NOTHING
      .onFn(/FROM recon_freight_batch\s+WHERE shop_id/, () => {
        lookups += 1;
        // First lookup (pre-insert): nothing; post-conflict lookup: the row.
        return lookups === 1
          ? { rows: [], rowCount: 0 }
          : {
              rows: [
                { batch_id: BATCH_ID, state: 'UPLOADED', batch_reference: 'FREIGHT-20260731-1', version: 1 },
              ],
              rowCount: 1,
            };
      });
    const { service } = harness(pool);
    const result = await service.upload(input());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reused).toBe(true);
  });
});
