import { describe, expect, it, vi } from 'vitest';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Pool } from 'pg';
import { AuditService } from '../../src/audit/audit.service';
import { SupportContextService } from '../../src/modules/admin/support-context.service';
import { SupportContextGuard, SUPPORT_CONTEXT_HEADER } from '../../src/modules/admin/support-context.guard';
import { MerchantDirectoryService } from '../../src/modules/admin/merchant-directory.service';
import { SupportContextInfo } from '../../src/modules/admin/admin.types';
import { makeActor, makeAudit, makePool, poolCalls, SHOP_ID } from './helpers';

/**
 * A1-07 / §10.3 support context: time-boxed (≤ 60 min), read-only enforced
 * by the guard, credential routes blocked by construction, expired contexts
 * dead, and every view audited with object ids only (§12).
 */

function makeService(queryImpl?: (sql: string, params: unknown[]) => unknown) {
  const { pool } = makePool(queryImpl);
  const audit = makeAudit();
  const merchants = new MerchantDirectoryService(pool as unknown as Pool);
  const service = new SupportContextService(
    pool as unknown as Pool,
    audit as unknown as AuditService,
    merchants,
  );
  return { service, pool, audit };
}

const LIVE: SupportContextInfo = {
  contextId: 'ctx-1',
  shopId: SHOP_ID,
  adminId: 'admin-1',
  ticketId: null,
  reason: 'merchant reports booking failures',
  startedAt: new Date(),
  expiresAt: new Date(Date.now() + 30 * 60_000),
};

