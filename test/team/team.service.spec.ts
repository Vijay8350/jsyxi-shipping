import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamService } from '../../src/modules/team/team.service';
import {
  MEMBER_ID,
  memberRow,
  mockPool,
  OWNER_ID,
  routeBySql,
  SHOP_ID,
  uniqueViolation,
} from './helpers';

describe('TeamService', () => {
  let pool: ReturnType<typeof mockPool>['pool'];
  let client: ReturnType<typeof mockPool>['client'];
  let sessions: { invalidateMember: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: TeamService;

  beforeEach(() => {
    ({ pool, client } = mockPool());
    sessions = { invalidateMember: vi.fn() };
    audit = { record: vi.fn() };
    service = new TeamService(pool as never, sessions as never, audit as never);
  });

  describe('grantRole (§9.1.2)', () => {
    it('rejects granting OWNER — ownership only moves via transfer/claim (OVR-1)', async () => {
      await expect(
        service.grantRole(SHOP_ID, OWNER_ID, {
          shopifyStaffUserId: 'staff-9',
          role: 'OWNER',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('creates a SHOPIFY_STAFF member and audits (§12)', async () => {
      const created = memberRow({ role: 'VIEWER' });
      routeBySql(pool.query, [
        ['AND shopify_staff_user_id = $2', () => ({ rows: [] })],
        ['INSERT INTO shop_member', () => ({ rows: [created] })],
      ]);
      const result = await service.grantRole(SHOP_ID, OWNER_ID, {
        shopifyStaffUserId: 'staff-1',
        role: 'VIEWER',
      });
      expect(result).toEqual(created);
      const insert = pool.query.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO shop_member'),
      );
      expect(insert?.[1]).toEqual([SHOP_ID, 'staff-1', 'VIEWER', OWNER_ID]);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'MEMBER_ROLE_GRANTED',
          objectType: 'shop_member',
          shopId: SHOP_ID,
        }),
      );
    });

    it('409 when the staff user is already an active member', async () => {
      routeBySql(pool.query, [
        ['AND shopify_staff_user_id = $2', () => ({ rows: [memberRow()] })],
      ]);
      await expect(
        service.grantRole(SHOP_ID, OWNER_ID, {
          shopifyStaffUserId: 'staff-1',
          role: 'VIEWER',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('revives a revoked row with the INV-22 version check; mismatch → 409 with current state', async () => {
      const revoked = memberRow({ revoked_at: '2026-02-01T00:00:00Z' });
      routeBySql(pool.query, [
        ['AND shopify_staff_user_id = $2', () => ({ rows: [revoked] })],
        ['SET role = $4, granted_by = $5', () => ({ rows: [] })], // version mismatch
        ['AND member_id = $2', () => ({ rows: [revoked] })], // current state readback
      ]);
      await expect(
        service.grantRole(SHOP_ID, OWNER_ID, {
          shopifyStaffUserId: 'staff-1',
          role: 'OPERATOR',
          version: 999,
        }),
      ).rejects.toThrow(ConflictException);
      const err = await service
        .grantRole(SHOP_ID, OWNER_ID, {
          shopifyStaffUserId: 'staff-1',
          role: 'OPERATOR',
          version: 999,
        })
        .catch((e) => e);
      expect(err.getResponse()).toMatchObject({ current: revoked });
    });

    it('requires the version when reviving a revoked row (INV-22)', async () => {
      const revoked = memberRow({ revoked_at: '2026-02-01T00:00:00Z' });
      routeBySql(pool.query, [
        ['AND shopify_staff_user_id = $2', () => ({ rows: [revoked] })],
        ['AND member_id = $2', () => ({ rows: [revoked] })],
      ]);
      await expect(
        service.grantRole(SHOP_ID, OWNER_ID, {
          shopifyStaffUserId: 'staff-1',
          role: 'OPERATOR',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('maps a lost insert race (unique violation) to 409', async () => {
      routeBySql(pool.query, [
        ['AND shopify_staff_user_id = $2', () => ({ rows: [] })],
        [
          'INSERT INTO shop_member',
          () => {
            throw uniqueViolation();
          },
        ],
      ]);
      await expect(
        service.grantRole(SHOP_ID, OWNER_ID, {
          shopifyStaffUserId: 'staff-1',
          role: 'VIEWER',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('changeRole (§9.1.2)', () => {
    it('rejects OWNER as the new role (OVR-1 / §9.1.2)', async () => {
      await expect(
        service.changeRole(SHOP_ID, OWNER_ID, MEMBER_ID, {
          role: 'OWNER',
          version: 3,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('404 for unknown or already-revoked members', async () => {
      routeBySql(pool.query, [['AND member_id = $2', () => ({ rows: [] })]]);
      await expect(
        service.changeRole(SHOP_ID, OWNER_ID, MEMBER_ID, {
          role: 'FINANCE',
          version: 3,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('cannot demote the active Owner here — transfer is the only path (zero-Owners guard)', async () => {
      routeBySql(pool.query, [
        ['AND member_id = $2', () => ({ rows: [memberRow({ role: 'OWNER' })] })],
      ]);
      await expect(
        service.changeRole(SHOP_ID, OWNER_ID, MEMBER_ID, {
          role: 'OPERATOR',
          version: 3,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('version mismatch → 409 with current state (INV-22)', async () => {
      const member = memberRow();
      routeBySql(pool.query, [
        ['SET role = $4, version = version + 1', () => ({ rows: [] })],
        ['AND member_id = $2', () => ({ rows: [member] })],
      ]);
      const err = await service
        .changeRole(SHOP_ID, OWNER_ID, MEMBER_ID, { role: 'FINANCE', version: 1 })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ current: member });
    });

    it('success: updates role, invalidates sessions, audits (§12)', async () => {
      const member = memberRow({ role: 'OPERATOR' });
      const updated = memberRow({ role: 'FINANCE', version: 4 });
      routeBySql(pool.query, [
        ['SET role = $4, version = version + 1', () => ({ rows: [updated] })],
        ['AND member_id = $2', () => ({ rows: [member] })],
      ]);
      const result = await service.changeRole(SHOP_ID, OWNER_ID, MEMBER_ID, {
        role: 'FINANCE',
        version: 3,
      });
      expect(result.role).toBe('FINANCE');
      expect(sessions.invalidateMember).toHaveBeenCalledWith(
        MEMBER_ID,
        'ROLE_REVOKED',
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'MEMBER_ROLE_CHANGED',
          before: { role: 'OPERATOR' },
          after: { role: 'FINANCE' },
        }),
      );
    });
  });

  describe('revokeMember (§9.1.2, OVR-1)', () => {
    it('cannot revoke the active Owner — transfer first (zero-Owners guard)', async () => {
      routeBySql(pool.query, [
        [
          'AND member_id = $2',
          () => ({ rows: [memberRow({ member_id: OWNER_ID, role: 'OWNER' })] }),
        ],
      ]);
      await expect(
        service.revokeMember(SHOP_ID, OWNER_ID, OWNER_ID, { version: 3 }),
      ).rejects.toThrow(ConflictException);
    });

    it('revokes a NATIVE member (native members are revoked in Team & Roles only, OVR-1)', async () => {
      const native = memberRow({
        auth_source: 'NATIVE',
        shopify_staff_user_id: null,
        email: 'n@example.com',
      });
      const revoked = { ...native, revoked_at: '2026-03-01T00:00:00Z', version: 4 };
      routeBySql(pool.query, [
        ['SET revoked_at = now()', () => ({ rows: [revoked] })],
        ['AND member_id = $2', () => ({ rows: [native] })],
      ]);
      const result = await service.revokeMember(SHOP_ID, OWNER_ID, MEMBER_ID, {
        version: 3,
        reason: 'left the company',
      });
      expect(result.revoked_at).not.toBeNull();
      expect(sessions.invalidateMember).toHaveBeenCalledWith(
        MEMBER_ID,
        'ROLE_REVOKED',
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'MEMBER_REVOKED',
          reason: 'left the company',
        }),
      );
    });

    it('version mismatch → 409 with current state (INV-22)', async () => {
      const member = memberRow();
      routeBySql(pool.query, [
        ['SET revoked_at = now()', () => ({ rows: [] })],
        ['AND member_id = $2', () => ({ rows: [member] })],
      ]);
      await expect(
        service.revokeMember(SHOP_ID, OWNER_ID, MEMBER_ID, { version: 1 }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('transferOwnership (§9.1.2)', () => {
    const transferInput = {
      targetMemberId: MEMBER_ID,
      ownerNewRole: 'OPERATOR' as const,
      ownerVersion: 5,
      targetVersion: 3,
    };

    function routeTransfer(opts: {
      owner?: unknown;
      target?: unknown;
      demoteRows?: unknown[];
      promoteRows?: unknown[];
      promoteThrows?: boolean;
    }) {
      const owner = opts.owner ?? memberRow({ member_id: OWNER_ID, role: 'OWNER', version: 5 });
      const target = opts.target ?? memberRow({ version: 3 });
      routeBySql(client.query, [
        ['BEGIN', () => ({ rows: [] })],
        ['COMMIT', () => ({ rows: [] })],
        ['ROLLBACK', () => ({ rows: [] })],
        ['SET role = $3', () => ({ rows: opts.demoteRows ?? [memberRow({ member_id: OWNER_ID, role: 'OPERATOR', version: 6 })] })],
        [
          "SET role = 'OWNER'",
          () => {
            if (opts.promoteThrows) throw uniqueViolation();
            return { rows: opts.promoteRows ?? [memberRow({ role: 'OWNER', version: 4 })] };
          },
        ],
        ["AND role = 'OWNER' AND revoked_at IS NULL", () => ({ rows: owner ? [owner] : [] })],
        ['AND member_id = $2', () => ({ rows: target ? [target] : [] })],
      ]);
    }

    it('demote role must not be OWNER (request names it explicitly)', async () => {
      await expect(
        service.transferOwnership(SHOP_ID, OWNER_ID, {
          ...transferInput,
          ownerNewRole: 'OWNER',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('only the current Owner can initiate', async () => {
      routeTransfer({});
      await expect(
        service.transferOwnership(SHOP_ID, 'someone-else', transferInput),
      ).rejects.toThrow(ForbiddenException);
    });

    it('OVR-1: a NATIVE member can never be promoted to Owner', async () => {
      routeTransfer({
        target: memberRow({ auth_source: 'NATIVE', email: 'n@example.com', shopify_staff_user_id: null }),
      });
      await expect(
        service.transferOwnership(SHOP_ID, OWNER_ID, transferInput),
      ).rejects.toThrow(ConflictException);
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('one transaction: demote then promote on the same client, then COMMIT', async () => {
      routeTransfer({});
      const outcome = await service.transferOwnership(
        SHOP_ID,
        OWNER_ID,
        transferInput,
      );
      expect(outcome.newOwner.role).toBe('OWNER');
      expect(outcome.previousOwner.role).toBe('OPERATOR');
      const sql = client.query.mock.calls.map(([s]) => String(s));
      expect(sql[0]).toBe('BEGIN');
      expect(sql.at(-1)).toBe('COMMIT');
      // Demote precedes promote so the one-owner partial index passes.
      const demoteIdx = sql.findIndex((s) => s.includes('SET role = $3'));
      const promoteIdx = sql.findIndex((s) => s.includes("SET role = 'OWNER'"));
      expect(demoteIdx).toBeGreaterThan(-1);
      expect(promoteIdx).toBeGreaterThan(demoteIdx);
      // No write went through the pool outside the transaction.
      expect(pool.query).not.toHaveBeenCalled();
      // Both sessions invalidated: the session caches the role (§9.1.4, RW-04).
      expect(sessions.invalidateMember).toHaveBeenCalledWith(OWNER_ID, 'OWNER_TRANSFER');
      expect(sessions.invalidateMember).toHaveBeenCalledWith(MEMBER_ID, 'OWNER_TRANSFER');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'OWNER_TRANSFERRED' }),
      );
    });

    it('INV-22 mismatch on the demote → 409 and ROLLBACK', async () => {
      routeTransfer({ demoteRows: [] });
      await expect(
        service.transferOwnership(SHOP_ID, OWNER_ID, transferInput),
      ).rejects.toThrow(ConflictException);
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(sessions.invalidateMember).not.toHaveBeenCalled();
    });

    it('a concurrent transfer decided by the one-owner index → clean 409', async () => {
      routeTransfer({ promoteThrows: true });
      await expect(
        service.transferOwnership(SHOP_ID, OWNER_ID, transferInput),
      ).rejects.toThrow(ConflictException);
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('claimOwnership (§9.1.2)', () => {
    function routeClaim(opts: { oldOwner?: unknown; claimant?: unknown }) {
      const oldOwner =
        opts.oldOwner === undefined
          ? memberRow({ member_id: OWNER_ID, role: 'OWNER', shopify_staff_user_id: 'old-staff' })
          : opts.oldOwner;
      const claimantRow = memberRow({
        role: 'OWNER',
        shopify_staff_user_id: 'new-staff',
        granted_by: MEMBER_ID,
      });
      routeBySql(client.query, [
        ['BEGIN', () => ({ rows: [] })],
        ['COMMIT', () => ({ rows: [] })],
        ['ROLLBACK', () => ({ rows: [] })],
        ['SET revoked_at = now()', () => ({ rows: [{ ...oldOwner, revoked_at: 'now' }] })],
        ['INSERT INTO shop_member', () => ({ rows: [claimantRow] })],
        ['shopify_staff_user_id = $2', () => ({ rows: opts.claimant ? [opts.claimant] : [] })],
        ["AND role = 'OWNER' AND revoked_at IS NULL", () => ({ rows: oldOwner ? [oldOwner] : [] })],
      ]);
      return claimantRow;
    }

    it('revokes the stale Owner and creates the claimant as OWNER, audited with reason', async () => {
      const claimantRow = routeClaim({});
      const outcome = await service.claimOwnership(SHOP_ID, {
        claimantStaffUserId: 'new-staff',
        reason: 'previous owner no longer a Shopify staff user',
      });
      expect(outcome.newOwner).toEqual(claimantRow);
      const sql = client.query.mock.calls.map(([s]) => String(s));
      expect(sql[0]).toBe('BEGIN');
      expect(sql.at(-1)).toBe('COMMIT');
      // Old owner revoked inside the same transaction, before the insert.
      const revokeIdx = sql.findIndex((s) => s.includes('SET revoked_at = now()'));
      const insertIdx = sql.findIndex((s) => s.includes('INSERT INTO shop_member'));
      expect(revokeIdx).toBeGreaterThan(-1);
      expect(insertIdx).toBeGreaterThan(revokeIdx);
      expect(sessions.invalidateMember).toHaveBeenCalledWith(OWNER_ID, 'OWNER_TRANSFER');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'OWNER_CLAIMED',
          reason: 'previous owner no longer a Shopify staff user',
        }),
      );
    });

    it('promotes an existing active member row instead of inserting', async () => {
      const existing = memberRow({ member_id: MEMBER_ID, role: 'VIEWER', shopify_staff_user_id: 'new-staff' });
      routeBySql(client.query, [
        ['BEGIN', () => ({ rows: [] })],
        ['COMMIT', () => ({ rows: [] })],
        ['ROLLBACK', () => ({ rows: [] })],
        ['SET revoked_at = now()', () => ({ rows: [{}] })],
        ["SET role = 'OWNER', revoked_at = NULL", () => ({ rows: [{ ...existing, role: 'OWNER', version: 4 }] })],
        ['shopify_staff_user_id = $2', () => ({ rows: [existing] })],
        ["AND role = 'OWNER' AND revoked_at IS NULL", () => ({ rows: [memberRow({ member_id: OWNER_ID, role: 'OWNER' })] })],
      ]);
      const outcome = await service.claimOwnership(SHOP_ID, {
        claimantStaffUserId: 'new-staff',
        reason: 'claim',
      });
      expect(outcome.newOwner.role).toBe('OWNER');
      const sql = client.query.mock.calls.map(([s]) => String(s)).join('\n');
      expect(sql).not.toContain('INSERT INTO shop_member');
    });

    it('409 when the claimant is already the active Owner', async () => {
      routeClaim({
        oldOwner: memberRow({ member_id: OWNER_ID, role: 'OWNER', shopify_staff_user_id: 'new-staff' }),
      });
      await expect(
        service.claimOwnership(SHOP_ID, {
          claimantStaffUserId: 'new-staff',
          reason: 'claim',
        }),
      ).rejects.toThrow(ConflictException);
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });
});
