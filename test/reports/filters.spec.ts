import { describe, expect, it } from 'vitest';
import { normalizeFilters } from '../../src/modules/reports/reports.service';

/** §11 shared-filter normalization; §9.23 include-test default. */
describe('normalizeFilters', () => {
  it('defaults include-test OFF (§9.23)', () => {
    expect(normalizeFilters(undefined)).toEqual({ includeTest: false });
    expect(normalizeFilters(null)).toEqual({ includeTest: false });
    expect(normalizeFilters({})).toEqual({ includeTest: false });
  });

  it('accepts the §11 shared filter set', () => {
    const f = normalizeFilters({
      dateFrom: '2026-07-01',
      dateTo: '2026-07-31',
      serviceId: '66666666-6666-6666-6666-666666666661',
      courierAccountId: '88888888-8888-8888-8888-888888888881',
      paymentMode: 'COD',
      status: 'DELIVERED',
      includeTest: true,
    });
    expect(f.includeTest).toBe(true);
    expect(f.dateFrom).toBe('2026-07-01');
    expect(f.paymentMode).toBe('COD');
  });

  it('rejects unknown filters (the v1-hidden warehouse filter included, A4-02)', () => {
    expect(() => normalizeFilters({ warehouseId: 'x' })).toThrow(/unknown report filter/);
  });

  it('rejects malformed dates, inverted ranges, bad uuids and non-boolean includeTest', () => {
    expect(() => normalizeFilters({ dateFrom: '01/07/2026' })).toThrow(/YYYY-MM-DD/);
    expect(() => normalizeFilters({ dateFrom: '2026-08-01', dateTo: '2026-07-01' })).toThrow(/after dateTo/);
    expect(() => normalizeFilters({ serviceId: 'not-a-uuid' })).toThrow(/uuid/);
    expect(() => normalizeFilters({ includeTest: 'yes' })).toThrow(/boolean/);
    expect(() => normalizeFilters({ paymentMode: 'UPI' })).toThrow(/PREPAID/);
  });
});
