import { vi } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { AuditService } from '../../src/audit/audit.service';
import { SessionService } from '../../src/auth/session.service';
import { SessionContext } from '../../src/auth/session.types';
import { EnvelopeCipher } from '../../src/common/envelope';
import { NativeAuthService } from '../../src/modules/native-auth/native-auth.service';

export const SHOP_ID = '11111111-1111-1111-1111-111111111111';
export const MEMBER_ID = '22222222-2222-2222-2222-222222222222';
export const OWNER_ID = '33333333-3333-3333-3333-333333333333';
export const MASTER_KEY_HEX = 'ab'.repeat(32);

export const cipher = EnvelopeCipher.fromHex(MASTER_KEY_HEX);

export interface MockClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

export interface TestHarness {
  service: NativeAuthService;
  pool: { query: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> };
  client: MockClient;
  sessions: { create: ReturnType<typeof vi.fn>; invalidateMember: ReturnType<typeof vi.fn>; invalidateSession: ReturnType<typeof vi.fn> };
  audit: { record: ReturnType<typeof vi.fn> };
}

export function makeSession(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: 'sess-1',
    shopId: SHOP_ID,
    memberId: OWNER_ID,
    role: 'OWNER',
    authSource: 'SHOPIFY_STAFF',
    ...overrides,
  };
}

export function makeHarness(queryImpl?: (sql: string, params: unknown[]) => unknown): TestHarness {
  const client: MockClient = { query: vi.fn(), release: vi.fn() };
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) =>
      queryImpl ? queryImpl(sql, params ?? []) : { rows: [], rowCount: 0 },
    ),
    connect: vi.fn(async () => client as unknown as PoolClient),
  };
  const sessions = {
    create: vi.fn(async (input: { shopId: string; memberId: string; role: string; authSource: string }) => ({
      token: 'sess-token',
      context: {
        sessionId: 'sess-new',
        shopId: input.shopId,
        memberId: input.memberId,
        role: input.role,
        authSource: input.authSource,
      },
    })),
    invalidateMember: vi.fn(async () => undefined),
    invalidateSession: vi.fn(async () => undefined),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const config = {
    get: (key: string) =>
      ({
        'crypto.masterKeyHex': MASTER_KEY_HEX,
        'crypto.piiHashSalt': 'test-salt',
        'session.ttlSeconds': 43200,
      })[key],
  };
  const service = new NativeAuthService(
    pool as unknown as Pool,
    sessions as unknown as SessionService,
    audit as unknown as AuditService,
    config as never,
  );
  return { service, pool, client, sessions, audit };
}

/** Every SQL + params issued to pool.query, flattened for assertions. */
export function poolCalls(h: TestHarness): Array<{ sql: string; params: unknown[] }> {
  return h.pool.query.mock.calls.map((c) => ({ sql: c[0] as string, params: (c[1] ?? []) as unknown[] }));
}

/** Assert a raw secret/PII value never reached the audit log. */
export function auditArgStrings(h: TestHarness): string {
  return JSON.stringify(h.audit.record.mock.calls);
}
