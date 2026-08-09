import { describe, expect, it } from 'vitest';
import { NdrInboxService } from '../../src/modules/ndr/ndr-inbox.service';
import { FnPool, SHOP_ID } from './helpers';

/**
 * §9.8.1 inbox query: filters (state, reason, aging, Service, courier
 * account, §9.23 test/live), aging from first_ndr_at and the S-44 auto-RTO
 * warning flag. Everything is shop-scoped (INV-1) and parameterized.
 */

function mk() {
  const pool = new FnPool();
  const service = new NdrInboxService(pool.asPool());
  return { pool, service };
}

describe('NdrInboxService.inbox', () => {
  it('defaults to live-only (§9.23) and shop-scoped (INV-1)', async () => {
    const { pool, service } = mk();
    pool.on(/FROM ndr_case c/, []);

    await service.inbox(SHOP_ID, {});

    const call = pool.calls[0];
    expect(call.params[0]).toBe(SHOP_ID);
    expect(call.sql).toContain('c.shop_id = $1');
    expect(call.sql).toContain('s.is_test = $2');
    expect(call.params[1]).toBe(false);
  });

  it('applies state, reason, aging, service and courier-account filters as parameters', async () => {
    const { pool, service } = mk();
    pool.on(/FROM ndr_case c/, []);

    await service.inbox(SHOP_ID, {
      state: 'OPEN',
      reason: 'ADDRESS_ISSUE',
      agingMinDays: 2,
      agingMaxDays: 10,
      serviceId: 'svc-1',
      courierAccountId: 'ca-1',
      isTest: true,
    });

    const { sql, params } = pool.calls[0];
    expect(sql).toContain('c.state = $2::ndr_case_state');
    expect(sql).toContain('c.reason_code = $3::ndr_reason');
    expect(params).toEqual([
      SHOP_ID,
      'OPEN',
      'ADDRESS_ISSUE',
      2,
      10,
      'svc-1',
      'ca-1',
      true, // isTest honored — NDR actions work on test shipments (INV-19)
      100, // default limit
      0, // default offset
    ]);
    expect(sql).toContain("c.first_ndr_at <= now() - ($4 || ' days')::interval");
    expect(sql).toContain("c.first_ndr_at >= now() - ($5 || ' days')::interval");
  });

  it('computes aging from first_ndr_at and the S-44 warn flag (now > auto_rto_warn_at, not CLOSED)', async () => {
    const { pool, service } = mk();
    pool.on(/FROM ndr_case c/, [
      {
        ndr_case_id: 'c1',
        shipment_id: 's1',
        awb_normalized: 'DL1',
        state: 'OPEN',
        reason_code: 'OTHER',
        attempt_count: 2,
        first_ndr_at: '2026-08-01T10:00:00.000Z',
        last_ndr_at: '2026-08-02T10:00:00.000Z',
        aging_hours: 50,
        auto_rto_warn: true,
        service_id: null,
        service_name: null,
        courier_account_id: null,
        is_test: false,
      },
    ]);

    const rows = await service.inbox(SHOP_ID, {});

    const { sql } = pool.calls[0];
    // §3.10: aging measured from first_ndr_at; warn fires past S-44 while not CLOSED.
    expect(sql).toContain('now() - c.first_ndr_at');
    expect(sql).toContain("c.state <> 'CLOSED'");
    expect(sql).toContain('now() > c.auto_rto_warn_at');
    expect(rows[0].aging_hours).toBe(50);
    expect(rows[0].auto_rto_warn).toBe(true);
    expect(rows[0].attempt_count).toBe(2);
  });

  it('caps the limit at 500', async () => {
    const { pool, service } = mk();
    pool.on(/FROM ndr_case c/, []);

    await service.inbox(SHOP_ID, { limit: 5000 });

    expect(pool.calls[0].params).toContain(500);
  });
});
