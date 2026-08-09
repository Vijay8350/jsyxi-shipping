import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TicketService } from '../../src/modules/support/ticket.service';
import {
  ADMIN_ID,
  MEMBER_B_ID,
  MEMBER_ID,
  mockPool,
  routeBySql,
  SHOP_ID,
  TICKET_ID,
  ticketRow,
} from './helpers';

const CREATE_DTO = {
  category: 'BUG' as const,
  subject: 'Label fails to download',
  description: 'Clicking download does nothing.',
};

describe('TicketService (§9.18, §3.16)', () => {
  let pool: ReturnType<typeof mockPool>['pool'];
  let client: ReturnType<typeof mockPool>['client'];
  let notifications: { notify: ReturnType<typeof vi.fn> };
  let service: TicketService;

  beforeEach(() => {
    ({ pool, client } = mockPool());
    notifications = { notify: vi.fn().mockResolvedValue({ delivered: 1 }) };
    service = new TicketService(pool as never, notifications as never);
  });

  describe('createTicket — TKT-{seq} numbering (§13.5)', () => {
    it('allocates the next per-shop sequence under the shop row lock', async () => {
      routeBySql(client.query, [
        ['INSERT INTO ticket_message', () => ({ rows: [] })],
        ['FOR UPDATE', () => ({ rows: [{ shop_id: SHOP_ID }] })],
        ['next_seq', () => ({ rows: [{ next_seq: '7' }] })],
        [
          'INSERT INTO ticket',
          () => ({ rows: [ticketRow({ number: 'TKT-7' })] }),
        ],
      ]);
      const ticket = await service.createTicket(SHOP_ID, MEMBER_ID, CREATE_DTO);
      expect(ticket.number).toBe('TKT-7');

      const lock = client.query.mock.calls.find(([sql]) =>
        String(sql).includes('FOR UPDATE'),
      );
      expect(lock?.[1]).toEqual([SHOP_ID]);

      const insert = client.query.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO ticket'),
      );
      // shop_id, number, category, priority (§3.16 default NORMAL), subject, …
      expect(insert?.[1]).toEqual([
        SHOP_ID,
        'TKT-7',
        'BUG',
        'NORMAL',
        CREATE_DTO.subject,
        null,
        null,
      ]);

      // The description opens the thread as the first MEMBER message.
      const message = client.query.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO ticket_message'),
      );
      expect(message?.[1]?.[1]).toBe(MEMBER_ID);
      expect(message?.[1]?.[2]).toBe(CREATE_DTO.description);
    });

    it('starts at TKT-1 for a shop with no tickets', async () => {
      routeBySql(client.query, [
        ['INSERT INTO ticket_message', () => ({ rows: [] })],
        ['FOR UPDATE', () => ({ rows: [{ shop_id: SHOP_ID }] })],
        ['next_seq', () => ({ rows: [{ next_seq: '1' }] })],
        ['INSERT INTO ticket', () => ({ rows: [ticketRow()] })],
      ]);
      const ticket = await service.createTicket(SHOP_ID, MEMBER_ID, CREATE_DTO);
      expect(ticket.number).toBe('TKT-1');
    });
  });

  describe('createTicket — linked Order / AWB (INV-1)', () => {
    it('rejects a linked order outside the shop', async () => {
      routeBySql(pool.query, [
        ['FROM "order"', () => ({ rows: [], rowCount: 0 })],
      ]);
      await expect(
        service.createTicket(SHOP_ID, MEMBER_ID, {
          ...CREATE_DTO,
          linkedOrderId: '99999999-9999-9999-9999-999999999999',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('normalizes the AWB (F-19) and rejects one that does not resolve in-shop', async () => {
      routeBySql(pool.query, [
        ['awb_normalized', () => ({ rows: [], rowCount: 0 })],
      ]);
      await expect(
        service.createTicket(SHOP_ID, MEMBER_ID, {
          ...CREATE_DTO,
          linkedAwb: 'abc 123-x',
        }),
      ).rejects.toThrow(BadRequestException);
      const lookup = pool.query.mock.calls.find(([sql]) =>
        String(sql).includes('awb_normalized'),
      );
      expect(lookup?.[1]).toEqual([SHOP_ID, 'ABC123X']);
    });

    it('stores the normalized AWB when it resolves in-shop', async () => {
      routeBySql(pool.query, [
        ['awb_normalized', () => ({ rows: [{ '?column?': 1 }], rowCount: 1 })],
      ]);
      routeBySql(client.query, [
        ['INSERT INTO ticket_message', () => ({ rows: [] })],
        ['FOR UPDATE', () => ({ rows: [{ shop_id: SHOP_ID }] })],
        ['next_seq', () => ({ rows: [{ next_seq: '1' }] })],
        [
          'INSERT INTO ticket',
          () => ({ rows: [ticketRow({ linked_awb: 'ABC123X' })] }),
        ],
      ]);
      const ticket = await service.createTicket(SHOP_ID, MEMBER_ID, {
        ...CREATE_DTO,
        linkedAwb: 'abc 123-x',
      });
      expect(ticket.linked_awb).toBe('ABC123X');
      const insert = client.query.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO ticket'),
      );
      expect(insert?.[1]?.[6]).toBe('ABC123X');
    });
  });

  describe('§3.16 state machine', () => {
    it('a MEMBER reply on RESOLVED reopens to IN_PROGRESS and clears resolved_at', async () => {
      const resolved = ticketRow({ state: 'RESOLVED', resolved_at: '2026-08-02T00:00:00.000Z' });
      routeBySql(pool.query, [
        ['FROM ticket WHERE ticket_id = $1 AND shop_id = $2', () => ({ rows: [resolved] })],
        ['SELECT DISTINCT author_id', () => ({ rows: [{ author_id: MEMBER_ID }] })],
      ]);
      routeBySql(client.query, [
        ['INSERT INTO ticket_message', () => ({ rows: [{ message_id: 'm1' }] })],
        [
          "SET state = 'IN_PROGRESS'",
          () => ({ rows: [ticketRow({ state: 'IN_PROGRESS', version: 2 })] }),
        ],
      ]);
      const { ticket } = await service.replyAsMember(SHOP_ID, MEMBER_ID, TICKET_ID, {
        body: 'Still broken.',
      });
      expect(ticket.state).toBe('IN_PROGRESS');
      const reopen = client.query.mock.calls.find(([sql]) =>
        String(sql).includes("SET state = 'IN_PROGRESS'"),
      );
      expect(String(reopen?.[0])).toContain('resolved_at = NULL');
    });

    it('a MEMBER reply on CLOSED is rejected — CLOSED is terminal (§3.16)', async () => {
      routeBySql(pool.query, [
        [
          'FROM ticket WHERE ticket_id = $1 AND shop_id = $2',
          () => ({ rows: [ticketRow({ state: 'CLOSED' })] }),
        ],
      ]);
      await expect(
        service.replyAsMember(SHOP_ID, MEMBER_ID, TICKET_ID, { body: 'x' }),
      ).rejects.toThrow(ConflictException);
      expect(client.query).not.toHaveBeenCalled();
    });

    it('admin transition OPEN → RESOLVED does not exist (§3 preamble)', async () => {
      routeBySql(pool.query, [
        ['FROM ticket WHERE ticket_id = $1', () => ({ rows: [ticketRow()] })],
      ]);
      await expect(
        service.transitionTicket(ADMIN_ID, TICKET_ID, { to: 'RESOLVED', version: 1 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('admin transition IN_PROGRESS → RESOLVED sets resolved_at (RW-07)', async () => {
      const inProgress = ticketRow({ state: 'IN_PROGRESS', version: 3 });
      routeBySql(pool.query, [
        ['FROM ticket WHERE ticket_id = $1', () => ({ rows: [inProgress] })],
        [
          'SET state = $3',
          (params) => {
            expect(params).toEqual([TICKET_ID, 3, 'RESOLVED', 'IN_PROGRESS']);
            return {
              rows: [
                ticketRow({
                  state: 'RESOLVED',
                  resolved_at: '2026-08-03T00:00:00.000Z',
                  version: 4,
                }),
              ],
            };
          },
        ],
      ]);
      // 'SET state = $3' also matches the find query? No — find uses SELECT.
      const ticket = await service.transitionTicket(ADMIN_ID, TICKET_ID, {
        to: 'RESOLVED',
        version: 3,
      });
      expect(ticket.state).toBe('RESOLVED');
      expect(ticket.resolved_at).not.toBeNull();
    });

    it('CLOSED has no exit — even an admin transition is rejected', async () => {
      routeBySql(pool.query, [
        [
          'FROM ticket WHERE ticket_id = $1',
          () => ({ rows: [ticketRow({ state: 'CLOSED' })] }),
        ],
      ]);
      await expect(
        service.transitionTicket(ADMIN_ID, TICKET_ID, { to: 'IN_PROGRESS', version: 1 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('INV-22: a stale version on assignment is a 409 with the current state', async () => {
      routeBySql(pool.query, [
        [
          'SET assigned_admin_id',
          () => ({ rows: [] }), // version guard matched nothing
        ],
        [
          'FROM ticket WHERE ticket_id = $1',
          () => ({ rows: [ticketRow({ version: 5 })] }),
        ],
      ]);
      await expect(
        service.assignTicket(ADMIN_ID, TICKET_ID, {
          assignedAdminId: ADMIN_ID,
          version: 1,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('reply notification (§9.21 ticket.reply, INV-21)', () => {
    function routedOpenTicket(participants: string[] = [MEMBER_ID, MEMBER_B_ID]) {
      routeBySql(pool.query, [
        [
          'FROM ticket WHERE ticket_id = $1 AND shop_id = $2',
          () => ({ rows: [ticketRow({ state: 'OPEN' })] }),
        ],
        [
          'SELECT DISTINCT author_id',
          () => ({ rows: participants.map((author_id) => ({ author_id })) }),
        ],
      ]);
      routeBySql(client.query, [
        ['INSERT INTO ticket_message', () => ({ rows: [{ message_id: 'm1' }] })],
      ]);
    }

    it('fires ticket.reply with the thread participants minus the replier', async () => {
      routedOpenTicket();
      await service.replyAsMember(SHOP_ID, MEMBER_ID, TICKET_ID, { body: 'more info' });
      expect(notifications.notify).toHaveBeenCalledWith(
        SHOP_ID,
        'ticket.reply',
        expect.objectContaining({
          participantMemberIds: [MEMBER_B_ID],
          subject: expect.stringContaining('TKT-1'),
        }),
      );
    });

    it('an admin reply notifies all member participants', async () => {
      routeBySql(pool.query, [
        ['FROM ticket WHERE ticket_id = $1', () => ({ rows: [ticketRow()] })],
        [
          'SELECT DISTINCT author_id',
          () => ({ rows: [{ author_id: MEMBER_ID }, { author_id: MEMBER_B_ID }] }),
        ],
      ]);
      routeBySql(client.query, [
        ['INSERT INTO ticket_message', () => ({ rows: [{ message_id: 'm2' }] })],
        ['first_response_at', () => ({ rows: [ticketRow({ state: 'IN_PROGRESS' })] })],
      ]);
      await service.replyAsAdmin(ADMIN_ID, TICKET_ID, { body: 'looking into it' });
      expect(notifications.notify).toHaveBeenCalledWith(
        SHOP_ID,
        'ticket.reply',
        expect.objectContaining({
          participantMemberIds: [MEMBER_ID, MEMBER_B_ID],
        }),
      );
    });

    it('a notification failure never gates the reply (INV-21)', async () => {
      notifications.notify.mockRejectedValue(new Error('smtp down'));
      routedOpenTicket();
      const result = await service.replyAsMember(SHOP_ID, MEMBER_ID, TICKET_ID, {
        body: 'more info',
      });
      expect(result.message).toEqual({ message_id: 'm1' });
    });
  });

  describe('admin reply — first response (RW-07)', () => {
    it('sets first_response_at via COALESCE on the first ADMIN message only', async () => {
      routeBySql(pool.query, [
        ['FROM ticket WHERE ticket_id = $1', () => ({ rows: [ticketRow()] })],
        ['SELECT DISTINCT author_id', () => ({ rows: [] })],
      ]);
      routeBySql(client.query, [
        ['INSERT INTO ticket_message', () => ({ rows: [{ message_id: 'm2' }] })],
        [
          'first_response_at',
          () => ({
            rows: [
              ticketRow({
                state: 'IN_PROGRESS',
                first_response_at: '2026-08-01T06:00:00.000Z',
              }),
            ],
          }),
        ],
      ]);
      const { ticket } = await service.replyAsAdmin(ADMIN_ID, TICKET_ID, {
        body: 'on it',
      });
      const update = client.query.mock.calls.find(([sql]) =>
        String(sql).includes('first_response_at'),
      );
      expect(String(update?.[0])).toContain(
        'first_response_at = COALESCE(first_response_at, now())',
      );
      // OPEN → IN_PROGRESS on the first admin reply.
      expect(String(update?.[0])).toContain("WHEN state = 'OPEN'");
      expect(ticket.state).toBe('IN_PROGRESS');
    });
  });

  describe('inbox filters (§9.18)', () => {
    it('applies state/category/priority/assignment filters as parameterized WHERE', async () => {
      routeBySql(pool.query, [
        ['FROM ticket', () => ({ rows: [] })],
      ]);
      await service.listInbox({
        state: 'OPEN',
        category: 'BILLING',
        priority: 'URGENT',
        assignedAdminId: ADMIN_ID,
      });
      const [sql, params] = pool.query.mock.calls[0];
      expect(String(sql)).toContain('state = $1');
      expect(String(sql)).toContain('category = $2');
      expect(String(sql)).toContain('priority = $3');
      expect(String(sql)).toContain('assigned_admin_id = $4');
      expect(params).toEqual(['OPEN', 'BILLING', 'URGENT', ADMIN_ID]);
    });

    it('no filters means no WHERE clause', async () => {
      routeBySql(pool.query, [['FROM ticket', () => ({ rows: [] })]]);
      await service.listInbox({});
      const [sql, params] = pool.query.mock.calls[0];
      expect(String(sql)).not.toContain('WHERE');
      expect(params).toEqual([]);
    });
  });

  describe('metrics math (RW-07, calendar hours)', () => {
    it('first response = first_response_at − created_at; resolution = resolved_at − created_at', async () => {
      routeBySql(pool.query, [
        [
          'FROM ticket',
          () => ({
            rows: [
              // responded after 6h, resolved after 48h
              ticketRow({
                created_at: '2026-08-01T00:00:00.000Z',
                first_response_at: '2026-08-01T06:00:00.000Z',
                resolved_at: '2026-08-03T00:00:00.000Z',
                state: 'RESOLVED',
              }),
              // responded after 2h, not resolved
              ticketRow({
                ticket_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                created_at: '2026-08-01T00:00:00.000Z',
                first_response_at: '2026-08-01T02:00:00.000Z',
                state: 'IN_PROGRESS',
              }),
              // never responded
              ticketRow({
                ticket_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                created_at: '2026-08-01T00:00:00.000Z',
                state: 'OPEN',
              }),
            ],
          }),
        ],
      ]);
      const m = await service.metrics({});
      expect(m.total).toBe(3);
      expect(m.byState).toEqual({ RESOLVED: 1, IN_PROGRESS: 1, OPEN: 1 });
      expect(m.avgFirstResponseHours).toBe(4); // (6 + 2) / 2
      expect(m.avgResolutionHours).toBe(48); // only the resolved ticket counts
    });

    it('empty inbox yields null averages, never NaN', async () => {
      routeBySql(pool.query, [['FROM ticket', () => ({ rows: [] })]]);
      const m = await service.metrics({});
      expect(m.avgFirstResponseHours).toBeNull();
      expect(m.avgResolutionHours).toBeNull();
    });
  });

  describe('merchant scoping (INV-1)', () => {
    it('getThread looks up by (ticket_id, shop_id) — a foreign ticket is 404', async () => {
      routeBySql(pool.query, [
        ['FROM ticket WHERE ticket_id = $1 AND shop_id = $2', () => ({ rows: [] })],
      ]);
      await expect(service.getThread(SHOP_ID, TICKET_ID)).rejects.toThrow(
        NotFoundException,
      );
      const [, params] = pool.query.mock.calls[0];
      expect(params).toEqual([TICKET_ID, SHOP_ID]);
    });
  });
});
