import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { LabelsService } from '../../src/modules/labels/labels.service';
import { LabelTemplateService } from '../../src/modules/labels/label-template.service';
import { DocumentUrlSigner } from '../../src/modules/booking-ops/document-urls';
import {
  COURIER_ACCOUNT_1,
  DOCUMENT_ID,
  FnPool,
  MEMBER_ID,
  memoryStore,
  mockAudit,
  SHIPMENT_A,
  SHOP_ID,
  snapshot,
  templateRow,
} from './helpers';

/**
 * §9.9.1 single label: the CUSTOM_ALLOWED render path and the
 * COURIER_PDF_REQUIRED store-as-is path; §3.11 account-state gating
 * (re-download allowed in RESTRICTED, new generation blocked); document-row
 * fields (§5.4 90-day expiry, INV-19 is_test, sha256 of the exact bytes).
 */

function shipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    shipment_id: SHIPMENT_A,
    order_id: '22222222-2222-2222-2222-222222222221',
    booking_state: 'CONFIRMED',
    awb_normalized: 'AWB123456789',
    service_id: '66666666-6666-6666-6666-6666666666a1',
    courier_account_id: COURIER_ACCOUNT_1,
    is_test: true,
    snapshot: snapshot(),
    ...overrides,
  };
}

function env() {
  const pool = new FnPool();
  const audit = mockAudit();
  const { store, objects } = memoryStore();
  const signer = new DocumentUrlSigner({ get: () => 'test-secret' } as never);
  const adapters = { call: vi.fn() };
  const templates = new LabelTemplateService(pool.asPool(), audit as never);
  const service = new LabelsService(
    pool.asPool(),
    templates,
    adapters as never,
    store,
    signer,
    audit as never,
  );
  return { pool, audit, store, objects, adapters, service };
}

/** The handlers every successful generation needs around the branch. */
function happyPath(pool: FnPool, labelMode: string) {
  pool.on(/SELECT document_id FROM document/, []); // no existing label
  pool.on(/SELECT account_state FROM shop/, [{ account_state: 'ACTIVE' }]);
  pool.on(/FROM shipment\s+WHERE shop_id/, [shipmentRow()]);
  pool.on(/SELECT label_mode FROM service/, [{ label_mode: labelMode }]);
  pool.on(/FROM label_template WHERE shop_id/, [templateRow()]);
  pool.on(/FROM "order"/, [{ shopify_order_number: '1001' }]);
  pool.on(/SELECT is_test FROM document/, [{ is_test: true }]);
  pool.on(/JOIN service s ON/, [{ label_mode: labelMode }]);
}

describe('CUSTOM_ALLOWED — custom render from the frozen snapshot (INV-8)', () => {
  it('stores the PDF and writes the document row (90-day expiry, is_test, sha256)', async () => {
    const { pool, audit, objects, service } = env();
    happyPath(pool, 'CUSTOM_ALLOWED');

    const result = await service.generateShipmentLabel({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_A,
      actorId: MEMBER_ID,
    });

    expect(result.reused).toBe(false);
    expect(result.labelMode).toBe('CUSTOM_ALLOWED');
    expect(result.isTest).toBe(true);
    expect(result.downloadUrl).toContain(`/documents/${result.documentId}/download?`);

    // INV-1: the object path is shop-scoped.
    const key = `shops/${SHOP_ID}/labels/${SHIPMENT_A}/${result.documentId}.pdf`;
    const bytes = objects.get(key)!;
    expect(bytes).toBeDefined();
    expect(bytes.toString('latin1').startsWith('%PDF-1.4')).toBe(true);
    // The §9.23 TEST marker is in the label (shipment is_test = true).
    expect(bytes.toString('latin1')).toContain('(TEST SHIPMENT)');

    const insert = pool.matching(/INSERT INTO document\s/)[0];
    expect(insert.params[1]).toBe(SHOP_ID);
    expect(insert.params[2]).toBe(SHIPMENT_A);
    expect(insert.params[3]).toBe(key);
    // sha256 over the exact stored bytes.
    expect(insert.params[4]).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(insert.params[5]).toBe(bytes.length);
    expect(insert.params[6]).toBe(90); // §5.4 retention
    expect(insert.params[7]).toBe(true); // INV-19: is_test inherited

    // §12: document export audited — ids only (§5.7 control 4).
    const entry = audit.entries.find((e) => e.action === 'LABEL_GENERATED')!;
    expect(entry.objectId).toBe(result.documentId);
    expect(JSON.stringify(entry.after)).not.toContain('Asha');
  });

  it('renders at the print-time size override (S-23, Operator+)', async () => {
    const { pool, objects, service } = env();
    happyPath(pool, 'CUSTOM_ALLOWED');
    const result = await service.generateShipmentLabel({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_A,
      actorId: MEMBER_ID,
      sizeOverride: 'A4_1UP',
    });
    const bytes = objects.get(`shops/${SHOP_ID}/labels/${SHIPMENT_A}/${result.documentId}.pdf`)!;
    expect(bytes.toString('latin1')).toContain('/MediaBox [0 0 595 842]');
  });
});

