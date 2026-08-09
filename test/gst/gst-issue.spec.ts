import { describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { GstInvoiceService } from '../../src/modules/gst/gst-invoice.service';
import { financialYearAt } from '../../src/modules/gst/gst-tax';
import {
  FnPool,
  INVOICE_ID,
  invoiceRow,
  lineRow,
  mockAudit,
  SHOP_ID,
} from './helpers';

function makeService(pool: FnPool, audit = mockAudit()) {
  return {
    pool,
    audit,
    service: new GstInvoiceService(pool.asPool(), audit as unknown as AuditService),
  };
}

function onIssuePrereqs(pool: FnPool) {
  pool.on(/SELECT \* FROM gst_invoice_line/, [lineRow()]);
  pool.on(/COALESCE\(ss\.timezone/, [{ timezone: 'Asia/Kolkata' }]);
}

describe('attemptIssue (§3.12, INV-13)', () => {
  it('does not allocate a number while missing_fields is non-empty', async () => {
    const pool = new FnPool();
    pool.on(/FOR UPDATE/, [invoiceRow({ missing_fields: [{ code: 'LINE_HSN', orderLineId: 'l1' }] })]);
    const { service } = makeService(pool);

    const result = await service.attemptIssue(SHOP_ID, INVOICE_ID, { kind: 'SYSTEM', id: null });

    expect(result).toEqual({ issued: false, invoiceId: INVOICE_ID, reason: 'MISSING_FIELDS' });
    expect(pool.matching(/invoice_number_sequence/)).toHaveLength(0);
    expect(pool.matching(/SET state = 'ISSUED'/)).toHaveLength(0);
  });

  it('is idempotent for an already-ISSUED invoice', async () => {
    const pool = new FnPool();
    pool.on(/FOR UPDATE/, [invoiceRow({ state: 'ISSUED', invoice_number: 'INV/2026-27/000001' })]);
    const { service } = makeService(pool);

    const result = await service.attemptIssue(SHOP_ID, INVOICE_ID, { kind: 'SYSTEM', id: null });

    expect(result.reason).toBe('ALREADY_ISSUED');
    expect(pool.matching(/invoice_number_sequence/)).toHaveLength(0);
  });

  it('allocates through the single atomic statement and formats §13.5', async () => {
    const pool = new FnPool();
    pool.on(/FOR UPDATE/, [invoiceRow()]);
    onIssuePrereqs(pool);
    pool.on(/INSERT INTO invoice_number_sequence/, [{ next_number: 241 }]);
    pool.on(/UPDATE gst_invoice\s+SET state = 'ISSUED'/, [], 1);
    const { service, audit } = makeService(pool);

    const result = await service.attemptIssue(SHOP_ID, INVOICE_ID, { kind: 'SYSTEM', id: null });

    expect(result.issued).toBe(true);
    // INV-13: exactly one allocation statement, atomic upsert, shop-scoped.
    const allocs = pool.matching(/INSERT INTO invoice_number_sequence/);
    expect(allocs).toHaveLength(1);
    expect(allocs[0].sql).toContain('ON CONFLICT (shop_id, gstin, financial_year, series_code)');
    expect(allocs[0].sql).toContain('DO UPDATE SET next_number = invoice_number_sequence.next_number + 1');
    expect(allocs[0].sql).toContain('RETURNING next_number');
    expect(allocs[0].params[0]).toBe(SHOP_ID);
    expect(allocs[0].params[1]).toBe('24AAAAA0000A1Z5');

    const fy = financialYearAt(new Date(), 'Asia/Kolkata');
    expect(result.invoiceNumber).toBe(`INV/${fy}/000241`);
    const update = pool.matching(/SET state = 'ISSUED'/)[0];
    expect(update.params[2]).toBe(`INV/${fy}/000241`);
    expect(update.params[3]).toBe(fy);

    // Audit carries ids/state/number only — never tax identity (§5.7).
    const issued = audit.entries.find((e) => e.action === 'gst_invoice.issued');
    expect(issued?.after).toEqual({
      state: 'ISSUED',
      invoiceNumber: `INV/${fy}/000241`,
      financialYear: fy,
    });
  });

  it('gives concurrent issues distinct sequential numbers from the one statement', async () => {
    const pool = new FnPool();
    pool.on(/FOR UPDATE/, [invoiceRow()]);
    onIssuePrereqs(pool);
    // The sequence row is the single atomic allocation point: every issue
    // goes through the same upsert, which increments atomically (INV-13).
    let next = 0;
    pool.onFn(/INSERT INTO invoice_number_sequence/, () => {
      next += 1;
      return { rows: [{ next_number: next }], rowCount: 1 };
    });
    pool.on(/UPDATE gst_invoice\s+SET state = 'ISSUED'/, [], 1);
    const { service } = makeService(pool);

    const first = await service.attemptIssue(SHOP_ID, INVOICE_ID, { kind: 'SYSTEM', id: null });
    const second = await service.attemptIssue(SHOP_ID, INVOICE_ID, {
      kind: 'SYSTEM',
      id: null,
    });

    const fy = financialYearAt(new Date(), 'Asia/Kolkata');
    expect(first.invoiceNumber).toBe(`INV/${fy}/000001`);
    expect(second.invoiceNumber).toBe(`INV/${fy}/000002`);
    expect(
      pool.matching(/INSERT INTO invoice_number_sequence/).map((c) => c.sql),
    ).toEqual([
      pool.matching(/INSERT INTO invoice_number_sequence/)[0].sql,
      pool.matching(/INSERT INTO invoice_number_sequence/)[0].sql,
    ]); // the SAME single statement both times
  });

  it('a mid-issue failure rolls back — no number is consumed (no gap)', async () => {
    const pool = new FnPool();
    pool.on(/FOR UPDATE/, [invoiceRow()]);
    onIssuePrereqs(pool);
    let next = 0;
    pool.onFn(/INSERT INTO invoice_number_sequence/, () => {
      next += 1;
      return { rows: [{ next_number: next }], rowCount: 1 };
    });
    pool.onFn(/UPDATE gst_invoice\s+SET state = 'ISSUED'/, () => {
      throw new Error('db blew up mid-issue');
    });
    const { service } = makeService(pool);

    await expect(
      service.attemptIssue(SHOP_ID, INVOICE_ID, { kind: 'SYSTEM', id: null }),
    ).rejects.toThrow('db blew up mid-issue');

    const allocIdx = pool.calls.findIndex((c) => /invoice_number_sequence/.test(c.sql));
    const after = pool.calls.slice(allocIdx + 1).map((c) => c.sql);
    expect(after.some((s) => s === 'ROLLBACK')).toBe(true);
    expect(after.some((s) => s === 'COMMIT')).toBe(false);
    // The allocation rolled back with the transaction: the next attempt
    // re-enters the same statement and would draw the same next number.
    expect(next).toBe(1);
  });

  it('totals are sums of the stored rounded line components (INV-15)', async () => {
    const pool = new FnPool();
    pool.on(/FOR UPDATE/, [invoiceRow()]);
    pool.on(/SELECT \* FROM gst_invoice_line/, [
      lineRow({
        invoice_line_id: 'il1',
        taxable_value: '0.15',
        tax_components: [{ type: 'IGST', rate: '0.180000', amount: '0.03' }],
        line_total: '0.18',
      }),
      lineRow({
        invoice_line_id: 'il2',
        taxable_value: '0.15',
        tax_components: [{ type: 'IGST', rate: '0.180000', amount: '0.03' }],
        line_total: '0.18',
      }),
    ]);
    pool.on(/COALESCE\(ss\.timezone/, [{ timezone: 'Asia/Kolkata' }]);
    pool.on(/INSERT INTO invoice_number_sequence/, [{ next_number: 1 }]);
    pool.on(/UPDATE gst_invoice\s+SET state = 'ISSUED'/, [], 1);
    const { service } = makeService(pool);

    await service.attemptIssue(SHOP_ID, INVOICE_ID, { kind: 'SYSTEM', id: null });

    const update = pool.matching(/SET state = 'ISSUED'/)[0];
    const totals = JSON.parse(update.params[4] as string) as Record<string, string>;
    // 3p + 3p = ₹0.06 — never a re-round of the unrounded total (₹0.05).
    expect(totals.igst).toBe('0.06');
    expect(totals.taxableValue).toBe('0.30');
    expect(totals.grandTotal).toBe('0.36');
    expect(totals.currency).toBe('INR');
  });
});
