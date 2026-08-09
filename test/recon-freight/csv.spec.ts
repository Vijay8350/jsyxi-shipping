import { describe, expect, it } from 'vitest';
import {
  contentHash,
  looksLikeArchiveOrBinary,
  mapInvoiceRows,
  neutralizeFormula,
  parseCsv,
  parseInvoiceAmount,
  parseInvoiceDate,
  parseWeightKg,
} from '../../src/modules/recon-freight/recon-csv';
import { paiseToRupees } from '../../src/common/money';
import { exampleColumnMap } from './helpers';

/**
 * §8.7 import helpers: CSV grammar, formula neutralization, §4.1 storage
 * forms, §3.13 charge-type defaults and the INV-20 unmapped-value rule.
 */

describe('parseCsv (§8.7)', () => {
  it('parses quoted cells, escaped quotes and CRLF', () => {
    const grid = parseCsv('a,"b,c","d""e"\r\n1,2,3\r\n');
    expect(grid).toEqual([
      ['a', 'b,c', 'd"e'],
      ['1', '2', '3'],
    ]);
  });

  it('strips a BOM and drops trailing blank lines', () => {
    expect(parseCsv('﻿a,b\n\n')).toEqual([['a', 'b']]);
  });

  it('rejects an unterminated quoted cell', () => {
    expect(() => parseCsv('a,"b\n1,2')).toThrow(/unterminated/);
  });
});

describe('formula neutralization (§8.7)', () => {
  it.each(['=SUM(A1:A2)', '+1', '-10', '@cmd'])('disarms %s', (cell) => {
    expect(neutralizeFormula(cell)).toBe(`'${cell}`);
  });
  it('leaves ordinary text alone', () => {
    expect(neutralizeFormula('DL0087412391')).toBe('DL0087412391');
  });
});

describe('parseInvoiceAmount (§4.1, INV-15)', () => {
  it('parses Indian-formatted and currency-prefixed amounts', () => {
    expect(paiseToRupees(parseInvoiceAmount('₹1,234.56')!)).toBe('1234.56');
    expect(paiseToRupees(parseInvoiceAmount(' 211.50 ')!)).toBe('211.50');
  });
  it('rounds sub-paise precision half-up to paise', () => {
    expect(paiseToRupees(parseInvoiceAmount('10.005')!)).toBe('10.01');
    expect(paiseToRupees(parseInvoiceAmount('10.004')!)).toBe('10.00');
  });
  it('keeps the sign for adjustment amounts (§4.1)', () => {
    expect(paiseToRupees(parseInvoiceAmount('-50.00')!)).toBe('-50.00');
  });
  it('returns null for blank or garbage — never dropped (INV-20)', () => {
    expect(parseInvoiceAmount('')).toBeNull();
    expect(parseInvoiceAmount('abc')).toBeNull();
    expect(parseInvoiceAmount(undefined)).toBeNull();
  });
});

describe('parseWeightKg / parseInvoiceDate (§4.1, §5.2)', () => {
  it('parses weights to 3dp kg', () => {
    expect(parseWeightKg('1.5')).toBe('1.500');
    expect(parseWeightKg('0.010')).toBe('0.010');
    expect(parseWeightKg('2 kg')).toBe('2.000');
    expect(parseWeightKg('x')).toBeNull();
  });
  it('parses ISO and Indian date forms to ISO dates', () => {
    expect(parseInvoiceDate('2026-07-31')).toBe('2026-07-31');
    expect(parseInvoiceDate('31-07-2026')).toBe('2026-07-31');
    expect(parseInvoiceDate('31/07/2026')).toBe('2026-07-31');
    expect(parseInvoiceDate('2026-02-30')).toBeNull();
    expect(parseInvoiceDate('')).toBeNull();
  });
});

describe('mapInvoiceRows (§9.17.1, §3.13, INV-20)', () => {
  const csv = [
    'AWB,Amount,Weight,Charge Type,Invoice Ref,Shipper',
    'dl0087412391,211.50,1.500,Forward,INV-9,Acme',
    ' DL00 874-12392 ,158.59,1.000,,INV-9,Acme',
    'DL0087412393,10.00,0.500,WEIRD SURCHARGE,INV-9,Acme',
  ].join('\n');

  it('normalizes AWBs per F-19 and maps charge types case-insensitively', () => {
    const rows = mapInvoiceRows(parseCsv(csv), exampleColumnMap());
    expect(rows).toHaveLength(3);
    expect(rows[0].awbNormalized).toBe('DL0087412391');
    expect(rows[0].chargeType).toBe('FORWARD');
    expect(rows[1].awbNormalized).toBe('DL0087412392'); // spaces + hyphens stripped
    expect(rows[1].chargeType).toBe('FORWARD'); // §3.13 blank → default
    expect(rows[1].chargeTypeUnmapped).toBe(false);
  });

  it('an unmapped courier charge value becomes OTHER + unmapped — never dropped (INV-20)', () => {
    const rows = mapInvoiceRows(parseCsv(csv), exampleColumnMap());
    expect(rows[2].chargeType).toBe('OTHER');
    expect(rows[2].chargeTypeUnmapped).toBe(true);
  });

  it('no charge-type column ⇒ every row FORWARD (§3.13)', () => {
    const rows = mapInvoiceRows(
      parseCsv('AWB,Amount\nDL1,10.00'),
      exampleColumnMap({ chargeTypeColumn: null, chargeTypeValueMap: null, mappings: { awb: 'AWB', amount: 'Amount' } }),
    );
    expect(rows[0].chargeType).toBe('FORWARD');
  });

  it('neutralizes formula text cells but keeps signed amounts parseable', () => {
    const rows = mapInvoiceRows(
      parseCsv('AWB,Amount,Weight,Charge Type,Invoice Ref,Shipper\nDL1,-50.00,0.500,Adjustment,=HYPERLINK("x"),=cmd'),
      exampleColumnMap(),
    );
    expect(rows[0].invoicedAmount).toBe('-50.00'); // §4.1 signed adjustment
    expect(rows[0].invoiceReference).toBe('\'=HYPERLINK("x")');
    expect(rows[0].shipperCompany).toBe("'=cmd");
  });

  it('missing awb/amount columns ⇒ the file "could not be mapped" (§3.18 FAILED)', () => {
    expect(() =>
      mapInvoiceRows(parseCsv('X,Y\n1,2'), exampleColumnMap()),
    ).toThrow(/required awb\/amount/);
  });
});

describe('quarantine helpers (§8.7, §5.1)', () => {
  it('contentHash is sha256 hex — the INV-14 key', () => {
    expect(contentHash(Buffer.from('a,b\n'))).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects archives and binary content', () => {
    expect(looksLikeArchiveOrBinary(Buffer.from('PK\x03\x04…'))).toBe(true);
    expect(looksLikeArchiveOrBinary(Buffer.from('a,b\nc,d'))).toBe(false);
  });
});
