import { describe, expect, it } from 'vitest';
import { REPORT_GENERATORS } from '../../src/modules/reports/generators';
import { REPORT_CATALOGUE } from '../../src/modules/reports/report-catalogue';
import { REPORT_CODES, ReportContext } from '../../src/modules/reports/reports.types';
import { FnPool, SHOP_ID } from './helpers';

/**
 * Cross-cutting generator guarantees (§5.2, §9.23, INV-1):
 *  - every report query is shop-scoped;
 *  - every report query is bounded by the job's as-of (immutable snapshot);
 *  - the §9.23 include-test filter defaults OFF and disappears when ON.
 */
const AS_OF = new Date('2026-08-05T19:57:58.855Z');

function ctx(includeTest: boolean, filters: Record<string, unknown> = {}): ReportContext {
  return {
    shopId: SHOP_ID,
    asOf: AS_OF,
    timezone: 'Asia/Kolkata',
    filters: { includeTest, ...filters },
  };
}

async function runAll(includeTest: boolean) {
  const pool = new FnPool();
  for (const code of REPORT_CODES) {
    const data = await REPORT_GENERATORS[code](pool, ctx(includeTest));
    // Emitted row width always matches the catalogue columns.
    for (const row of data.rows) {
      expect(row.length).toBe(REPORT_CATALOGUE[code].columns.length);
    }
    expect(data.columns).toEqual(REPORT_CATALOGUE[code].columns);
  }
  return pool;
}

describe('report generators — snapshot and tenancy guarantees', () => {
  it('every generator query is shop-scoped (INV-1)', async () => {
    const pool = await runAll(false);
    expect(pool.calls.length).toBeGreaterThanOrEqual(REPORT_CODES.length);
    for (const call of pool.calls) {
      expect(call.sql).toContain('shop_id');
      expect(call.params).toContain(SHOP_ID);
    }
  });

  it('every generator bounds its query by the as-of instant (§5.2 immutable snapshot)', async () => {
    const pool = await runAll(false);
    for (const call of pool.calls) {
      expect(call.params.map(String)).toContain(AS_OF.toISOString());
    }
  });

  it('§9.23: test rows are excluded by default', async () => {
    const pool = await runAll(false);
    for (const call of pool.calls) {
      expect(call.sql).toMatch(/is_test(?:_order)?\)?,?\s*(?:false)|= false/);
    }
  });

  it('§9.23: include-test ON lifts the exclusion', async () => {
    const pool = await runAll(true);
    for (const call of pool.calls) {
      expect(call.sql).not.toMatch(/= false/);
    }
  });

  it('shared filters become parameterized predicates (never interpolated)', async () => {
    const pool = new FnPool();
    await REPORT_GENERATORS.SHIPMENTS(
      pool,
      ctx(false, {
        dateFrom: '2026-07-01',
        dateTo: '2026-07-31',
        serviceId: '66666666-6666-6666-6666-666666666661',
        courierAccountId: '88888888-8888-8888-8888-888888888881',
        paymentMode: 'COD',
        status: 'DELIVERED',
      }),
    );
    const call = pool.calls[0]!;
    expect(call.sql).toContain('s.service_id = $');
    expect(call.sql).toContain('s.courier_account_id = $');
    expect(call.sql).toContain(`s.movement_state = $`);
    expect(call.sql).not.toContain("'COD'"); // parameterized, not inlined
    expect(call.params).toContain('2026-07-01');
    expect(call.params).toContain('2026-07-31');
    expect(call.params).toContain('COD');
    expect(call.params).toContain('DELIVERED');
    // §5.2: shop-local date range rendered half-open via AT TIME ZONE.
    expect(call.sql).toContain('AT TIME ZONE');
    expect(call.params).toContain('Asia/Kolkata');
  });

  it('RECON_DISPUTES / COD_PENDING translate a missing §2.7 table into the typed error', async () => {
    const missingTablePool = {
      query: () => {
        const err = new Error('relation "recon_freight_row" does not exist') as Error & { code: string };
        err.code = '42P01';
        return Promise.reject(err);
      },
    };
    await expect(REPORT_GENERATORS.RECON_DISPUTES(missingTablePool, ctx(false))).rejects.toMatchObject({
      name: 'ReportSourceUnavailableError',
      reportCode: 'RECON_DISPUTES',
    });
    await expect(REPORT_GENERATORS.COD_PENDING(missingTablePool, ctx(false))).rejects.toMatchObject({
      name: 'ReportSourceUnavailableError',
      reportCode: 'COD_PENDING',
    });
  });

  it('RECON_DISPUTES rethrows non-42P01 errors untouched', async () => {
    const boom = {
      query: () => Promise.reject(Object.assign(new Error('connection lost'), { code: '08006' })),
    };
    await expect(REPORT_GENERATORS.RECON_DISPUTES(boom, ctx(false))).rejects.toThrow('connection lost');
  });

  it('ORDERS derives F-22 through the order-derivation module and counts shipments', async () => {
    const pool = new FnPool();
    pool.on(/FROM "order" o/, [
      {
        order_id: 'o1',
        order_number: '#1001',
        created_at: '2026-08-01T10:00:00+00:00',
        order_amount: '1250.50',
        payment_mode: 'COD',
        order_state: 'FULLY_BOOKED',
        cod_outstanding: '1250.50',
        cod_assignment_state: 'ASSIGNED',
      },
    ]);
    pool.on(/FROM shipment s/, [
      { order_id: 'o1', booking_state: 'CONFIRMED', movement_state: 'DELIVERED', custody_state: 'IN_CUSTODY' },
    ]);
    const data = await REPORT_GENERATORS.ORDERS(pool, ctx(false));
    expect(data.rows[0]).toEqual([
      '#1001', '2026-08-01T10:00:00+00:00', '1250.50', 'COD',
      'DELIVERED', '1', '1250.50', 'ASSIGNED',
    ]);
    // The as-of bound also applies to the shipment-state fetch.
    expect(pool.calls[1]!.params.map(String)).toContain(AS_OF.toISOString());
  });

  it('COURIER_PERF computes F-16 ratios with open shipments out of both terms', async () => {
    const pool = new FnPool();
    pool.on(/FROM shipment s/, [
      {
        key: 'Delhivery Surface', zone: null, volume: '10', open_count: '2',
        delivered: '6', rto_delivered: '2', terminal: '8', picked_up: '9',
        with_ndr: '3', avg_tat_hours: '52.5',
      },
    ]);
    const data = await REPORT_GENERATORS.COURIER_PERF(pool, ctx(false));
    expect(data.rows[0]).toEqual([
      'Delhivery Surface', '10', '2',
      '0.7500', // F-16.a: 6 ÷ (6+2)
      '0.3333', // F-16.b: 3 ÷ 9
      '0.2500', // F-16.c: 2 ÷ 8
      '52.5',
    ]);
  });

  it('F-16 ratios are null, never a fake zero, when the denominator is zero', async () => {
    const pool = new FnPool();
    pool.on(/FROM shipment s/, [
      {
        key: 'X', zone: null, volume: '1', open_count: '1',
        delivered: '0', rto_delivered: '0', terminal: '0', picked_up: '0',
        with_ndr: '0', avg_tat_hours: null,
      },
    ]);
    const data = await REPORT_GENERATORS.COURIER_PERF(pool, ctx(false));
    expect(data.rows[0]![3]).toBeNull();
    expect(data.rows[0]![4]).toBeNull();
    expect(data.rows[0]![5]).toBeNull();
  });
});
