import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { BulkLabelsService } from '../../src/modules/labels/bulk-labels.service';
import { LabelTemplateService } from '../../src/modules/labels/label-template.service';
import { DocumentUrlSigner } from '../../src/modules/booking-ops/document-urls';
import { BULK_LABEL_MAX_SHIPMENTS } from '../../src/modules/labels/labels.types';
import {
  COURIER_ACCOUNT_1,
  DOCUMENT_ID,
  FnPool,
  JOB_ID,
  MEMBER_ID,
  memoryStore,
  mockAudit,
  SERVICE_ALPHA,
  SERVICE_MID,
  SERVICE_ZETA,
  SHIPMENT_A,
  SHIPMENT_B,
  SHIPMENT_C,
  SHIPMENT_D,
  SHIPMENT_E,
  SHOP_ID,
  snapshot,
  templateRow,
} from './helpers';

/**
 * §9.9.1 bulk merged label PDF + ADD-36 reprint: ≤1,000 validation (§5.1),
 * sorted by Service only (A4-02), PARTIAL with a skipped report (§3.27,
 * INV-20), and the BULK_LABEL document row fields.
 */

function env() {
  const pool = new FnPool();
  const audit = mockAudit();
  const { store, objects } = memoryStore();
  const signer = new DocumentUrlSigner({ get: () => 'test-secret' } as never);
  const adapters = { call: vi.fn() };
  const queue = { enqueueLabelJob: vi.fn().mockResolvedValue(undefined) };
  const templates = new LabelTemplateService(pool.asPool(), audit as never);
  const service = new BulkLabelsService(
    pool.asPool(),
    templates,
    adapters as never,
    store,
    signer,
    audit as never,
    queue as never,
  );
  return { pool, audit, objects, adapters, queue, service };
}

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    job_id: JOB_ID,
    state: 'QUEUED',
    progress: { total: 0, processed: 0, rendered: 0, skipped: 0 },
    filters: { shipmentIds: [SHIPMENT_B, SHIPMENT_A, SHIPMENT_C, SHIPMENT_D, SHIPMENT_E] },
    result_document_id: null,
    skipped_report: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function bulkShipment(overrides: Record<string, unknown>) {
  return {
    order_id: '22222222-2222-2222-2222-222222222221',
    booking_state: 'CONFIRMED',
    awb_normalized: 'AWB000000001',
    courier_account_id: COURIER_ACCOUNT_1,
    is_test: false,
    snapshot: snapshot(),
    label_mode: 'CUSTOM_ALLOWED',
    ...overrides,
  };
}

/** A–E: B and A render (different services, requested out of order), C is
 *  DRAFT, D does not exist, E is a COURIER_PDF_REQUIRED service whose fetch
 *  fails. The label shows the SNAPSHOT's service name (INV-8), so A's frozen
 *  snapshot carries Zeta Surface. */
function zetaSnapshot() {
  const base = snapshot();
  return {
    ...base,
    service: { ...base.service, serviceId: SERVICE_ZETA, code: 'ZS', name: 'Zeta Surface' },
  };
}

function seedProcessing(pool: FnPool) {
  pool.on(/FROM document_job/, [jobRow()]);
  pool.on(/FROM shipment sh/, [
    bulkShipment({
      shipment_id: SHIPMENT_A,
      service_id: SERVICE_ZETA,
      service_name: 'Zeta Surface',
      snapshot: zetaSnapshot(),
    }),
    bulkShipment({ shipment_id: SHIPMENT_B, service_id: SERVICE_ALPHA, service_name: 'Alpha Express' }),
    bulkShipment({
      shipment_id: SHIPMENT_C,
      service_id: SERVICE_ALPHA,
      service_name: 'Alpha Express',
      booking_state: 'DRAFT',
      snapshot: null,
    }),
    bulkShipment({
      shipment_id: SHIPMENT_E,
      service_id: SERVICE_MID,
      service_name: 'Mid Cargo',
      label_mode: 'COURIER_PDF_REQUIRED',
    }),
  ]);
  pool.on(/FROM label_template WHERE shop_id/, [templateRow()]);
  pool.on(/FROM "order"/, [
    { order_id: '22222222-2222-2222-2222-222222222221', shopify_order_number: '1001' },
  ]);
}

