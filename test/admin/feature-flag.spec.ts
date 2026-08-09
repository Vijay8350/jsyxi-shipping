import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { AuditService } from '../../src/audit/audit.service';
import { FeatureFlagService } from '../../src/modules/admin/feature-flag.service';
import { makeActor, makeAudit, makePool, poolCalls, SHOP_ID } from './helpers';

/** §9.13 feature flags: GLOBAL / SHOP scope, upsert on (key, shop). */

function makeService(queryImpl?: (sql: string, params: unknown[]) => unknown) {
  const { pool } = makePool(queryImpl);
  const audit = makeAudit();
  const service = new FeatureFlagService(pool as unknown as Pool, audit as unknown as AuditService);
  return { service, pool, audit };
}

describe('FeatureFlagService (§9.13)', () => {
  it('SHOP scope requires a shop; GLOBAL scope forbids one', async () => {
    const { service } = makeService();
    await expect(
      service.upsertFlag(makeActor(), { key: 'ndr.whatsapp', scope: 'SHOP', enabled: true }),
    ).rejects.toThrow('shopId is required for SHOP scope');
    await expect(
      service.upsertFlag(makeActor(), { key: 'ndr.whatsapp', scope: 'GLOBAL', shopId: SHOP_ID, enabled: true }),
    ).rejects.toThrow('a GLOBAL flag never names a shop');
  });

  it('upserts GLOBAL with a null shop and audits the write', async () => {
    const { service, pool, audit } = makeService((sql) => {
      if (sql.includes('INSERT INTO feature_flag')) {
        return { rows: [{ flag_id: 'f1', was_update: false }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const { flagId } = await service.upsertFlag(makeActor(), {
      key: 'ndr.whatsapp',
      scope: 'GLOBAL',
      enabled: true,
    });
    expect(flagId).toBe('f1');
    const insert = poolCalls(pool).find((c) => c.sql.includes('INSERT INTO feature_flag'));
    expect(insert!.params[2]).toBeNull();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin_feature_flag.created', objectId: 'f1' }),
    );
  });
});
