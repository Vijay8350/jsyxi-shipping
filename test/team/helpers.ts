import { vi } from 'vitest';
import { MemberRole } from '../../src/auth/session.types';
import { ShopMemberRow } from '../../src/modules/team/team.types';

export const SHOP_ID = '11111111-1111-1111-1111-111111111111';
export const OWNER_ID = '22222222-2222-2222-2222-222222222222';
export const MEMBER_ID = '33333333-3333-3333-3333-333333333333';
export const REQUEST_ID = '44444444-4444-4444-4444-444444444444';

export function memberRow(over: Partial<ShopMemberRow> = {}): ShopMemberRow {
  return {
    member_id: MEMBER_ID,
    shop_id: SHOP_ID,
    shopify_staff_user_id: 'staff-1',
    email: null,
    auth_source: 'SHOPIFY_STAFF',
    role: 'OPERATOR' as MemberRole,
    granted_by: OWNER_ID,
    granted_at: '2026-01-01T00:00:00Z',
    revoked_at: null,
    last_active_at: null,
    version: 3,
    ...over,
  };
}

/** A Pool mock where every query handler is matched on a SQL substring. */
export function mockPool() {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue(client),
  };
  return { pool, client };
}

/** Route mock queries by SQL substring. */
export function routeBySql(
  mock: ReturnType<typeof vi.fn>,
  routes: Array<[string, (params?: unknown[]) => unknown]>,
) {
  mock.mockImplementation((sql: string, params?: unknown[]) => {
    for (const [needle, handler] of routes) {
      if (sql.includes(needle)) return handler(params);
    }
    throw new Error(`unmocked query: ${sql}`);
  });
}

export const uniqueViolation = () =>
  Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
  });
