import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { AuditService } from '../../src/audit/audit.service';
import { DlqAdminService } from '../../src/modules/admin/dlq-admin.service';
import { makeActor, makeAudit, makePool, SHOP_ID } from './helpers';

/**
 * §8.6 / §3.17 DLQ replay: outbox-backed items return to PENDING, the item is
 * marked replayed_at + replayed_by, and every replay is audited (§12, A1-10).
 */

const ITEM = {
  dlq_id: 'd1',
  shop_id: SHOP_ID,
  queue: 'shopify-sync',
  payload: { outbox_id: 'ob1' },
  replayed_at: null,
};

function makeService(queryImpl?: (sql: string, params: unknown[]) => unknown) {
  const { pool, client } = makePool(queryImpl);
  const audit = makeAudit();
  const service = new DlqAdminService(pool as unknown as Pool, audit as unknown as AuditService);
  return { service, pool, client, audit };
}

describe('DlqAdminService.replay (§8.6, §3.17)', () => {
  it('returns the DEAD sync_outbox row to PENDING and marks the item replayed, atomically', async () => {
    const { service, client, audit } = makeService((sql) => {
      if (sql.includes('FROM dlq_item')) return { rows: [ITEM], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE sync_outbox')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const result = await service.replay(makeActor(), 'd1');
    expect(result.outboxReturnedToPending).toBe(true);

    const sql = client.query.mock.calls.map((c) => c[0] as string);
    expect(sql[0]).toBe('BEGIN');
    const outbox = client.query.mock.calls.find((c) => (c[0] as string).includes('UPDATE sync_outbox'));
    expect(outbox![0]).toContain("SET state = 'PENDING'");
    expect(outbox![0]).toContain("AND state = 'DEAD'");
    expect(outbox![1]).toEqual(['ob1', SHOP_ID]); // shop-scoped row check (INV-1)
    const mark = client.query.mock.calls.find((c) => (c[0] as string).includes('UPDATE dlq_item'));
    expect(mark![0]).toContain('replayed_at = now()');
    expect(mark![1]).toEqual(['d1', makeActor().adminId]);
    expect(sql[sql.length - 1]).toBe('COMMIT');

    // §12: DLQ replay is on the always-audited list.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'dlq.replayed',
        shopId: SHOP_ID,
        actorKind: 'ADMIN',
        objectType: 'dlq_item',
        objectId: 'd1',
        after: expect.objectContaining({ outbox_returned_to_pending: true }),
      }),
    );
  });

  it('marks non-outbox queues replayed without touching sync_outbox', async () => {
    const { service, client } = makeService((sql) => {
      if (sql.includes('FROM dlq_item')) {
        return { rows: [{ ...ITEM, queue: 'notifications', payload: {} }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const result = await service.replay(makeActor(), 'd1');
    expect(result.outboxReturnedToPending).toBe(false);
    const touched = client.query.mock.calls.some((c) => (c[0] as string).includes('UPDATE sync_outbox'));
    expect(touched).toBe(false);
  });

  it('refuses a double replay (409) and 404s unknown items', async () => {
    const replayed = makeService((sql) => {
      if (sql.includes('FROM dlq_item')) return { rows: [{ ...ITEM, replayed_at: new Date() }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(replayed.service.replay(makeActor(), 'd1')).rejects.toThrow('already replayed');

    const missing = makeService();
    await expect(missing.service.replay(makeActor(), 'nope')).rejects.toThrow('dlq item not found');
  });

  it('lists items per shop / queue with replayed items hidden by default', async () => {
    const { service, pool } = makeService();
    await service.listItems({ shopId: SHOP_ID, queue: 'shopify-sync' });
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('($3::boolean OR replayed_at IS NULL)');
    expect(call[1]).toEqual([SHOP_ID, 'shopify-sync', false, 50, 0]);
  });
});