describe('COURIER_PDF_REQUIRED — the courier PDF is stored untouched', () => {
  it('stores getLabel bytes as-is', async () => {
    const { pool, objects, adapters, service } = env();
    happyPath(pool, 'COURIER_PDF_REQUIRED');
    const courierBytes = Buffer.from('%PDF-1.7 courier-original-bytes \x00\x01\x02', 'latin1');
    adapters.call.mockResolvedValue({ contentType: 'application/pdf', bytes: courierBytes });

    const result = await service.generateShipmentLabel({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_A,
      actorId: MEMBER_ID,
    });

    expect(adapters.call).toHaveBeenCalledWith(SHOP_ID, COURIER_ACCOUNT_1, 'getLabel', expect.any(Function));
    const stored = objects.get(`shops/${SHOP_ID}/labels/${SHIPMENT_A}/${result.documentId}.pdf`)!;
    expect(stored.equals(courierBytes)).toBe(true);
    const insert = pool.matching(/INSERT INTO document\s/)[0];
    expect(insert.params[4]).toBe(createHash('sha256').update(courierBytes).digest('hex'));
    expect(insert.params[5]).toBe(courierBytes.length);
  });
});

describe('§3.11 account-state gating', () => {
  it('RESTRICTED blocks NEW generation', async () => {
    const { pool, service } = env();
    pool.on(/SELECT document_id FROM document/, []);
    pool.on(/SELECT account_state FROM shop/, [{ account_state: 'RESTRICTED' }]);

    await expect(
      service.generateShipmentLabel({ shopId: SHOP_ID, shipmentId: SHIPMENT_A, actorId: MEMBER_ID }),
    ).rejects.toMatchObject({ response: { statusCode: 403 } });
    expect(pool.matching(/INSERT INTO document\s/)).toHaveLength(0);
    expect(pool.matching(/FROM shipment\s+WHERE/)).toHaveLength(0);
  });

  it('RESTRICTED still allows re-download of an existing label', async () => {
    const { pool, service } = env();
    pool.on(/SELECT document_id FROM document/, [{ document_id: DOCUMENT_ID }]);
    pool.on(/SELECT is_test FROM document/, [{ is_test: false }]);
    pool.on(/JOIN service s ON/, [{ label_mode: 'CUSTOM_ALLOWED' }]);

    const result = await service.generateShipmentLabel({
      shopId: SHOP_ID,
      shipmentId: SHIPMENT_A,
      actorId: MEMBER_ID,
    });
    expect(result.reused).toBe(true);
    expect(result.documentId).toBe(DOCUMENT_ID);
    expect(result.downloadUrl).toContain(`/documents/${DOCUMENT_ID}/download?`);
    // The account-state gate is never reached on the re-download path.
    expect(pool.matching(/SELECT account_state FROM shop/)).toHaveLength(0);
  });
});

describe('shipment guards', () => {
  it('requires CONFIRMED', async () => {
    const { pool, service } = env();
    pool.on(/SELECT document_id FROM document/, []);
    pool.on(/SELECT account_state FROM shop/, [{ account_state: 'ACTIVE' }]);
    pool.on(/FROM shipment\s+WHERE shop_id/, [shipmentRow({ booking_state: 'DRAFT' })]);
    await expect(
      service.generateShipmentLabel({ shopId: SHOP_ID, shipmentId: SHIPMENT_A, actorId: MEMBER_ID }),
    ).rejects.toMatchObject({ response: { statusCode: 409 } });
  });

  it('requires the frozen snapshot (INV-8)', async () => {
    const { pool, service } = env();
    pool.on(/SELECT document_id FROM document/, []);
    pool.on(/SELECT account_state FROM shop/, [{ account_state: 'ACTIVE' }]);
    pool.on(/FROM shipment\s+WHERE shop_id/, [shipmentRow({ snapshot: null })]);
    await expect(
      service.generateShipmentLabel({ shopId: SHOP_ID, shipmentId: SHIPMENT_A, actorId: MEMBER_ID }),
    ).rejects.toMatchObject({ response: { statusCode: 422 } });
  });

  it("another Shop's shipment reads as 404 (INV-1)", async () => {
    const { pool, service } = env();
    pool.on(/SELECT document_id FROM document/, []);
    pool.on(/SELECT account_state FROM shop/, [{ account_state: 'ACTIVE' }]);
    pool.on(/FROM shipment\s+WHERE shop_id/, []);
    await expect(
      service.generateShipmentLabel({ shopId: SHOP_ID, shipmentId: SHIPMENT_A, actorId: MEMBER_ID }),
    ).rejects.toMatchObject({ response: { statusCode: 404, message: 'shipment not found' } });
  });
});
