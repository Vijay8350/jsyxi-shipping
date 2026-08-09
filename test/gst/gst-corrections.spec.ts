import { describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { hasPermission } from '../../src/modules/team/rbac/permissions';
import { GstInvoiceService } from '../../src/modules/gst/gst-invoice.service';
import {
  FnPool,
  INVOICE_ID,
  invoiceRow,
  lineRow,
  MEMBER_ID,
  mockAudit,
  SHOP_ID,
} from './helpers';

const CREDIT_NOTE_ID = '55555555-5555-5555-5555-555555555555';

function makeService(pool: FnPool, audit = mockAudit()) {
  return {
    pool,
    audit,
    service: new GstInvoiceService(pool.asPool(), audit as unknown as AuditService),
  };
}

describe('voidInvoice (§3.12, INV-16)', () => {
  it('requires a mandatory reason', async () => {
    const pool = new FnPool();
    const { service } = makeService(pool);
    await expect(
      service.voidInvoice(SHOP_ID, INVOICE_ID, MEMBER_ID, '  '),
    ).rejects.toThrow('a void reason is mandatory');
    expect(pool.calls).toHaveLength(0); // rejected before any SQL
  });

  it('is Finance+ only in the §10.2 matrix (gst_invoice.issue)', () => {
    expect(hasPermission('OWNER', 'gst_invoice.issue')).toBe(true);
    expect(hasPermission('FINANCE', 'gst_invoice.issue')).toBe(true);
    expect(hasPermission('OPERATOR', 'gst_invoice.issue')).toBe(false);
    expect(hasPermission('VIEWER', 'gst_invoice.issue')).toBe(false);
  });

  it('transitions ISSUED → VOID, keeps the number (gap retained), audited', async () => {
    const pool = new FnPool();
    pool.on(/FOR UPDATE/, [
      invoiceRow({ state: 'ISSUED', invoice_number: 'INV/2026-27/000001', financial_year: '2026-27' }),
    ]);
    pool.on(/SET state = 'VOID'/, [], 1);
    pool.on(/SELECT \* FROM gst_invoice\s+WHERE/, [
      invoiceRow({ state: 'VOID', invoice_number: 'INV/2026-27/000001' }),
    ]);
    pool.on(/SELECT \* FROM gst_invoice_line/, [lineRow()]);
    const { service, audit } = makeService(pool);

    const result = await service.voidInvoice(SHOP_ID, INVOICE_ID, MEMBER_ID, 'buyer cancelled');

    expect(result.state).toBe('VOID');
    const update = pool.matching(/SET state = 'VOID'/)[0];
    expect(update.sql).toContain(`AND state = 'ISSUED'`);
    expect(update.params[0]).toBe(SHOP_ID);
    const entry = audit.entries.find((e) => e.action === 'gst_invoice.voided');
    expect(entry).toMatchObject({
      actorKind: 'MEMBER',
      actorId: MEMBER_ID,
      reason: 'buyer cancelled',
      before: { state: 'ISSUED', invoiceNumber: 'INV/2026-27/000001' },
      after: { state: 'VOID' },
    });
  });

  it('VOID is terminal — a second void is rejected', async () => {
    const pool = new FnPool();
    pool.on(/FOR UPDATE/, [invoiceRow({ state: 'VOID' })]);
    const { service } = makeService(pool);

    await expect(
      service.voidInvoice(SHOP_ID, INVOICE_ID, MEMBER_ID, 'again'),
    ).rejects.toThrow('only ISSUED can be voided');
    expect(pool.matching(/SET state = 'VOID'/)).toHaveLength(0);
  });

  it('rejects voiding an ISSUE_PENDING invoice', async () => {
    const pool = new FnPool();
    pool.on(/FOR UPDATE/, [invoiceRow({ state: 'ISSUE_PENDING' })]);
    const { service } = makeService(pool);

    await expect(
      service.voidInvoice(SHOP_ID, INVOICE_ID, MEMBER_ID, 'too early'),
    ).rejects.toThrow('only ISSUED can be voided');
  });
});

describe('createCreditNote (§3.12, INV-16)', () => {
  function onCreditNoteFlow(pool: FnPool) {
    // First FOR UPDATE load = the VOID original; the attemptIssue reload of
    // the credit note returns the new ISSUE_PENDING row.
    let loads = 0;
    pool.onFn(/FOR UPDATE/, () => {
      loads += 1;
      return loads === 1
        ? { rows: [invoiceRow({ state: 'VOID', invoice_number: 'INV/2026-27/000001' })], rowCount: 1 }
        : {
            rows: [
              invoiceRow({
                invoice_id: CREDIT_NOTE_ID,
                series_code: 'CN',
                void_of_invoice_id: INVOICE_ID,
              }),
            ],
            rowCount: 1,
          };
    });
    pool.on(/INSERT INTO gst_invoice\s/, [{ invoice_id: CREDIT_NOTE_ID }]);
    pool.on(/INSERT INTO gst_invoice_line\s+/, [], 2);
    pool.on(/SELECT \* FROM gst_invoice_line/, [lineRow({ invoice_id: CREDIT_NOTE_ID })]);
    pool.on(/COALESCE\(ss\.timezone/, [{ timezone: 'Asia/Kolkata' }]);
    pool.on(/INSERT INTO invoice_number_sequence/, [{ next_number: 1 }]);
    pool.on(/UPDATE gst_invoice\s+SET state = 'ISSUED'/, [], 1);
    pool.on(/SELECT \* FROM gst_invoice\s+WHERE/, [
      invoiceRow({ invoice_id: CREDIT_NOTE_ID, series_code: 'CN', state: 'ISSUED' }),
    ]);
  }

  it('creates a NEW LINKED record — never an edit of the original', async () => {
    const pool = new FnPool();
    onCreditNoteFlow(pool);
    const { service, audit } = makeService(pool);

    const result = await service.createCreditNote(SHOP_ID, INVOICE_ID, MEMBER_ID, 'price error');

    const insert = pool.matching(/INSERT INTO gst_invoice\s/)[0];
    expect(insert.sql).toContain('void_of_invoice_id');
    expect(insert.params[5]).toBe(INVOICE_ID); // linked to the voided original
    expect(insert.params[1]).toBe(invoiceRow().order_id); // same Order
    // The original is never UPDATEd by this flow.
    expect(pool.matching(/UPDATE gst_invoice\s+SET(?! state = 'ISSUED')/)).toHaveLength(0);
    expect(result.invoice.series_code).toBe('CN');
    // §9.9.2: complete data issues automatically — CN series, own sequence.
    const alloc = pool.matching(/INSERT INTO invoice_number_sequence/)[0];
    expect(alloc.params[3]).toBe('CN');
    const entry = audit.entries.find((e) => e.action === 'gst_invoice.credit_note_created');
    expect(entry).toMatchObject({
      actorId: MEMBER_ID,
      reason: 'price error',
      after: { voidOfInvoiceId: INVOICE_ID, seriesCode: 'CN' },
    });
  });

  it('requires a VOID original', async () => {
    const pool = new FnPool();
    pool.on(/FOR UPDATE/, [invoiceRow({ state: 'ISSUED' })]);
    const { service } = makeService(pool);

    await expect(
      service.createCreditNote(SHOP_ID, INVOICE_ID, MEMBER_ID),
    ).rejects.toThrow('a credit note requires a VOID original');
    expect(pool.matching(/INSERT INTO gst_invoice\s/)).toHaveLength(0);
  });
});

describe('patchInvoice (§9.9.2, INV-22)', () => {
  it('supplies missing fields and re-attempts issue automatically', async () => {
    const pool = new FnPool();
    let loads = 0;
    pool.onFn(/FOR UPDATE/, () => {
      loads += 1;
      // Patch load: missing HSN. Issue reload: now complete.
      return loads === 1
        ? {
            rows: [
              invoiceRow({
                state: 'ISSUE_PENDING',
                missing_fields: [{ code: 'LINE_HSN', orderLineId: 'l1' }],
              }),
            ],
            rowCount: 1,
          }
        : { rows: [invoiceRow({ state: 'ISSUE_PENDING', missing_fields: [] })], rowCount: 1 };
    });
    // Line reads: pre-patch hsn null; the merged re-read and the issue load
    // see the PATCHed hsn.
    let lineReads = 0;
    pool.onFn(/SELECT \* FROM gst_invoice_line/, () => {
      lineReads += 1;
      return { rows: [lineRow({ hsn_code: lineReads === 1 ? null : '6109' })], rowCount: 1 };
    });
    pool.on(/UPDATE gst_invoice_line/, [], 1);
    pool.on(/UPDATE gst_invoice\s+SET seller_snapshot/, [], 1);
    pool.on(/COALESCE\(ss\.timezone/, [{ timezone: 'Asia/Kolkata' }]);
    pool.on(/INSERT INTO invoice_number_sequence/, [{ next_number: 7 }]);
    pool.on(/UPDATE gst_invoice\s+SET state = 'ISSUED'/, [], 1);
    pool.on(/SELECT \* FROM gst_invoice\s+WHERE/, [invoiceRow({ state: 'ISSUED' })]);
    const { service } = makeService(pool);

    const result = await service.patchInvoice(SHOP_ID, INVOICE_ID, MEMBER_ID, {
      version: 1,
      lines: [{ orderLineId: 'l1', hsnCode: '6109' }],
    });

    const lineUpdate = pool.matching(/UPDATE gst_invoice_line/)[0];
    expect(lineUpdate.params[2]).toBe('6109');
    // INV-22: the invoice update carries the version the writer read.
    const invoiceUpdate = pool.matching(/UPDATE gst_invoice\s+SET seller_snapshot/)[0];
    expect(invoiceUpdate.sql).toContain('AND version = $7');
    expect(invoiceUpdate.params[6]).toBe(1);
    expect(result.issue?.issued).toBe(true);
  });

  it('rejects a version mismatch (INV-22)', async () => {
    const pool = new FnPool();
    pool.on(/FOR UPDATE/, [invoiceRow({ state: 'ISSUE_PENDING' })]);
    pool.on(/SELECT \* FROM gst_invoice_line/, [lineRow()]);
    pool.on(/UPDATE gst_invoice\s+SET seller_snapshot/, [], 0); // version conflict
    const { service } = makeService(pool);

    await expect(
      service.patchInvoice(SHOP_ID, INVOICE_ID, MEMBER_ID, { version: 99 }),
    ).rejects.toThrow('version conflict');
    expect(pool.calls.some((c) => c.sql === 'ROLLBACK')).toBe(true);
  });

  it('rejects edits once ISSUED — corrections are linked records (INV-16)', async () => {
    const pool = new FnPool();
    pool.on(/FOR UPDATE/, [invoiceRow({ state: 'ISSUED' })]);
    const { service } = makeService(pool);

    await expect(
      service.patchInvoice(SHOP_ID, INVOICE_ID, MEMBER_ID, { version: 2 }),
    ).rejects.toThrow('only ISSUE_PENDING is editable');
  });

  it('applies a per-line GST rate override (§9.9.2 tax model)', async () => {
    const pool = new FnPool();
    pool.on(/FOR UPDATE/, [invoiceRow({ state: 'ISSUE_PENDING', missing_fields: [{ code: 'X' as never }] })]);
    pool.on(/SELECT \* FROM gst_invoice_line/, [lineRow()]);
    pool.on(/UPDATE gst_invoice_line/, [], 1);
    pool.on(/UPDATE gst_invoice\s+SET seller_snapshot/, [], 1);
    // The trailing getInvoice reload (missing 'X' stays → no issue attempt).
    pool.on(/SELECT \* FROM gst_invoice\s+WHERE/, [invoiceRow()]);
    const { service } = makeService(pool);

    await service.patchInvoice(SHOP_ID, INVOICE_ID, MEMBER_ID, {
      version: 1,
      lines: [{ orderLineId: 'l1', gstRate: '0.050000' }],
    });

    const lineUpdate = pool.matching(/UPDATE gst_invoice_line/)[0];
    // Inter-state fixture at 5%: IGST = 5% of ₹1000.00 = ₹50.00.
    expect(JSON.parse(lineUpdate.params[4] as string)).toEqual([
      { type: 'IGST', rate: '0.050000', amount: '50.00' },
    ]);
    expect(lineUpdate.params[5]).toBe('1050.00');
  });
});

describe('listInvoices (§11 INVOICE_PENDING feed)', () => {
  it('applies state, missing-fields and date-range filters, shop-scoped', async () => {
    const pool = new FnPool();
    pool.on(/SELECT \* FROM gst_invoice/, [invoiceRow()]);
    const { service } = makeService(pool);

    await service.listInvoices(SHOP_ID, {
      state: 'ISSUE_PENDING',
      missingFieldsPresent: true,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
    });

    const call = pool.matching(/SELECT \* FROM gst_invoice/)[0];
    expect(call.sql).toContain('shop_id = $1');
    expect(call.sql).toContain('state = $2');
    expect(call.sql).toContain('jsonb_array_length(missing_fields) > 0');
    expect(call.sql).toContain('created_at >= $3');
    expect(call.sql).toContain('created_at < $4');
    expect(call.params).toEqual([
      SHOP_ID,
      'ISSUE_PENDING',
      '2026-07-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
    ]);
  });

  it('without filters scopes to the shop only (INV-1)', async () => {
    const pool = new FnPool();
    pool.on(/SELECT \* FROM gst_invoice/, []);
    const { service } = makeService(pool);

    await service.listInvoices(SHOP_ID, {});

    const call = pool.matching(/SELECT \* FROM gst_invoice/)[0];
    expect(call.sql).not.toContain('state =');
    expect(call.params).toEqual([SHOP_ID]);
  });
});