describe('SupportContextService.open (A1-07)', () => {
  it('requires a reason or a ticket (mirrors the table CHECK)', async () => {
    const { service } = makeService();
    await expect(service.open(makeActor(), { shopId: SHOP_ID })).rejects.toThrow(
      'a support context needs a reason or a ticket',
    );
  });

  it('clamps the TTL to the 60-minute ceiling and audits the open', async () => {
    const { service, pool, audit } = makeService((sql) => {
      if (sql.includes('FROM shop')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (sql.includes('INSERT INTO support_context')) {
        return { rows: [{ context_id: 'ctx-1', started_at: new Date(), expires_at: new Date() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const ctx = await service.open(makeActor({ role: 'SUPPORT_AGENT' }), {
      shopId: SHOP_ID,
      reason: 'ticket follow-up',
      ttlMinutes: 600, // asked for 10 hours — the ceiling says no
    });
    const insert = poolCalls(pool).find((c) => c.sql.includes('INSERT INTO support_context'));
    expect(insert!.params[4]).toBe('60'); // clamped, never above §10.3's box
    expect(ctx.contextId).toBe('ctx-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'support_context.opened',
        shopId: SHOP_ID,
        after: expect.objectContaining({ ttl_minutes: 60 }),
      }),
    );
  });
});

describe('SupportContextService.resolveAlive / end', () => {
  it('dead contexts (expired or ended) fail closed', async () => {
    const { service } = makeService(() => ({ rows: [], rowCount: 0 }));
    expect(await service.resolveAlive('ctx-dead')).toBeNull();
  });

  it('end sets ended_at only on a live context and audits it', async () => {
    const { service, pool, audit } = makeService((sql) => {
      if (sql.includes('UPDATE support_context')) return { rows: [{ shop_id: SHOP_ID }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await service.end(makeActor(), 'ctx-1');
    const update = poolCalls(pool).find((c) => c.sql.includes('UPDATE support_context'));
    expect(update!.sql).toContain('ended_at = now()');
    expect(update!.sql).toContain('AND expires_at > now()');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'support_context.ended', objectId: 'ctx-1' }),
    );

    const dead = makeService(() => ({ rows: [], rowCount: 0 }));
    await expect(dead.service.end(makeActor(), 'ctx-1')).rejects.toThrow('already dead');
  });
});

describe('SupportContextGuard (read-only + credential exclusion, by construction)', () => {
  function fakeCtx(method: string, path: string, contextId?: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          method,
          path,
          headers: contextId ? { [SUPPORT_CONTEXT_HEADER]: contextId } : {},
        }),
      }),
    } as unknown as ExecutionContext;
  }

  function guardWith(ctx: SupportContextInfo | null): SupportContextGuard {
    const svc = { resolveAlive: vi.fn(async () => ctx) };
    return new SupportContextGuard(svc as unknown as SupportContextService);
  }

  it('passes requests without a support-context header untouched', async () => {
    await expect(guardWith(null).canActivate(fakeCtx('POST', '/admin/plans'))).resolves.toBe(true);
  });

  it('rejects a dead context with 401 — expired contexts are dead', async () => {
    await expect(
      guardWith(null).canActivate(fakeCtx('GET', '/admin/support/contexts/ctx-1/shop', 'ctx-1')),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects every non-GET while a context is active (read-only enforced)', async () => {
    const guard = guardWith(LIVE);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await expect(guard.canActivate(fakeCtx(method, '/admin/anything', 'ctx-1'))).rejects.toThrow(
        ForbiddenException,
      );
    }
    await expect(guard.canActivate(fakeCtx('GET', '/admin/anything', 'ctx-1'))).resolves.toBe(true);
  });

  it('blocks credential-adjacent routes even for GET (INV-18, §10.3)', async () => {
    const guard = guardWith(LIVE);
    const blocked = [
      '/api/shops/s1/courier-accounts/ca1/credentials',
      '/api/shops/s1/courier-accounts/ca1/credentials/rotate',
      '/admin/courier-accounts/ca1/webhook-secret',
    ];
    for (const path of blocked) {
      await expect(guard.canActivate(fakeCtx('GET', path, 'ctx-1'))).rejects.toThrow(
        'credentials are never visible inside a support context',
      );
    }
    // …while the non-credential courier-account view stays open.
    await expect(
      guard.canActivate(fakeCtx('GET', '/admin/support/contexts/ctx-1/courier-accounts', 'ctx-1')),
    ).resolves.toBe(true);
  });
});

describe('SupportContextService views (§12: everything viewed is audited)', () => {
  it('each view audits object ids only — never viewed content', async () => {
    const { service, audit } = makeService((sql) => {
      if (sql.includes('FROM shop s')) {
        return { rows: [{ shop_id: SHOP_ID, myshopify_domain: 'acme.myshopify.com' }], rowCount: 1 };
      }
      if (sql.includes('FROM setup_health_item')) {
        return { rows: [{ item_key: 'gstin', state: 'MISSING', detail: 'GSTIN absent' }], rowCount: 1 };
      }
      if (sql.includes('FROM courier_account')) {
        return { rows: [{ courier_account_id: 'ca1', courier_code: 'dtdc', health_state: 'HEALTHY' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await service.viewShopOverview(LIVE);
    await service.viewSetupHealth(LIVE);
    await service.viewCourierAccounts(LIVE);

    const views = audit.record.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e['action'] === 'support_context.viewed');
    expect(views).toHaveLength(3);
    for (const v of views) {
      expect(v['shopId']).toBe(SHOP_ID);
      expect(v['objectId']).toBe(SHOP_ID); // object ids only
      expect(JSON.stringify(v)).not.toContain('GSTIN absent'); // never content
      expect(JSON.stringify(v)).not.toContain('acme.myshopify.com');
    }
    expect(views.map((v) => v['objectType'])).toEqual([
      'shop',
      'setup_health_item',
      'courier_account',
    ]);
  });

  it('the courier-account view never selects credential columns', async () => {
    const { service, pool } = makeService(() => ({ rows: [], rowCount: 0 }));
    await service.viewCourierAccounts(LIVE);
    const sql = poolCalls(pool)
      .filter((c) => c.sql.includes('FROM courier_account'))
      .map((c) => c.sql.toLowerCase())
      .join('\n');
    expect(sql).not.toContain('credentials_test_encrypted');
    expect(sql).not.toContain('credentials_live_encrypted');
    expect(sql).not.toContain('webhook_secret_encrypted');
  });
});
