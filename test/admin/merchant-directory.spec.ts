import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { MerchantDirectoryService } from '../../src/modules/admin/merchant-directory.service';
import { makePool, poolCalls, SHOP_ID } from './helpers';

/**
 * §9.13 merchant list + ADD-31 health board: the list carries plan, AWB
 * usage this cycle, courier health and the broken-item count, sortable by
 * 'most broken'. Read-only, no PII (§10.3). The service READS stored
 * setup_health_item rows (ADD-29) — it never computes health.
 */

function makeService(queryImpl?: (sql: string, params: unknown[]) => unknown) {
  const { pool } = makePool(queryImpl);
  return { service: new MerchantDirectoryService(pool as unknown as Pool), pool };
}

describe('MerchantDirectoryService.listMerchants (ADD-31)', () => {
  it('sorts by most broken = count of non-OK setup_health_item rows DESC', async () => {
    const { service, pool } = makeService(() => ({ rows: [], rowCount: 0 }));
    await service.listMerchants({ sort: 'most_broken', limit: 25, offset: 10 });
    const call = poolCalls(pool)[0];
    // ADD-31: the broken count is computed from stored ADD-29 rows only.
    expect(call.sql).toContain("FROM setup_health_item h");
    expect(call.sql).toContain("h.state <> 'OK'");
    expect(call.sql).toContain('ORDER BY broken_health_count DESC, s.myshopify_domain ASC');
    expect(call.params).toEqual([25, 10]);
  });

  it('defaults to domain order and clamps the page size', async () => {
    const { service, pool } = makeService(() => ({ rows: [], rowCount: 0 }));
    await service.listMerchants({ limit: 9999, offset: -5 });
    const call = poolCalls(pool)[0];
    expect(call.sql).toContain('ORDER BY s.myshopify_domain ASC');
    expect(call.params).toEqual([200, 0]);
  });

  it('AWB usage counts DEBITs in the current subscription cycle only', async () => {
    const { service, pool } = makeService(() => ({ rows: [], rowCount: 0 }));
    await service.listMerchants();
    const sql = poolCalls(pool)[0].sql;
    expect(sql).toContain('FROM awb_entitlement_ledger l');
    expect(sql).toContain("l.direction = 'DEBIT'");
    expect(sql).toContain('l.cycle_start_at = sub.cycle_start_at');
  });

  it('never selects credential or token columns (INV-18, §10.3 no-PII)', async () => {
    const { service, pool } = makeService(() => ({ rows: [], rowCount: 0 }));
    await service.listMerchants();
    const sql = poolCalls(pool)[0].sql.toLowerCase();
    expect(sql).not.toContain('credentials_');
    expect(sql).not.toContain('access_token');
    expect(sql).not.toContain('email');
  });
});

describe('MerchantDirectoryService.merchantDetail (ADD-31 detail panel)', () => {
  it('returns plan, usage, courier health and stored health items; 404 for unknown shop', async () => {
    const queries: string[] = [];
    const { service } = makeService((sql) => {
      queries.push(sql);
      if (sql.includes('FROM shop s')) {
        return {
          rows: [{
            shop_id: SHOP_ID,
            myshopify_domain: 'acme.myshopify.com',
            shop_currency: 'INR',
            iana_timezone: 'Asia/Kolkata',
            account_state: 'ACTIVE',
            installed_at: new Date(),
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM awb_entitlement_ledger')) return { rows: [{ awb_used: 42 }], rowCount: 1 };
      if (sql.includes('FROM subscription')) {
        return { rows: [{ subscription_id: 'sub1', state: 'ACTIVE', plan_code: 'growth', awb_allowance_per_cycle: 1000 }], rowCount: 1 };
      }
      if (sql.includes('FROM courier_account')) {
        return { rows: [{ courier_account_id: 'ca1', courier_code: 'delhivery', mode: 'LIVE', health_state: 'DEGRADED' }], rowCount: 1 };
      }
      if (sql.includes('FROM setup_health_item')) {
        return {
          rows: [
            { item_key: 'rate_card', state: 'MISSING', detail: 'no rate card uploaded' },
            { item_key: 'gstin', state: 'OK', detail: null },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const detail = (await service.merchantDetail(SHOP_ID)) as Record<string, unknown>;
    expect(detail['awb_used_this_cycle']).toBe(42);
    expect((detail['subscription'] as Record<string, unknown>)['plan_code']).toBe('growth');
    const health = detail['setup_health_items'] as Array<Record<string, unknown>>;
    expect(health).toHaveLength(2);
    // Courier account view carries identity + health, never credential columns.
    const courierSql = queries.find((q) => q.includes('FROM courier_account'))!.toLowerCase();
    expect(courierSql).not.toContain('credentials_test_encrypted');
    expect(courierSql).not.toContain('credentials_live_encrypted');
    expect(courierSql).not.toContain('webhook_secret_encrypted');

    const missing = makeService(() => ({ rows: [], rowCount: 0 }));
    await expect(missing.service.merchantDetail(SHOP_ID)).rejects.toThrow('shop not found');
  });
});
