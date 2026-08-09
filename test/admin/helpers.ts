import { vi } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { AuditService } from '../../src/audit/audit.service';
import { EnvelopeCipher } from '../../src/common/envelope';
import { AdminAuthService } from '../../src/modules/admin/admin-auth.service';
import { AdminContext } from '../../src/modules/admin/admin.types';

export const ADMIN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const SHOP_ID = '11111111-1111-1111-1111-111111111111';
export const COURIER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
export const MASTER_KEY_HEX = 'ab'.repeat(32);

export const cipher = EnvelopeCipher.fromHex(MASTER_KEY_HEX);

export interface MockClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

export interface MockPool {
  query: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
}

export function makePool(queryImpl?: (sql: string, params: unknown[]) => unknown): {
  pool: MockPool;
  client: MockClient;
} {
  const client: MockClient = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: vi.fn() };
  const pool: MockPool = {
    query: vi.fn(async (sql: string, params?: unknown[]) =>
      queryImpl ? queryImpl(sql, params ?? []) : { rows: [], rowCount: 0 },
    ),
    connect: vi.fn(async () => client as unknown as PoolClient),
  };
  return { pool, client };
}

export function makeAudit(): { record: ReturnType<typeof vi.fn> } {
  return { record: vi.fn(async () => undefined) };
}

export function makeConfig(): { get: (key: string) => string | undefined } {
  return {
    get: (key: string) =>
      ({
        'crypto.masterKeyHex': MASTER_KEY_HEX,
        'crypto.piiHashSalt': 'test-salt',
      })[key],
  };
}

export function makeAdminAuth(queryImpl?: (sql: string, params: unknown[]) => unknown) {
  const { pool, client } = makePool(queryImpl);
  const audit = makeAudit();
  const service = new AdminAuthService(
    pool as unknown as Pool,
    audit as unknown as AuditService,
    makeConfig() as never,
  );
  return { service, pool, client, audit };
}

export function makeActor(overrides: Partial<AdminContext> = {}): AdminContext {
  return { sessionId: 'admin-sess-1', adminId: ADMIN_ID, role: 'PLATFORM_ADMIN', ...overrides };
}

/** Every SQL + params issued to pool.query, flattened for assertions. */
export function poolCalls(pool: MockPool): Array<{ sql: string; params: unknown[] }> {
  return pool.query.mock.calls.map((c) => ({ sql: c[0] as string, params: (c[1] ?? []) as unknown[] }));
}

/** Serialized audit calls — assert a raw secret/PII value never appears. */
export function auditStrings(audit: { record: ReturnType<typeof vi.fn> }): string {
  return JSON.stringify(audit.record.mock.calls);
}
