/**
 * §5.4 retention horizons (A1-08, RV-12 — OWNER: Mahesh Rojasara) as named
 * constants. This is the ONE file an RV-12 owner review amends: every sweep
 * cutoff derives from these values, each with its spec citation.
 *
 * All cutoff math is pure and UTC-based so the boundaries are unit-testable
 * without a database. Horizon semantics per the §5.4 table:
 *
 *   Financial/tax/billing/recon/shipment/audit facts + invoice PDFs  7 FY
 *   Normalized tracking events                                       24 mo
 *   Raw webhook payloads                                             30 d
 *   Report exports                                                   30 d
 *   Labels, manifests, temporary bundles                             90 d
 *   Ticket + feedback attachments            180 d after closure/submission
 *   Test shipments + §5.3 carve-out children   shortest applicable horizon;
 *                                              Owner may bulk-delete any time
 */

/** §5.4 raw webhook payloads — applies to webhook_inbox (terminal states)
 *  and to tracking_event_raw partitions (§5.1). */
export const RAW_WEBHOOK_PAYLOAD_RETENTION_DAYS = 30; // §5.4

/** §5.4 report exports — the exported artifact; the report_job row stays. */
export const REPORT_EXPORT_RETENTION_DAYS = 30; // §5.4

/** §5.4 labels/manifests/temporary bundles — applied as document.expires_at
 *  at creation (see booking-ops/pickup.service.ts); the sweep reads
 *  expires_at, so this constant documents the horizon rather than driving a
 *  cutoff here. */
export const LABEL_MANIFEST_BUNDLE_RETENTION_DAYS = 90; // §5.4

/** §5.4 ticket and feedback attachments — 180 days after ticket closure
 *  (ticket.resolved_at) or feedback submission (feedback.created_at). */
export const TICKET_FEEDBACK_ATTACHMENT_RETENTION_DAYS = 180; // §5.4

/** §5.4 normalized tracking events — tracking_event partitions (§5.1). */
export const TRACKING_EVENT_RETENTION_MONTHS = 24; // §5.4

/** §5.4 financial, tax, billing, reconciliation, shipment and audit facts;
 *  invoice PDFs — 7 financial years. The Indian financial year runs
 *  1 Apr–31 Mar (§5.2). */
export const FINANCIAL_FACT_RETENTION_FY = 7; // §5.4

/** §5.4 / sweep batching: maximum rows touched per DELETE statement, looped. */
export const RETENTION_BATCH_SIZE = 5000;

/** §5.1: the monthly partition-maintenance job keeps the current month plus
 *  this many months ahead pre-created. */
export const PARTITION_MONTHS_AHEAD = 3; // §5.1

const DAY_MS = 24 * 60 * 60 * 1000;

/** now − days, as a Date. Cutoff for day-based horizons (§5.4). */
export function daysCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/** now − months (calendar months, UTC). Cutoff for the 24-month horizon. */
export function monthsCutoff(now: Date, months: number): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() - months,
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}

/**
 * Start (UTC) of the Indian financial year containing `now` — FY runs
 * 1 Apr–31 Mar (§5.2). E.g. any instant in 2026-04-01..2027-03-31 →
 * 2026-04-01T00:00:00Z.
 */
export function financialYearStartContaining(now: Date): Date {
  const year = now.getUTCFullYear();
  const fyStartYear = now.getUTCMonth() >= 3 ? year : year - 1; // April = month 3
  return new Date(Date.UTC(fyStartYear, 3, 1));
}

/**
 * §5.4 7-financial-year cutoff: records dated BEFORE this instant have
 * completed their retention and are deletable. The retained window is the
 * current FY plus the (FINANCIAL_FACT_RETENTION_FY − 1) preceding FYs —
 * exactly 7 financial years. E.g. during FY2026 (2026-04-01..2027-03-31) the
 * cutoff is 2020-04-01: FY2019 records have been retained through FY2019…
 * FY2025 (7 FYs) and may go; FY2020 records stay.
 */
export function financialRetentionCutoff(now: Date): Date {
  const fyStart = financialYearStartContaining(now);
  return new Date(
    Date.UTC(fyStart.getUTCFullYear() - (FINANCIAL_FACT_RETENTION_FY - 1), 3, 1),
  );
}

/** A 1-based calendar month, UTC. */
export interface PartitionMonth {
  year: number;
  month: number; // 1..12
}

/**
 * The months partition maintenance (§5.1) ensures exist: the current month
 * plus PARTITION_MONTHS_AHEAD months ahead, in chronological order.
 */
export function monthsToEnsure(now: Date, ahead: number): PartitionMonth[] {
  const out: PartitionMonth[] = [];
  for (let i = 0; i <= ahead; i += 1) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1),
    );
    out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }
  return out;
}

/**
 * Partition name for a monthly partition, matching the DB helpers
 * create_shipment_partition (0003) and create_tracking_partition (0010):
 * `{table}_{year}_{mm}`.
 */
export function partitionName(table: string, m: PartitionMonth): string {
  return `${table}_${m.year}_${String(m.month).padStart(2, '0')}`;
}

/**
 * Given the partition names currently attached to a partitioned table,
 * return those whose ENTIRE range is older than `cutoff` — these are safe to
 * DETACH + DROP (§5.4). A partition straddling the cutoff is kept (its newer
 * rows are still inside the horizon); the `{table}_default` partition never
 * matches the name pattern and is handled by row deletes instead.
 */
export function expiredPartitionNames(
  names: string[],
  table: string,
  cutoff: Date,
): string[] {
  const pattern = new RegExp(`^${table}_(\\d{4})_(\\d{2})$`);
  const expired: string[] = [];
  for (const name of names) {
    const match = pattern.exec(name);
    if (!match) continue; // default partition, or anything not ours
    const year = Number(match[1]);
    const month = Number(match[2]); // 1..12
    // The partition covers [monthStart, monthEnd); it is fully expired only
    // when its end is at or before the cutoff.
    const monthEnd = new Date(Date.UTC(year, month, 1)); // first of next month
    if (monthEnd.getTime() <= cutoff.getTime()) expired.push(name);
  }
  return expired.sort();
}