describe('createBulkJob — validation and enqueue', () => {
  it('rejects an empty selection and more than 1,000 shipments (§5.1)', async () => {
    const { service } = env();
    await expect(
      service.createBulkJob({ shopId: SHOP_ID, actorId: MEMBER_ID, shipmentIds: [], bulkKind: 'BULK' }),
    ).rejects.toMatchObject({ response: { statusCode: 422 } });
    const tooMany = Array.from({ length: BULK_LABEL_MAX_SHIPMENTS + 1 }, (_, i) => `s-${i}`);
    await expect(
      service.createBulkJob({ shopId: SHOP_ID, actorId: MEMBER_ID, shipmentIds: tooMany, bulkKind: 'BULK' }),
    ).rejects.toMatchObject({ response: { statusCode: 422 } });
  });

  it('RESTRICTED blocks new bulk generation (§3.11)', async () => {
    const { pool, service } = env();
    pool.on(/SELECT account_state FROM shop/, [{ account_state: 'RESTRICTED' }]);
    await expect(
      service.createBulkJob({ shopId: SHOP_ID, actorId: MEMBER_ID, shipmentIds: [SHIPMENT_A], bulkKind: 'BULK' }),
    ).rejects.toMatchObject({ response: { statusCode: 403 } });
    expect(pool.matching(/INSERT INTO document_job/)).toHaveLength(0);
  });

  it('creates the BULK_LABEL job and enqueues on the label queue', async () => {
    const { pool, audit, queue, service } = env();
    pool.on(/SELECT account_state FROM shop/, [{ account_state: 'ACTIVE' }]);

    const result = await service.createBulkJob({
      shopId: SHOP_ID,
      actorId: MEMBER_ID,
      shipmentIds: [SHIPMENT_A, SHIPMENT_B, SHIPMENT_A], // duplicates collapse
      bulkKind: 'BULK',
    });

    expect(result.state).toBe('QUEUED');
    expect(result.total).toBe(2);
    const insert = pool.matching(/INSERT INTO document_job/)[0];
    expect(insert.params[0]).toBe(result.jobId);
    expect(insert.params[1]).toBe(SHOP_ID);
    expect(insert.params[2]).toBe(MEMBER_ID);
    expect(JSON.parse(insert.params[3] as string)).toEqual({
      shipmentIds: [SHIPMENT_A, SHIPMENT_B],
      reprint: false,
    });
    expect(queue.enqueueLabelJob).toHaveBeenCalledWith({ shopId: SHOP_ID, jobId: result.jobId });
    expect(audit.entries.some((e) => e.action === 'BULK_LABEL_JOB_CREATED')).toBe(true);
  });

  it('ADD-36 reprint creates the same job shape flagged as a reprint', async () => {
    const { pool, audit, service } = env();
    pool.on(/SELECT account_state FROM shop/, [{ account_state: 'ACTIVE' }]);
    await service.createBulkJob({
      shopId: SHOP_ID,
      actorId: MEMBER_ID,
      shipmentIds: [SHIPMENT_A],
      bulkKind: 'REPRINT',
    });
    const insert = pool.matching(/INSERT INTO document_job/)[0];
    expect(JSON.parse(insert.params[3] as string).reprint).toBe(true);
    expect(audit.entries.some((e) => e.action === 'BULK_LABEL_REPRINT_CREATED')).toBe(true);
  });
});

