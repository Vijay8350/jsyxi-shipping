import { vi } from 'vitest';
import { TicketRow } from '../../src/modules/support/support.types';

export const SHOP_ID = '11111111-1111-1111-1111-111111111111';
export const SHOP_B_ID = '55555555-5555-5555-5555-555555555555';
export const MEMBER_ID = '33333333-3333-3333-3333-333333333333';
export const MEMBER_B_ID = '66666666-6666-6666-6666-666666666666';
export const ADMIN_ID = '77777777-7777-7777-7777-777777777777';
export const TICKET_ID = '44444444-4444-4444-4444-444444444444';
export const ANNOUNCEMENT_ID = '88888888-8888-8888-8888-888888888888';

export function ticketRow(over: Partial<TicketRow> = {}): TicketRow {
  return {
    ticket_id: TICKET_ID,
    shop_id: SHOP_ID,
    number: 'TKT-1',
    category: 'BUG',
    priority: 'NORMAL',
    subject: 'Label fails to download',
    state: 'OPEN',
    assigned_admin_id: null,
    linked_order_id: null,
    linked_awb: null,
    created_at: '2026-08-01T00:00:00.000Z',
    first_response_at: null,
    resolved_at: null,
    version: 1,
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

/**
 * Route mock queries by SQL substring, first match wins. NOTE: put longer
 * needles first — 'INSERT INTO ticket' is a prefix of
 * 'INSERT INTO ticket_message'.
 */
export function routeBySql(
  mock: ReturnType<typeof vi.fn>,
  routes: Array<[string, (params?: unknown[]) => unknown]>,
) {
  mock.mockImplementation((sql: string, params?: unknown[]) => {
    // Transaction control is answered for every routed mock.
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql.trim())) {
      return { rows: [] };
    }
    for (const [needle, handler] of routes) {
      if (sql.includes(needle)) return handler(params);
    }
    throw new Error(`unmocked query: ${sql}`);
  });
}
