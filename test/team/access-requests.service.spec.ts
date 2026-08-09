import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessRequestsService } from '../../src/modules/team/access-requests.service';
import {
  MEMBER_ID,
  memberRow,
  mockPool,
  OWNER_ID,
  REQUEST_ID,
  routeBySql,
  SHOP_ID,
  uniqueViolation,
} from './helpers';

function requestRow(over: Record<string, unknown> = {}) {
  return {
    request_id: REQUEST_ID,
    shop_id: SHOP_ID,
    shopify_staff_user_id: 'staff-1',
    requested_at: '2026-01-01T00:00:00Z',
    resolved_at: null,
    resolved_by: null,
    resolution: 'PENDING',
    version: 2,
    ...over,
  };
}

describe('AccessRequestsService (§9.1.2, §3.19)', () => {
  let pool: ReturnType<typeof mockPool>['pool'];
  let client: ReturnType<typeof mockPool>['client'];
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: AccessRequestsService;

  beforeEach(() => {
    ({ pool, client } = mockPool());
    audit = { record: vi.fn() };
    service = new AccessRequestsService(pool as never, audit as never);
  });

  describe('create', () => {
    it('creates a PENDING request and audits (§12)', async () => {
      const created = requestRow();
      routeBySql(pool.query, [
        ['FROM shop_member', () => ({ rows: [] })],
        ['INSERT INTO access_request', () => ({ rows: [created] })],
      ]);
      const result = await service.create(SHOP_ID, 'staff-1');
      expect(result).toEqual(created);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ACCESS_REQUEST_CREATED',
          objectType: 'access_request',
        }),
      );
    });

    it('409 when the staff user already has a role (deny-by-default is for the roleless)', async () => {
      routeBySql(pool.query, [
        ['FROM shop_member', () => ({ rows: [memberRow()] })],
      ]);
      await expect(service.create(SHOP_ID, 'staff-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('one pending per (shop, staff): unique index violation → 409', async () => {
      routeBySql(pool.query, [
        ['FROM shop_member', () => ({ rows: [] })],
        [
          'INSERT INTO access_request',
          () => {
            throw uniqueViolation();
          },
        ],
      ]);
      await expect(service.create(SHOP_ID, 'staff-1')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('grant (RW-17: GRANTED creates the member row in the same transaction)', () => {
    function routeGrant(opts: {
      request?: unknown;
      resolvedRows?: unknown[];
      existingMember?: unknown;
      memberRows?: unknown[];
    } = {}) {
      const request = opts.request === undefined ? requestRow() : opts.request;
      const member = memberRow({ role: 'OPERATOR' });
      routeBySql(client.query, [
        ['BEGIN', () => ({ rows: [] })],
        ['COMMIT', () => ({ rows: [] })],
        ['ROLLBACK', () => ({ rows: [] })],
        [
          "SET resolution = 'GRANTED'",
          () => ({
            rows: opts.resolvedRows ?? [
              { ...requestRow(), resolution: 'GRANTED', version: 3, resolved_by: OWNER_ID },
            ],
          }),
        ],
        ['FROM shop_member', () => ({ rows: opts.existingMember ? [opts.existingMember] : [] })],
        ['INSERT INTO shop_member', () => ({ rows: opts.memberRows ?? [member] })],
        [
          'SET role = $3, granted_by = $4',
          () => ({ rows: opts.memberRows ?? [member] }),
        ],
        ['FROM access_request', () => ({ rows: request ? [request] : [] })],
      ]);
      return member;
    }

    it('rejects granting OWNER via an access request (OVR-1)', async () => {
      await expect(
        service.grant(SHOP_ID, OWNER_ID, REQUEST_ID, { role: 'OWNER', version: 2 }),
      ).rejects.toThrow(BadRequestException);
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('resolves the request AND inserts the member on the same tx client', async () => {
      const member = routeGrant();
      const outcome = await service.grant(SHOP_ID, OWNER_ID, REQUEST_ID, {
        role: 'OPERATOR',
        version: 2,
      });
      expect(outcome.member).toEqual(member);
      expect(outcome.request.resolution).toBe('GRANTED');

      const sql = client.query.mock.calls.map(([s]) => String(s));
      expect(sql[0]).toBe('BEGIN');
      expect(sql.at(-1)).toBe('COMMIT');
      // Request resolved and member created between BEGIN and COMMIT on the
      // same client — GRANTED can never exist without its member row (RW-17).
      const resolveIdx = sql.findIndex((s) => s.includes("SET resolution = 'GRANTED'"));
      const insertIdx = sql.findIndex((s) => s.includes('INSERT INTO shop_member'));
      expect(resolveIdx).toBeGreaterThan(0);
      expect(insertIdx).toBeGreaterThan(resolveIdx);
      expect(pool.query).not.toHaveBeenCalled();

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ACCESS_REQUEST_GRANTED' }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'MEMBER_ROLE_GRANTED' }),
      );
    });

    it('revives a previously revoked member row instead of inserting', async () => {
      routeGrant({ existingMember: memberRow({ revoked_at: '2026-02-01T00:00:00Z' }) });
      await service.grant(SHOP_ID, OWNER_ID, REQUEST_ID, {
        role: 'OPERATOR',
        version: 2,
      });
      const sql = client.query.mock.calls.map(([s]) => String(s)).join('\n');
      expect(sql).not.toContain('INSERT INTO shop_member');
      expect(sql).toContain('SET role = $3, granted_by = $4');
    });

    it('INV-22 version mismatch → 409 with current state and ROLLBACK', async () => {
      routeGrant({ resolvedRows: [] });
      await expect(
        service.grant(SHOP_ID, OWNER_ID, REQUEST_ID, { role: 'OPERATOR', version: 1 }),
      ).rejects.toThrow(ConflictException);
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      // The member insert must not have run when the resolution failed.
      const sql = client.query.mock.calls.map(([s]) => String(s)).join('\n');
      expect(sql).not.toContain('INSERT INTO shop_member');
    });

    it('terminal requests are never re-resolved (§3.19)', async () => {
      routeGrant({ request: requestRow({ resolution: 'DENIED' }) });
      await expect(
        service.grant(SHOP_ID, OWNER_ID, REQUEST_ID, { role: 'OPERATOR', version: 2 }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('deny', () => {
    it('resolves PENDING → DENIED, audited', async () => {
      routeBySql(pool.query, [
        ['FROM access_request', () => ({ rows: [requestRow()] })],
        [
          "SET resolution = 'DENIED'",
          () => ({ rows: [{ ...requestRow(), resolution: 'DENIED', version: 3 }] }),
        ],
      ]);
      const result = await service.deny(SHOP_ID, OWNER_ID, REQUEST_ID, {
        version: 2,
        reason: 'no longer needed',
      });
      expect(result.resolution).toBe('DENIED');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ACCESS_REQUEST_DENIED',
          reason: 'no longer needed',
        }),
      );
    });

    it('INV-22 mismatch → 409 with current state', async () => {
      const current = requestRow();
      routeBySql(pool.query, [
        ['FROM access_request', () => ({ rows: [current] })],
        ["SET resolution = 'DENIED'", () => ({ rows: [] })],
      ]);
      const err = await service
        .deny(SHOP_ID, OWNER_ID, REQUEST_ID, { version: 99 })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ current });
    });
  });

  describe('withdraw', () => {
    it('only the requester can withdraw their own request', async () => {
      routeBySql(pool.query, [
        ['FROM access_request', () => ({ rows: [requestRow()] })],
      ]);
      await expect(
        service.withdraw(SHOP_ID, 'someone-else', REQUEST_ID, { version: 2 }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('withdraws a PENDING request, audited', async () => {
      routeBySql(pool.query, [
        ['FROM access_request', () => ({ rows: [requestRow()] })],
        [
          "SET resolution = 'WITHDRAWN'",
          () => ({ rows: [{ ...requestRow(), resolution: 'WITHDRAWN', version: 3 }] }),
        ],
      ]);
      const result = await service.withdraw(SHOP_ID, 'staff-1', REQUEST_ID, {
        version: 2,
      });
      expect(result.resolution).toBe('WITHDRAWN');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ACCESS_REQUEST_WITHDRAWN' }),
      );
    });
  });
});
