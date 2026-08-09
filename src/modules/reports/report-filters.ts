import { ReportFilters } from './reports.types';

/**
 * §11 shared filters → parameterized SQL fragments. Every report query is
 * shop-scoped (INV-1) and bounded by the job's as_of_at (§5.2: exports are
 * immutable snapshots as of job start — queries must not see later data).
 *
 * Date ranges arrive as shop-local calendar dates and are rendered half-open
 * [dateFrom 00:00, dateTo+1 00:00) in the Shop's timezone (§5.2), converted
 * in SQL via AT TIME ZONE so the conversion happens on the database's IANA
 * data, not the app's.
 */
export class Where {
  private readonly parts: string[] = [];
  private readonly params: unknown[] = [];

  /** Add a parameter, returns its $n placeholder. */
  param(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  add(fragment: string): this {
    this.parts.push(fragment);
    return this;
  }

  sql(): string {
    return this.parts.length > 0 ? `WHERE ${this.parts.join(' AND ')}` : '';
  }

  values(): unknown[] {
    return [...this.params];
  }
}

/**
 * The attribution-date frame every report shares:
 *  - shop-local inclusive date range [dateFrom, dateTo] on `column`;
 *  - the as-of bound `column <= asOf` (§5.2 — the snapshot rule, testable).
 * `column` is a trusted SQL expression from the generator, never user input.
 */
export function applyAttributionFrame(
  w: Where,
  column: string,
  filters: ReportFilters,
  timezone: string,
  asOf: Date,
): void {
  if (filters.dateFrom) {
    w.add(`${column} >= (${w.param(filters.dateFrom)}::date AT TIME ZONE ${w.param(timezone)})`);
  }
  if (filters.dateTo) {
    w.add(`${column} < ((${w.param(filters.dateTo)}::date + 1) AT TIME ZONE ${w.param(timezone)})`);
  }
  w.add(`${column} <= ${w.param(asOf.toISOString())}::timestamptz`);
}

/**
 * §9.23 / §11: the shared "include test shipments" filter defaults OFF.
 * `testColumn` is the boolean test flag on the report's grain table
 * (shipment.is_test / "order".is_test_order).
 */
export function applyTestExclusion(w: Where, testColumn: string, includeTest: boolean): void {
  if (!includeTest) w.add(`${testColumn} = false`);
}

/** Shared optional filters (§11). Columns are generator-supplied, trusted. */
export function applySharedFilters(
  w: Where,
  filters: ReportFilters,
  cols: { serviceId?: string; paymentMode?: string; courierAccountId?: string; status?: string },
): void {
  if (filters.serviceId && cols.serviceId) {
    w.add(`${cols.serviceId} = ${w.param(filters.serviceId)}::uuid`);
  }
  if (filters.paymentMode && cols.paymentMode) {
    w.add(`${cols.paymentMode} = ${w.param(filters.paymentMode)}`);
  }
  if (filters.courierAccountId && cols.courierAccountId) {
    w.add(`${cols.courierAccountId} = ${w.param(filters.courierAccountId)}::uuid`);
  }
  if (filters.status && cols.status) {
    w.add(`${cols.status} = ${w.param(filters.status)}`);
  }
}

/** Money → 2dp text for CSV cells (§4.1 display form; NUMERIC math, no floats). */
export function money2(expr: string): string {
  return `ROUND(${expr}, 2)::text`;
}

/** Whole days between two instants (age columns), as text. */
export function ageDays(fromExpr: string, asOfParamSql: string): string {
  return `((${asOfParamSql})::date - (${fromExpr})::date)::text`;
}
