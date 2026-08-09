import { describe, expect, it } from 'vitest';
import { CsvRenderer } from '../../src/modules/reports/csv-renderer';
import { REPORT_CATALOGUE } from '../../src/modules/reports/report-catalogue';

const AS_OF = new Date('2026-08-05T19:57:58.855Z');

function render(includeTest: boolean, rows: (string | null)[][] = [['a', 'b']]) {
  const renderer = new CsvRenderer();
  return renderer.render(
    {
      definition: REPORT_CATALOGUE.SHIPMENTS,
      asOf: AS_OF,
      filters: { dateFrom: '2026-07-01', dateTo: '2026-07-31', includeTest },
      timezone: 'Asia/Kolkata',
    },
    REPORT_CATALOGUE.SHIPMENTS.columns,
    rows,
  ).toString('utf8');
}

describe('CsvRenderer — §11/§5.2 export header', () => {
  it('states as-of time, filter set, counting unit and attribution', () => {
    const csv = render(false);
    expect(csv).toContain(`# as-of (UTC): ${AS_OF.toISOString()}`);
    expect(csv).toContain('# counting-unit: shipments');
    expect(csv).toContain('# attribution: booked-at');
    expect(csv).toContain('"includeTest":false');
    expect(csv).toContain('# timezone: Asia/Kolkata');
  });

  it('§9.23 default: test exclusion stated in the header', () => {
    expect(render(false)).toContain('# test-shipments-included: no (default, §9.23)');
  });

  it('§9.23: an export produced with include-test ON is labelled', () => {
    expect(render(true)).toContain(
      '# test-shipments-included: YES — this export includes test shipments (§9.23)',
    );
  });

  it('writes the column header row after the header block', () => {
    const lines = render(false).split('\r\n');
    const headerIdx = lines.findIndex((l) => !l.startsWith('#'));
    expect(lines[headerIdx]).toBe(REPORT_CATALOGUE.SHIPMENTS.columns.join(','));
  });

  it('escapes commas, quotes and newlines; nulls are empty cells', () => {
    const csv = render(false, [['he said "hi"', null], ['a,b', 'line1\nline2']]);
    const lines = csv.split('\r\n');
    expect(lines).toContain('"he said ""hi""",');
    expect(lines.join('\n')).toContain('"a,b","line1\nline2"');
  });
});