describe('processBulkJob — sorted by Service only, PARTIAL with skipped report', () => {
  it('renders sorted pages, skips are reported, job ends PARTIAL (§3.27)', async () => {
    const { pool, audit, objects, adapters, service } = env();
    seedProcessing(pool);
    adapters.call.mockRejectedValue(new Error('courier 500'));

    await service.processBulkJob({ shopId: SHOP_ID, jobId: JOB_ID });

    // The merged document exists, one page per rendered shipment.
    const key = `shops/${SHOP_ID}/labels/bulk/${JOB_ID}.pdf`;
    const bytes = objects.get(key)!;
    const text = bytes.toString('latin1');
    expect(text).toContain('/Count 2');
    // A4-02: sorted by Service only — Alpha Express before Zeta Surface,
    // regardless of request order.
    expect(text.indexOf('Service: Alpha Express')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Service: Alpha Express')).toBeLessThan(text.indexOf('Service: Zeta Surface'));

    // Final job update: PARTIAL, result document, skipped report (INV-20).
    const updates = pool.matching(/UPDATE document_job/);
    const finalUpdate = updates[updates.length - 1];
    expect(finalUpdate.params[2]).toBe('PARTIAL');
    const progress = JSON.parse(finalUpdate.params[3] as string);
    expect(progress).toEqual({ total: 5, processed: 4, rendered: 2, skipped: 3 });
    const documentId = finalUpdate.params[4] as string;
    expect(documentId).toBeTruthy();
    const skipped = JSON.parse(finalUpdate.params[5] as string) as Array<{
      shipmentId: string;
      reason: string;
    }>;
    expect(skipped).toHaveLength(3);
    const byShipment = new Map(skipped.map((s) => [s.shipmentId, s.reason]));
    expect(byShipment.get(SHIPMENT_D)).toBe('SHIPMENT_NOT_FOUND');
    expect(byShipment.get(SHIPMENT_C)).toBe('NOT_CONFIRMED');
    expect(byShipment.get(SHIPMENT_E)).toBe('COURIER_PDF_FETCH_FAILED');

    // The BULK_LABEL document row: 90-day expiry, sha256 of the exact bytes,
    // is_test false because not every page is a test shipment.
    const insert = pool.matching(/INSERT INTO document\s/)[0];
    expect(insert.params[0]).toBe(documentId);
    expect(insert.params[2]).toBe(key);
    expect(insert.params[3]).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(insert.params[4]).toBe(bytes.length);
    expect(insert.params[5]).toBe(90);
    expect(insert.params[6]).toBe(false);
    expect(insert.sql).toContain("'BULK_LABEL'");

    expect(
      audit.entries.some(
        (e) => e.action === 'BULK_LABEL_JOB_COMPLETED' && e.actorKind === 'SYSTEM',
      ),
    ).toBe(true);
  });

  it('a courier PDF that fetches cleanly is still reported, never silently dropped (INV-20)', async () => {
    const { pool, adapters, service } = env();
    pool.on(/FROM document_job/, [jobRow({ filters: { shipmentIds: [SHIPMENT_E] } })]);
    pool.on(/FROM shipment sh/, [
      bulkShipment({
        shipment_id: SHIPMENT_E,
        service_id: SERVICE_MID,
        service_name: 'Mid Cargo',
        label_mode: 'COURIER_PDF_REQUIRED',
      }),
    ]);
    pool.on(/FROM label_template WHERE shop_id/, [templateRow()]);
    pool.on(/FROM "order"/, []);
    adapters.call.mockResolvedValue({
      contentType: 'application/pdf',
      bytes: Buffer.from('%PDF-1.7 x', 'latin1'),
    });

    await service.processBulkJob({ shopId: SHOP_ID, jobId: JOB_ID });
    const updates = pool.matching(/UPDATE document_job/);
    const finalUpdate = updates[updates.length - 1];
    expect(finalUpdate.params[2]).toBe('PARTIAL');
    const skipped = JSON.parse(finalUpdate.params[5] as string);
    expect(skipped).toEqual([{ shipmentId: SHIPMENT_E, reason: 'COURIER_PDF_NOT_MERGEABLE' }]);
  });

  it('a fully-renderable job ends SUCCEEDED with an empty skipped report', async () => {
    const { pool, service } = env();
    pool.on(/FROM document_job/, [jobRow({ filters: { shipmentIds: [SHIPMENT_B] } })]);
    pool.on(/FROM shipment sh/, [
      bulkShipment({ shipment_id: SHIPMENT_B, service_id: SERVICE_ALPHA, service_name: 'Alpha Express' }),
    ]);
    pool.on(/FROM label_template WHERE shop_id/, [templateRow()]);
    pool.on(/FROM "order"/, []);

    await service.processBulkJob({ shopId: SHOP_ID, jobId: JOB_ID });
    const updates = pool.matching(/UPDATE document_job/);
    const finalUpdate = updates[updates.length - 1];
    expect(finalUpdate.params[2]).toBe('SUCCEEDED');
    expect(JSON.parse(finalUpdate.params[5] as string)).toEqual([]);
  });

  it('a terminal job is a no-op (worker-retry idempotency)', async () => {
    const { pool, service } = env();
    pool.on(/FROM document_job/, [jobRow({ state: 'PARTIAL' })]);
    await service.processBulkJob({ shopId: SHOP_ID, jobId: JOB_ID });
    expect(pool.matching(/UPDATE document_job/)).toHaveLength(0);
    expect(pool.matching(/INSERT INTO document\s/)).toHaveLength(0);
  });
});

describe('getJob — progress, result and skipped report (INV-1 shop-scoped)', () => {
  it('returns the signed download URL once a result exists', async () => {
    const { pool, service } = env();
    pool.on(/FROM document_job/, [
      jobRow({
        state: 'PARTIAL',
        result_document_id: DOCUMENT_ID,
        skipped_report: [{ shipmentId: SHIPMENT_D, reason: 'SHIPMENT_NOT_FOUND' }],
        progress: { total: 2, processed: 2, rendered: 1, skipped: 1 },
      }),
    ]);
    const view = await service.getJob(SHOP_ID, JOB_ID);
    expect(view.state).toBe('PARTIAL');
    expect(view.progress.rendered).toBe(1);
    expect(view.skippedReport).toHaveLength(1);
    expect(view.result!.documentId).toBe(DOCUMENT_ID);
    expect(view.result!.downloadUrl).toContain(`/documents/${DOCUMENT_ID}/download?`);
    expect(pool.matching(/FROM document_job/)[0].params).toEqual([SHOP_ID, JOB_ID]);
  });

  it("another Shop's job reads as 404 (INV-1)", async () => {
    const { pool, service } = env();
    pool.on(/FROM document_job/, []);
    await expect(service.getJob(SHOP_ID, JOB_ID)).rejects.toMatchObject({
      response: { statusCode: 404 },
    });
  });
});
