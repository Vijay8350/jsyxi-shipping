import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { AuditService } from '../../src/audit/audit.service';
import { PlanAdminService } from '../../src/modules/admin/plan-admin.service';
import { makeActor, makeAudit, makePool, poolCalls } from './helpers';

/**
 * §9.13 plan CRUD (PLATFORM_ADMIN / PLATFORM_FINANCE). Plan rows only —
 * Shopify Billing owns the charges (§9.14, INV-23). Money stays decimal
 * strings end-to-end (§4.1).
 */

function makeService(queryImpl?: (sql: string, params: unknown[]) => unknown) {
  const { pool } = makePool(queryImpl);
  const audit = makeAudit();
  const service = new PlanAdminService(pool as unknown as Pool, audit as unknown as AuditService);
  return { service, pool, audit };
}

describe('PlanAdminService (§9.13, §10.3)', () => {
  it('creates a plan with decimal-string prices and audits it', async () => {
    const { service, pool, audit } = makeService((sql) => {
      if (sql.includes('INSERT INTO plan')) return { rows: [{ plan_id: 'p1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const { planId } = await service.createPlan(makeActor(), {
      code: 'growth',
      name: 'Growth',
      awbAllowancePerCycle: 1000,
      price: '2499.00',
      overageUnitPrice: '2.5000',
      isTrial: false,
    });
    expect(planId).toBe('p1');
    const insert = poolCalls(pool).find((c) => c.sql.includes('INSERT INTO plan'));
    expect(insert!.params[3]).toBe('2499.00');
    expect(insert!.params[5]).toBe('2.5000');
    expect(insert!.params[4]).toBe('INR'); // INV-2
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin_plan.created',
        after: expect.objectContaining({ price: '2499.00', overage_unit_price: '2.5000' }),
      }),
    );
    // INV-23: no margin column exists and none is ever written.
    expect(insert!.sql).not.toContain('margin');
  });

  it('updates are partial (COALESCE) and audited with before/after', async () => {
    const before = {
      code: 'growth', name: 'Growth', awb_allowance_per_cycle: 1000,
      price: '2499.0000', overage_unit_price: '2.5000', is_trial: false, is_active: true,
    };
    const { service, pool, audit } = makeService((sql) => {
      if (sql.startsWith('SELECT code, name')) return { rows: [before], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    await service.updatePlan(makeActor({ role: 'PLATFORM_FINANCE' }), 'p1', { price: '2799.00' });
    const update = poolCalls(pool).find((c) => c.sql.includes('UPDATE plan'));
    expect(update!.sql).toContain('price = COALESCE($4::numeric, price)');
    expect(update!.params[3]).toBe('2799.00');
    expect(update!.params[1]).toBeNull(); // name untouched
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin_plan.updated', before, objectId: 'p1' }),
    );
  });

  it('404s updating an unknown plan', async () => {
    const { service } = makeService(() => ({ rows: [], rowCount: 0 }));
    await expect(service.updatePlan(makeActor(), 'nope', { price: '1.00' })).rejects.toThrow(
      'plan not found',
    );
  });
});
