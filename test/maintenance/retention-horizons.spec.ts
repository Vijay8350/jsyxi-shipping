import { describe, expect, it } from 'vitest';
import {
  daysCutoff,
  expiredPartitionNames,
  financialRetentionCutoff,
  financialYearStartContaining,
  monthsCutoff,
  monthsToEnsure,
  partitionName,
  RAW_WEBHOOK_PAYLOAD_RETENTION_DAYS,
  REPORT_EXPORT_RETENTION_DAYS,
  LABEL_MANIFEST_BUNDLE_RETENTION_DAYS,
  TICKET_FEEDBACK_ATTACHMENT_RETENTION_DAYS,
  TRACKING_EVENT_RETENTION_MONTHS,
  FINANCIAL_FACT_RETENTION_FY,
} from '../../src/modules/maintenance/retention-horizons';

const NOW = new Date('2026-08-07T12:00:00Z');

describe('§5.4 horizon constants (RV-12 single file)', () => {
  it('pins the §5.4 table values', () => {
    expect(RAW_WEBHOOK_PAYLOAD_RETENTION_DAYS).toBe(30);
    expect(REPORT_EXPORT_RETENTION_DAYS).toBe(30);
    expect(LABEL_MANIFEST_BUNDLE_RETENTION_DAYS).toBe(90);
    expect(TICKET_FEEDBACK_ATTACHMENT_RETENTION_DAYS).toBe(180);
    expect(TRACKING_EVENT_RETENTION_MONTHS).toBe(24);
    expect(FINANCIAL_FACT_RETENTION_FY).toBe(7);
  });
});

describe('daysCutoff (30d / 90d / 180d horizons)', () => {
  it('subtracts exact days', () => {
    expect(daysCutoff(NOW, 30).toISOString()).toBe('2026-07-08T12:00:00.000Z');
    expect(daysCutoff(NOW, 90).toISOString()).toBe('2026-05-09T12:00:00.000Z');
    expect(daysCutoff(NOW, 180).toISOString()).toBe('2026-02-08T12:00:00.000Z');
  });
});

describe('monthsCutoff (24-month tracking horizon)', () => {
  it('subtracts calendar months', () => {
    expect(monthsCutoff(NOW, 24).toISOString()).toBe('2024-08-07T12:00:00.000Z');
  });
  it('rolls across year boundaries', () => {
    expect(monthsCutoff(new Date('2026-02-15T00:00:00Z'), 24).toISOString()).toBe(
      '2024-02-15T00:00:00.000Z',
    );
  });
});

describe('financialYearStartContaining (§5.2 Indian FY, 1 Apr–31 Mar)', () => {
  it('31 Mar belongs to the FY that started the previous April', () => {
    expect(
      financialYearStartContaining(new Date('2026-03-31T23:59:59Z')).toISOString(),
    ).toBe('2025-04-01T00:00:00.000Z');
  });
  it('1 Apr 00:00 starts the new FY', () => {
    expect(
      financialYearStartContaining(new Date('2026-04-01T00:00:00Z')).toISOString(),
    ).toBe('2026-04-01T00:00:00.000Z');
  });
  it('mid-year maps to that April', () => {
    expect(
      financialYearStartContaining(new Date('2026-12-15T10:00:00Z')).toISOString(),
    ).toBe('2026-04-01T00:00:00.000Z');
  });
});

describe('financialRetentionCutoff (§5.4: 7 financial years)', () => {
  it('on 31 Mar the window is current FY + 6 prior FYs', () => {
    // FY2025 (2025-04-01..2026-03-31): retain FY2019..FY2025 → cutoff 2019-04-01.
    expect(
      financialRetentionCutoff(new Date('2026-03-31T23:59:59Z')).toISOString(),
    ).toBe('2019-04-01T00:00:00.000Z');
  });
  it('on 1 Apr the window rolls forward by one FY', () => {
    // FY2026: retain FY2020..FY2026 → cutoff 2020-04-01.
    expect(
      financialRetentionCutoff(new Date('2026-04-01T00:00:00Z')).toISOString(),
    ).toBe('2020-04-01T00:00:00.000Z');
  });
});

describe('expiredPartitionNames (§5.1/§5.4 drop vs row-delete selection)', () => {
  const names = [
    'tracking_event_raw_2026_06',
    'tracking_event_raw_2026_07',
    'tracking_event_raw_2026_08',
    'tracking_event_raw_default',
  ];

  it('drops only partitions entirely older than the cutoff', () => {
    // 30-day cutoff: 2026-07-08T12:00Z. The June partition covers
    // [06-01, 07-01) — fully older → expired. July straddles → kept.
    const cutoff = new Date('2026-07-08T12:00:00Z');
    expect(expiredPartitionNames(names, 'tracking_event_raw', cutoff)).toEqual([
      'tracking_event_raw_2026_06',
    ]);
  });

  it('never selects the default partition (row deletes handle it)', () => {
    const cutoff = new Date('2030-01-01T00:00:00Z');
    const expired = expiredPartitionNames(names, 'tracking_event_raw', cutoff);
    expect(expired).toEqual([
      'tracking_event_raw_2026_06',
      'tracking_event_raw_2026_07',
      'tracking_event_raw_2026_08',
    ]);
    expect(expired).not.toContain('tracking_event_raw_default');
  });

  it('scopes strictly to the named table', () => {
    const cutoff = new Date('2030-01-01T00:00:00Z');
    expect(
      expiredPartitionNames(
        ['tracking_event_2026_06', 'tracking_event_raw_2026_06'],
        'tracking_event',
        cutoff,
      ),
    ).toEqual(['tracking_event_2026_06']);
  });

  it('24-month horizon keeps recent partitions', () => {
    const cutoff = monthsCutoff(NOW, TRACKING_EVENT_RETENTION_MONTHS); // 2024-08-07
    expect(
      expiredPartitionNames(
        ['tracking_event_2024_07', 'tracking_event_2024_08', 'tracking_event_2026_08'],
        'tracking_event',
        cutoff,
      ),
    ).toEqual(['tracking_event_2024_07']);
  });
});

describe('partition naming + monthsToEnsure (§5.1)', () => {
  it('matches the DB helper naming {table}_{year}_{mm}', () => {
    expect(partitionName('shipment', { year: 2026, month: 8 })).toBe('shipment_2026_08');
    expect(partitionName('tracking_event', { year: 2027, month: 1 })).toBe(
      'tracking_event_2027_01',
    );
  });

  it('ensures the current month plus 3 ahead, rolling across years', () => {
    expect(monthsToEnsure(new Date('2026-11-15T00:00:00Z'), 3)).toEqual([
      { year: 2026, month: 11 },
      { year: 2026, month: 12 },
      { year: 2027, month: 1 },
      { year: 2027, month: 2 },
    ]);
  });
});
