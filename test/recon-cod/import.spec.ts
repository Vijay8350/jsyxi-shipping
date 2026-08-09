import { describe, expect, it } from 'vitest';
import { UnprocessableEntityException } from '@nestjs/common';
import { CodExpectationService } from '../../src/modules/recon-cod/cod-expectation.service';
import { CodImportService } from '../../src/modules/recon-cod/cod-import.service';
import { CodSettingsService } from '../../src/modules/recon-cod/cod-settings.service';
import {
  FnPool,
  mockAudit,
  batchRow,
  SQL,
  SHOP_ID,
  MEMBER_ID,
  BATCH_ID,
  COURIER_ACCOUNT_ID,
} from './helpers';

/**
 * §9.17.1 upload path: §8.7 validation, §13.5 batch reference, INV-14
 * content-hash no-op and the §3.18 FAILED re-upload allowance.
 */

function mk(pool: FnPool) {
  const audit = mockAudit();
  const settings = new CodSettingsService(pool.asPool(), audit as never);
  const expectations = new CodExpectationService(pool.asPool(), settings, audit as never);
  const service = new CodImportService(pool.asPool(), expectations, audit as never);
  return { service, audit };
}

function uploadInput(overrides: Record<string, unknown> = {}) {
  return {
    shopId: SHOP_ID,
    actorMemberId: MEMBER_ID,
    filename: 'remittance.csv',
    contentBase64: Buffer.from('awb,amount\nDL123456789,600.00\n').toString('base64'),
    courierAccountId: COURIER_ACCOUNT_ID,
    ...overrides,
  };
}

function uploadPool(existing: unknown[] = []) {
  const pool = new FnPool();
  pool.on(SQL.storeTimezone, [{ timezone: 'Asia/Kolkata' }]);
  pool.on(SQL.batchByHash, existing);
  return pool;
}

describe('uploadBatch', () => {
  it('creates an UPLOADED batch with a §13.5 COD-{yyyymmdd}-{seq} reference, audited', async () => {
    const pool = uploadPool();
    pool.on(SQL.insertBatch, [batchRow()]);
    const { service, audit } = mk(pool);

    const result = await service.uploadBatch(uploadInput());

    expect(result).toMatchObject({ idempotent: false, reuploaded: false });
    const insert = pool.matching(SQL.insertBatch)[0];
    expect(insert.sql).toContain(`'COD-' ||`);
    expect(result.batch.batch_reference).toMatch(/^COD-\d{8}-\d{4}$/);
    expect(insert.params[0]).toBe(SHOP_ID);
    expect(insert.params[1]).toBe(COURIER_ACCOUNT_ID);
    expect(audit.entries[0]).toMatchObject({
      actorKind: 'MEMBER',
      actorId: MEMBER_ID,
      action: 'recon_cod.batch.upload',
    });
  });

  it('INV-14: same content hash on a live batch is a no-op — no insert, no audit', async () => {
    const pool = uploadPool([batchRow({ state: 'MATCHED' })]);
    const { service, audit } = mk(pool);

    const result = await service.uploadBatch(uploadInput());

    expect(result).toMatchObject({ idempotent: true, reuploaded: false });
    expect(result.batch.cod_batch_id).toBe(BATCH_ID);
    expect(pool.matching(SQL.insertBatch)).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it('§3.18: a FAILED batch is not idempotency-blocking — the same hash resets to UPLOADED', async () => {
    const pool = uploadPool([batchRow({ state: 'FAILED' })]);
    pool.on(SQL.resetBatch, [batchRow({ state: 'UPLOADED', version: 2 })]);
    const { service, audit } = mk(pool);

    const result = await service.uploadBatch(uploadInput());

    expect(result).toMatchObject({ idempotent: false, reuploaded: true });
    expect(pool.matching(SQL.insertBatch)).toHaveLength(0);
    expect(pool.matching(SQL.resetBatch)).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      action: 'recon_cod.batch.reupload',
      before: { state: 'FAILED' },
      after: { state: 'UPLOADED' },
    });
  });

  it('§5.1/§8.7: files over 50 MB are rejected at upload', async () => {
    const pool = uploadPool();
    const { service } = mk(pool);
    const big = Buffer.alloc(50 * 1024 * 1024 + 1, 0x41).toString('base64');

    await expect(service.uploadBatch(uploadInput({ contentBase64: big }))).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(pool.matching(SQL.insertBatch)).toHaveLength(0);
  });

  it('§5.2: a future-dated remittance_date is rejected shop-locally', async () => {
    const pool = uploadPool();
    const { service } = mk(pool);

    await expect(
      service.uploadBatch(uploadInput({ remittanceDate: '2999-01-01' })),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('an unknown column map is rejected (§9.17.1)', async () => {
    const pool = uploadPool();
    pool.on(SQL.columnMap, []);
    const { service } = mk(pool);

    await expect(
      service.uploadBatch(uploadInput({ columnMapId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' })),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('a COD column map supplies the header mapping', async () => {
    const pool = uploadPool();
    pool.on(SQL.columnMap, [{ mappings_json: { awb: 'Waybill', amount: 'Remitted Amt' } }]);
    pool.on(SQL.insertBatch, [batchRow({ column_map_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' })]);
    const { service } = mk(pool);

    const result = await service.uploadBatch(
      uploadInput({ columnMapId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' }),
    );
    expect(result.idempotent).toBe(false);
    expect(pool.matching(SQL.insertBatch)).toHaveLength(1);
  });
});
