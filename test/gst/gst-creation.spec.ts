import { describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { GstInvoiceService } from '../../src/modules/gst/gst-invoice.service';
import {
  FnPool,
  GSTIN,
  INVOICE_ID,
  invoiceRow,
  mockAudit,
  SHIPMENT_ID,
  SHOP_ID,
  shipmentRow,
  snapshot,
} from './helpers';

function makeService(pool: FnPool, audit = mockAudit()) {
  return {
    pool,
    audit,
    service: new GstInvoiceService(pool.asPool(), audit as unknown as AuditService),
  };
}

/** Registers the common attemptIssue happy-path handlers (complete data). */
function onIssueableInvoice(pool: FnPool, row = invoiceRow()) {
  pool.on(/SELECT \* FROM gst_invoice[\s\S]*FOR UPDATE/, [row]);
  pool.on(/SELECT \* FROM gst_invoice_line/, [
    {
      invoice_line_id: 'il1',
      invoice_id: INVOICE_ID,
      order_line_id: 'l1',
      hsn_code: '6109',
      quantity: 2,
      taxable_value: '1000.00',
      tax_components: [{ type: 'IGST', rate: '0.180000', amount: '180.00' }],
      line_total: '1180.00',
    },
  ]);
  pool.on(/COALESCE\(ss\.timezone/, [{ timezone: 'Asia/Kolkata' }]);
  pool.on(/INSERT INTO invoice_number_sequence/, [{ next_number: 1 }]);
  pool.on(/UPDATE gst_invoice\s+SET state = 'ISSUED'/, [], 1);
}

describe('onShipmentConfirmed (§9.9.2)', () => {
  it('INV-19: a test shipment is a hard no-op — no invoice writes', async () => {
    const pool = new FnPool();
    pool.on(/FROM shipment/, [shipmentRow({ is_test: true })]);
    const { service } = makeService(pool);

    await service.onShipmentConfirmed(SHOP_ID, SHIPMENT_ID);

    expect(pool.matching(/INSERT INTO gst_invoice/)).toHaveLength(0);
    expect(pool.matching(/invoice_number_sequence/)).toHaveLength(0);
  });

  it('no-ops for a shipment that is not CONFIRMED', async () => {
    const pool = new FnPool();
    pool.on(/FROM shipment/, [shipmentRow({ booking_state: 'SUBMITTED' })]);
    const { service } = makeService(pool);

    await service.onShipmentConfirmed(SHOP_ID, SHIPMENT_ID);

    expect(pool.matching(/INSERT INTO gst_invoice/)).toHaveLength(0);
  });

  it('creates ISSUE_PENDING at first booking and issues when data is complete', async () => {
    const pool = new FnPool();
    pool.on(/FROM shipment/, [shipmentRow()]);
    pool.on(/INSERT INTO gst_invoice\s/, [{ invoice_id: INVOICE_ID }]);
    onIssueableInvoice(pool);
    const { service, audit } = makeService(pool);

    await service.onShipmentConfirmed(SHOP_ID, SHIPMENT_ID);

    const insert = pool.matching(/INSERT INTO gst_invoice\s/)[0];
    expect(insert.sql).toContain('ON CONFLICT (shop_id, order_id) DO NOTHING');
    // Complete fixture → no missing fields.
    expect(JSON.parse(insert.params[5] as string)).toEqual([]);
    // Auto-issued: exactly one atomic allocation (INV-13).
    expect(pool.matching(/INSERT INTO invoice_number_sequence/)).toHaveLength(1);
    const actions = audit.entries.map((e) => e.action);
    expect(actions).toContain('gst_invoice.created');
    expect(actions).toContain('gst_invoice.issued');
  });

  it('creates the invoice exactly once across sibling confirmations', async () => {
    const pool = new FnPool();
    pool.on(/FROM shipment/, [shipmentRow()]);
    // First call inserts; the sibling's insert conflicts and returns nothing.
    let inserts = 0;
    pool.onFn(/INSERT INTO gst_invoice\s/, () => {
      inserts += 1;
      return inserts === 1
        ? { rows: [{ invoice_id: INVOICE_ID }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    });
    pool.on(/SELECT invoice_id FROM gst_invoice/, [{ invoice_id: INVOICE_ID }]);
    onIssueableInvoice(pool, invoiceRow({ state: 'ISSUED' }));
    const { service } = makeService(pool);

    await service.onShipmentConfirmed(SHOP_ID, SHIPMENT_ID);
    await service.onShipmentConfirmed(SHOP_ID, SHIPMENT_ID); // sibling

    expect(inserts).toBe(2); // attempted, second absorbed by ON CONFLICT
    expect(pool.matching(/SELECT invoice_id FROM gst_invoice/)).toHaveLength(1);
    // The already-ISSUED sibling re-drive allocates no second number.
    expect(pool.matching(/INSERT INTO invoice_number_sequence/)).toHaveLength(0);
  });

  it('splits IGST for inter-state supply and CGST+SGST for intra-state', async () => {
    // Inter-state: Gujarat seller → Karnataka buyer (the default fixture).
    const inter = new FnPool();
    inter.on(/FROM shipment/, [shipmentRow()]);
    inter.on(/INSERT INTO gst_invoice\s/, [{ invoice_id: INVOICE_ID }]);
    inter.on(/FOR UPDATE/, [invoiceRow({ state: 'ISSUED' })]); // skip issue path
    const { service: interService } = makeService(inter);
    await interService.onShipmentConfirmed(SHOP_ID, SHIPMENT_ID);

    const interLine = inter.matching(/INSERT INTO gst_invoice_line/)[0];
    expect(JSON.parse(interLine.params[5] as string)).toEqual([
      { type: 'IGST', rate: '0.180000', amount: '180.00' },
    ]);
    expect(interLine.params[4]).toBe('1000.00'); // 2 × ₹500.00 (INV-15)
    expect(interLine.params[6]).toBe('1180.00');

    // Intra-state: buyer in Gujarat too.
    const intra = new FnPool();
    intra.on(/FROM shipment/, [
      shipmentRow({ snapshot: snapshot({ recipient: { ...snapshot().recipient!, state: 'Gujarat' } }) }),
    ]);
    intra.on(/INSERT INTO gst_invoice\s/, [{ invoice_id: INVOICE_ID }]);
    intra.on(/FOR UPDATE/, [invoiceRow({ state: 'ISSUED' })]);
    const { service: intraService } = makeService(intra);
    await intraService.onShipmentConfirmed(SHOP_ID, SHIPMENT_ID);

    const intraLine = intra.matching(/INSERT INTO gst_invoice_line/)[0];
    expect(JSON.parse(intraLine.params[5] as string)).toEqual([
      { type: 'CGST', rate: '0.090000', amount: '90.00' },
      { type: 'SGST', rate: '0.090000', amount: '90.00' },
    ]);
    expect(intraLine.params[6]).toBe('1180.00');
  });

  it('lists a stable code for each absent required input (§9.9.2)', async () => {
    const pool = new FnPool();
    pool.on(/FROM shipment/, [
      shipmentRow({
        snapshot: snapshot({
          pickupLocation: {
            ...snapshot().pickupLocation!,
            name: null,
            gstin: null,
            addressLines: [],
            pincode: null,
          },
          recipient: {
            ...snapshot().recipient!,
            name: null,
            addressLines: [],
            state: null,
            pincode: null,
          },
          lines: [
            { ...snapshot().lines[0], hsnCode: null, unitPrice: null },
          ],
        }),
      }),
    ]);
    pool.on(/INSERT INTO gst_invoice\s/, [{ invoice_id: INVOICE_ID }]);
    pool.on(/FOR UPDATE/, [invoiceRow({ missing_fields: [{ code: 'SELLER_GSTIN' }] })]);
    const { service } = makeService(pool);

    await service.onShipmentConfirmed(SHOP_ID, SHIPMENT_ID);

    const insert = pool.matching(/INSERT INTO gst_invoice\s/)[0];
    const missing = JSON.parse(insert.params[5] as string) as Array<{
      code: string;
      orderLineId?: string;
    }>;
    expect(missing.map((m) => m.code)).toEqual([
      'SELLER_GSTIN',
      'SELLER_LEGAL_NAME',
      'SELLER_ADDRESS',
      'BUYER_NAME',
      'BUYER_ADDRESS',
      'BUYER_PINCODE',
      'PLACE_OF_SUPPLY',
      'LINE_HSN',
      'LINE_TAXABLE_VALUE',
    ]);
    expect(missing.find((m) => m.code === 'LINE_HSN')?.orderLineId).toBe('l1');
    // Incomplete data → no number allocated (§3.12, INV-13).
    expect(pool.matching(/invoice_number_sequence/)).toHaveLength(0);
  });

  it('snapshots the seller GSTIN from the frozen pickup location (§2.9)', async () => {
    const pool = new FnPool();
    pool.on(/FROM shipment/, [shipmentRow()]);
    pool.on(/INSERT INTO gst_invoice\s/, [{ invoice_id: INVOICE_ID }]);
    pool.on(/FOR UPDATE/, [invoiceRow({ state: 'ISSUED' })]);
    const { service } = makeService(pool);

    await service.onShipmentConfirmed(SHOP_ID, SHIPMENT_ID);

    const insert = pool.matching(/INSERT INTO gst_invoice\s/)[0];
    const seller = JSON.parse(insert.params[2] as string) as { gstin: string };
    expect(seller.gstin).toBe(GSTIN);
  });
});
