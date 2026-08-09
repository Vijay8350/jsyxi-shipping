import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { AuditService } from '../../src/audit/audit.service';
import { ScreenGuideService } from '../../src/modules/admin/screen-guide.service';
import { makeActor, makeAudit, makePool, poolCalls } from './helpers';

/** ADD-33 screen guides: admin CRUD + the merchant-facing per-screen read. */

function makeService(queryImpl?: (sql: string, params: unknown[]) => unknown) {
  const { pool } = makePool(queryImpl);
  const audit = makeAudit();
  const service = new ScreenGuideService(pool as unknown as Pool, audit as unknown as AuditService);
  return { service, pool, audit };
}

describe('ScreenGuideService (ADD-33)', () => {
  it('upserts by surface_key and audits create vs update distinctly', async () => {
    const { service, pool, audit } = makeService((sql) => {
      if (sql.startsWith('SELECT guide_id, video_url, doc_text FROM screen_guide')) {
        return { rows: [], rowCount: 0 }; // no existing row → create
      }
      if (sql.includes('INSERT INTO screen_guide')) return { rows: [{ guide_id: 'g1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const { guideId } = await service.upsertGuide(makeActor(), 'rules', {
      videoUrl: 'https://cdn.example.com/rules.mp4',
      docText: 'How rules work',
    });
    expect(guideId).toBe('g1');
    const insert = poolCalls(pool).find((c) => c.sql.includes('INSERT INTO screen_guide'));
    expect(insert!.sql).toContain('ON CONFLICT (surface_key)');
    expect(insert!.params[0]).toBe('rules');
    // Live instantly + ownership: updated_by records the acting admin.
    expect(insert!.params[3]).toBe(makeActor().adminId);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin_screen_guide.created', objectId: 'g1' }),
    );
  });

  it('merchant read returns only the display fields; 404 for unknown surface', async () => {
    const { service } = makeService((sql) => {
      if (sql.includes('FROM screen_guide')) {
        return {
          rows: [{ surface_key: 'rules', video_url: 'v', doc_text: 'd', updated_at: 't' }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const guide = (await service.getGuide('rules')) as Record<string, unknown>;
    expect(guide).toEqual({ surface_key: 'rules', video_url: 'v', doc_text: 'd', updated_at: 't' });
    expect(guide).not.toHaveProperty('updated_by');

    const empty = makeService();
    await expect(empty.service.getGuide('nope')).rejects.toThrow('no guide for this surface');
  });

  it('delete audits the removed guide with its before image', async () => {
    const { service, audit } = makeService((sql) => {
      if (sql.includes('DELETE FROM screen_guide')) {
        return { rows: [{ guide_id: 'g1', video_url: 'v', doc_text: 'd' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    await service.deleteGuide(makeActor(), 'rules');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin_screen_guide.deleted',
        before: expect.objectContaining({ surface_key: 'rules' }),
      }),
    );
  });
});
