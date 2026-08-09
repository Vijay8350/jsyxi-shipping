import { ReportDefinition } from './report-catalogue';
import { ReportCell, ReportFilters } from './reports.types';

/**
 * Report renderers (§11: "CSV or XLSX"). The renderer is an interface so
 * XLSX slots in without touching generators or the job lifecycle — the runner
 * picks by `format`. CSV is the v1 format.
 */
export interface RenderHeader {
  definition: ReportDefinition;
  /** report_job.as_of_at — the immutable snapshot instant (§5.2). */
  asOf: Date;
  /** The normalized filter set, echoed into the header (§11). */
  filters: ReportFilters & { includeTest: boolean };
  /** S-2 shop timezone used for the date-range interpretation. */
  timezone: string;
}

export interface ReportRenderer {
  readonly format: 'CSV' | 'XLSX';
  readonly contentType: string;
  readonly extension: string;
  render(header: RenderHeader, columns: string[], rows: ReportCell[][]): Buffer;
}

function csvCell(value: ReportCell): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export class CsvRenderer implements ReportRenderer {
  readonly format = 'CSV' as const;
  readonly contentType = 'text/csv; charset=utf-8';
  readonly extension = 'csv';

  /**
   * The §11/§5.2 export header: as-of time, filter set, counting unit
   * (A2-06), and whether test shipments were included — labelled whenever the
   * §9.23 include-test filter was on.
   */
  render(header: RenderHeader, columns: string[], rows: ReportCell[][]): Buffer {
    const { definition, asOf, filters } = header;
    const lines: string[] = [
      `# Jsyxi Shipping report: ${definition.code} — ${definition.name}`,
      `# as-of (UTC): ${asOf.toISOString()}`,
      `# attribution: ${definition.attribution}`,
      `# counting-unit: ${definition.countingUnit}`,
      filters.includeTest
        ? '# test-shipments-included: YES — this export includes test shipments (§9.23)'
        : '# test-shipments-included: no (default, §9.23)',
      `# filters: ${JSON.stringify(filters)}`,
      `# timezone: ${header.timezone}`,
      columns.map(csvCell).join(','),
      ...rows.map((r) => r.map(csvCell).join(',')),
    ];
    return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
  }
}
