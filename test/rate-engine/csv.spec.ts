import { describe, expect, it } from 'vitest';
import {
  CSV_MAX_ROWS,
  parseCsvText,
  validateRateCardCsv,
} from '../../src/modules/rate-engine/rate-card-csv';

/**
 * §9.15 CSV upload with validation preview, §8.7 neutralization and §5.1
 * limits: parse strictly, validate every row, reject formula-leading cells,
 * enforce ≤25 MB / ≤100,000 rows — and never persist anything here.
 */

const HEADER =
  'kind,zone_or_code,base_weight_kg_or_label,base_rate_or_basis,additional_step_kg_or_value,additional_rate_or_is_taxable';

describe('parseCsvText — minimal strict parser', () => {
  it('handles quoting, escaped quotes, commas and CRLF', () => {
    const rows = parseCsvText('a,"b,1","he said ""hi"""\r\nc,d,e\n');
    expect(rows).toEqual([
      ['a', 'b,1', 'he said "hi"'],
      ['c', 'd', 'e'],
    ]);
  });

  it('throws on an unterminated quoted field', () => {
    expect(() => parseCsvText('a,"unclosed')).toThrow('unterminated');
  });
});

describe('validateRateCardCsv — happy path preview (§9.15 template)', () => {
  it('validates slab and component rows and totals the preview', () => {
    const csv = [
      HEADER,
      'SLAB,C,0.500,42.00,0.500,38.00',
      'SLAB,D,0.500,55.00,0.500,48.00',
      'COMPONENT,INS,Insurance,PERCENT_OF_DECLARED_VALUE,0.010000,true',
      'COMPONENT,HANDLING,Handling fee,FLAT,10.00,false',
    ].join('\n');
    const preview = validateRateCardCsv(csv);

    expect(preview.ok).toBe(true);
    expect(preview.totalRows).toBe(4);
    expect(preview.okRows).toBe(4);
    expect(preview.errorRows).toBe(0);
    expect(preview.slabs).toEqual([
      { zone: 'C', baseWeightKg: '0.500', baseRate: '42.00', additionalStepKg: '0.500', additionalRate: '38.00' },
      { zone: 'D', baseWeightKg: '0.500', baseRate: '55.00', additionalStepKg: '0.500', additionalRate: '48.00' },
    ]);
    // COMPONENT position is the row's order among COMPONENT rows.
    expect(preview.components.map((c) => [c.code, c.position, c.isTaxable])).toEqual([
      ['INS', 1, true],
      ['HANDLING', 2, false],
    ]);
  });

  it('works without a header row', () => {
    const preview = validateRateCardCsv('SLAB,A,0.500,30.00,0.500,25.00');
    expect(preview.ok).toBe(true);
    expect(preview.slabs).toHaveLength(1);
  });
});

describe('validateRateCardCsv — per-row validation errors', () => {
  it('rejects a bad zone, sub-paise rates and non-positive weights', () => {
    const preview = validateRateCardCsv(
      ['SLAB,F,0.500,42.00,0.500,38.00', 'SLAB,C,0.500,42.001,0.500,38.00', 'SLAB,D,0.000,42.00,0.500,38.00'].join('\n'),
    );
    expect(preview.ok).toBe(false);
    expect(preview.errorRows).toBe(3);
    expect(preview.rows[0].errors.join(' ')).toMatch(/zone must be one of A–E/);
    expect(preview.rows[1].errors.join(' ')).toMatch(/base_rate must be INR ≥0 ≤2dp/);
    expect(preview.rows[2].errors.join(' ')).toMatch(/base_weight_kg must be a positive kg value/);
  });

  it('rejects duplicate zones — one slab per zone per version (§2.3)', () => {
    const preview = validateRateCardCsv(
      ['SLAB,C,0.500,42.00,0.500,38.00', 'SLAB,C,1.000,50.00,0.500,40.00'].join('\n'),
    );
    expect(preview.ok).toBe(false);
    expect(preview.rows[1].errors.join(' ')).toMatch(/duplicate SLAB row for zone C/);
  });

  it('rejects bad component basis and value scale', () => {
    const preview = validateRateCardCsv('COMPONENT,INS,Insurance,PERCENT_MAGIC,2.5,true');
    expect(preview.ok).toBe(false);
    expect(preview.rows[0].errors.join(' ')).toMatch(/basis must be one of/);
  });

  it('rejects unknown row kinds and documents the expected columns', () => {
    const preview = validateRateCardCsv('ZONE,C,0.500,42.00,0.500,38.00');
    expect(preview.ok).toBe(false);
    const text = preview.rows[0].errors.join(' ');
    expect(text).toMatch(/row kind must be SLAB or COMPONENT/);
    expect(text).toMatch(/SLAB,zone,base_weight_kg,base_rate,additional_step_kg,additional_rate/);
  });
});

describe('validateRateCardCsv — §8.7 formula neutralization', () => {
  it.each(['=1+1', '+SUM(A1:A2)', '-5', '@cmd /c calc'])(
    'rejects cells starting with %s',
    (cell) => {
      const preview = validateRateCardCsv(`SLAB,C,0.500,${cell},0.500,38.00`);
      expect(preview.ok).toBe(false);
      expect(
        preview.rows.some((r) => r.errors.some((e) => e.includes('§8.7'))),
      ).toBe(true);
    },
  );

  it('rejects a formula in ANY column, including labels', () => {
    const preview = validateRateCardCsv('COMPONENT,INS,=HYPERLINK("http://evil"),FLAT,10.00,true');
    expect(preview.ok).toBe(false);
    expect(preview.rows[0].errors.join(' ')).toMatch(/formula content is rejected/);
  });
});

describe('validateRateCardCsv — §5.1 limits', () => {
  it('rejects files over 100,000 rows', () => {
    const row = 'SLAB,C,0.500,42.00,0.500,38.00\n';
    const csv = row.repeat(CSV_MAX_ROWS + 1);
    const preview = validateRateCardCsv(csv);
    expect(preview.ok).toBe(false);
    expect(preview.rows[0].errors.join(' ')).toMatch(/100,000 row limit/);
  });

  it('rejects files over 25 MB', () => {
    const csv = 'x'.repeat(25 * 1024 * 1024 + 1);
    const preview = validateRateCardCsv(csv);
    expect(preview.ok).toBe(false);
    expect(preview.rows[0].errors.join(' ')).toMatch(/25 MB upload limit/);
  });
});
