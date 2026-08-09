import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import { SessionService } from '../../auth/session.service';
import { MemberRole } from '../../auth/session.types';
import {
  AuditTrailRow,
  isUniqueViolation,
  ShopMemberRow,
} from './team.types';

/**
 * Team & Roles (§9.1.2) — member lifecycle, role grants/changes/revocation,
 * Owner transfer and the Owner-claim path used by the shopify entry module.
 *
 * Invariants enforced here (all queries are shop-scoped, INV-1):
 * - Exactly one active Owner per shop. The shop_member_one_owner unique
 *   partial index is the final arbiter; any race against it surfaces as a
 *   clean 409, never a 500 (§9.1.2).
 * - OVR-1: a NATIVE member can never hold OWNER; the Owner is always a
 *   SHOPIFY_STAFF identity. Native members are revoked here and nowhere else
 *   (never by Shopify staff sync).
 * - INV-22: every write carries the version the writer read; a mismatch
 *   returns 409 with the current state.
 * - §12: every grant, change, revoke, transfer and claim is audited.
 *
 * Note: audit rows are written via AuditService after the transaction
 * commits — AuditService owns the audit_log insert and does not take a
 * client, so the audit insert itself is not transactional (see module notes).
 */
@Injectable()
export class TeamService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  private async withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** INV-22: reject with the current state so the caller can refresh (§6). */
  private async conflictWithCurrentMember(
    shopId: string,
    memberId: string,
  ): Promise<never> {
    const current = await this.findMember(shopId, memberId);
    throw new ConflictException({
      message: 'version mismatch (INV-22)',
      current: current ?? null,
    });
  }

  async findMember(
    shopId: string,
    memberId: string,
  ): Promise<ShopMemberRow | null> {
    const { rows } = await this.pool.query<ShopMemberRow>(
      `SELECT member_id, shop_id, shopify_staff_user_id, email, auth_source,
              role, granted_by, granted_at, revoked_at, last_active_at, version
         FROM shop_member
        WHERE shop_id = $1 AND member_id = $2`,
      [shopId, memberId],
    );
    return rows[0] ?? null;
  }

  /**
   * §9.1.2 Team & Roles list: every known member of the shop with role,
   * auth_source, last active and granted/revoked state. Owner-only via the
   * controller guard ('team.manage').
   */
  async listMembers(shopId: string): Promise<ShopMemberRow[]> {
    const { rows } = await this.pool.query<ShopMemberRow>(
      `SELECT member_id, shop_id, shopify_staff_user_id, email, auth_source,
              role, granted_by, granted_at, revoked_at, last_active_at, version
         FROM shop_member
        WHERE shop_id = $1
        ORDER BY revoked_at IS NULL DESC, granted_at ASC`,
      [shopId],
    );
    return rows;
  }

  /**
   * §9.1.2 role-change audit trail, read from audit_log (§12). Covers every
   * audited membership action: grants, changes, revokes, transfers, claims.
   */
  async getAuditTrail(
    shopId: string,
    memberId?: string,
  ): Promise<AuditTrailRow[]> {
    const params: unknown[] = [shopId];
    let memberFilter = '';
    if (memberId) {
      params.push(memberId);
      memberFilter = 'AND object_id = $2';
    }
    const { rows } = await this.pool.query<AuditTrailRow>(
      `SELECT audit_id, actor_kind, actor_id, action, object_type, object_id,
              before, after, reason, occurred_at
         FROM audit_log
        WHERE shop_id = $1
          AND object_type = 'shop_member'
          ${memberFilter}
        ORDER BY occurred_at DESC
        LIMIT 200`,
      params,
    );
    return rows;
  }

  /**
   * Grant a role to a known Shopify staff user (§9.1.2). Always creates a
   * SHOPIFY_STAFF member — native members arrive only via the Owner's email
   * invite flow (OVR-1), which is a separate module. OWNER is not grantable
   * here: ownership moves via transferOwnership / claimOwnership only.
   *
   * The shop_member_staff_key unique index covers revoked rows too, so a
   * re-grant to a previously revoked staff user revives that row (with an
   * INV-22 version check) instead of inserting.
   */
  async grantRole(
    shopId: string,
    actorId: string,
    input: { shopifyStaffUserId: string; role: MemberRole; version?: number },
  ): Promise<ShopMemberRow> {
    if (input.role === 'OWNER') {
      throw new BadRequestException(
        'OWNER is not grantable; use owner transfer or claim (§9.1.2, OVR-1)',
      );
    }

    const { rows: existing } = await this.pool.query<ShopMemberRow>(
      `SELECT member_id, role, revoked_at, version
         FROM shop_member
        WHERE shop_id = $1 AND shopify_staff_user_id = $2`,
      [shopId, input.shopifyStaffUserId],
    );
    const current = existing[0];

    let member: ShopMemberRow;
    if (current && current.revoked_at === null) {
      throw new ConflictException('staff user is already an active member');
    } else if (current) {
      // Revive the revoked row (INV-22 version check on the row being changed).
      if (input.version === undefined) {
        throw new ConflictException({
          message: 'member was previously revoked; re-read and pass version (INV-22)',
          current: await this.findMember(shopId, current.member_id),
        });
      }
      const { rows } = await this.pool.query<ShopMemberRow>(
        `UPDATE shop_member
            SET role = $4, granted_by = $5, granted_at = now(),
                revoked_at = NULL, version = version + 1
          WHERE shop_id = $1 AND member_id = $2
            AND revoked_at IS NOT NULL AND version = $3
          RETURNING *`,
        [shopId, current.member_id, input.version, input.role, actorId],
      );
      if (rows.length === 0) {
        await this.conflictWithCurrentMember(shopId, current.member_id);
      }
      member = rows[0];
    } else {
      try {
        const { rows } = await this.pool.query<ShopMemberRow>(
          `INSERT INTO shop_member
             (shop_id, shopify_staff_user_id, auth_source, role, granted_by)
           VALUES ($1, $2, 'SHOPIFY_STAFF', $3, $4)
           RETURNING *`,
          [shopId, input.shopifyStaffUserId, input.role, actorId],
        );
        member = rows[0];
      } catch (err) {
        // Lost a race with a concurrent grant of the same staff user.
        if (isUniqueViolation(err)) {
          throw new ConflictException('staff user is already a member');
        }
        throw err;
      }
    }

    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId,
      action: 'MEMBER_ROLE_GRANTED',
      objectType: 'shop_member',
      objectId: member.member_id,
      before: current ? { role: current.role ?? null, revoked: true } : null,
      after: { role: member.role, auth_source: member.auth_source },
    });
    return member;
  }

  /**
   * Change a member's role (§9.1.2, INV-22). The active Owner's role cannot
   * be changed here — demoting the only Owner would leave zero Owners, so
   * ownership must move through transferOwnership instead.
   */
  async changeRole(
    shopId: string,
    actorId: string,
    memberId: string,
    input: { role: MemberRole; version: number },
  ): Promise<ShopMemberRow> {
    if (input.role === 'OWNER') {
      throw new BadRequestException(
        'OWNER is not assignable here; use owner transfer (§9.1.2, OVR-1)',
      );
    }
    const member = await this.findMember(shopId, memberId);
    if (!member || member.revoked_at !== null) {
      throw new NotFoundException('member not found');
    }
    if (member.role === 'OWNER') {
      throw new ConflictException(
        'cannot demote the active Owner here; transfer ownership first (§9.1.2)',
      );
    }

    const { rows } = await this.pool.query<ShopMemberRow>(
      `UPDATE shop_member
          SET role = $4, version = version + 1
        WHERE shop_id = $1 AND member_id = $2
          AND revoked_at IS NULL AND version = $3
        RETURNING *`,
      [shopId, memberId, input.version, input.role],
    );
    if (rows.length === 0) {
      await this.conflictWithCurrentMember(shopId, memberId);
    }
    const updated = rows[0];

    // The session caches the role; the old role is revoked, so the member's
    // sessions must not keep authorizing against it (§9.1.4).
    await this.sessions.invalidateMember(memberId, 'ROLE_REVOKED');
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId,
      action: 'MEMBER_ROLE_CHANGED',
      objectType: 'shop_member',
      objectId: memberId,
      before: { role: member.role },
      after: { role: updated.role },
    });
    return updated;
  }

  /**
   * Revoke a member (§9.1.2): set revoked_at, invalidate their sessions with
   * 'ROLE_REVOKED', audit. Works for SHOPIFY_STAFF and NATIVE members alike —
   * native members are revoked here and only here (OVR-1).
   *
   * The active Owner can never be revoked: exactly one Owner must exist at
   * all times, so revoking the Owner — yourself included — is a 409 that
   * directs the caller to transfer ownership first.
   */
  async revokeMember(
    shopId: string,
    actorId: string,
    memberId: string,
    input: { version: number; reason?: string },
  ): Promise<ShopMemberRow> {
    const member = await this.findMember(shopId, memberId);
    if (!member || member.revoked_at !== null) {
      throw new NotFoundException('member not found');
    }
    if (member.role === 'OWNER') {
      throw new ConflictException(
        'cannot revoke the active Owner; transfer ownership first (§9.1.2)',
      );
    }

    const { rows } = await this.pool.query<ShopMemberRow>(
      `UPDATE shop_member
          SET revoked_at = now(), version = version + 1
        WHERE shop_id = $1 AND member_id = $2
          AND revoked_at IS NULL AND version = $3
        RETURNING *`,
      [shopId, memberId, input.version],
    );
    if (rows.length === 0) {
      await this.conflictWithCurrentMember(shopId, memberId);
    }
    const updated = rows[0];

    await this.sessions.invalidateMember(memberId, 'ROLE_REVOKED');
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId,
      action: 'MEMBER_REVOKED',
      objectType: 'shop_member',
      objectId: memberId,
      before: { role: member.role },
      after: { revoked: true },
      reason: input.reason ?? null,
    });
    return updated;
  }

  /**
   * Owner transfer (§9.1.2). Owner-initiated; the request names the target
   * member AND the role the current Owner takes after the transfer (the spec
   * leaves the demotion role open, so it is required explicitly and may not
   * be OWNER).
   *
   * One transaction: demote current Owner, promote the target. The target
   * must be an active SHOPIFY_STAFF member — a NATIVE member can never be
   * Owner (OVR-1). The shop_member_one_owner index is the final arbiter; a
   * concurrent transfer maps to a clean 409. Both members' sessions are
   * invalidated ('OWNER_TRANSFER') because the session caches the role
   * (§9.1.4, RW-04).
   */
  async transferOwnership(
    shopId: string,
    actorId: string,
    input: {
      targetMemberId: string;
      ownerNewRole: MemberRole;
      ownerVersion: number;
      targetVersion: number;
    },
  ): Promise<{ previousOwner: ShopMemberRow; newOwner: ShopMemberRow }> {
    if (input.ownerNewRole === 'OWNER') {
      throw new BadRequestException(
        'the post-transfer role of the current Owner must not be OWNER (§9.1.2)',
      );
    }
    if (input.targetMemberId === actorId) {
      throw new BadRequestException('cannot transfer ownership to yourself');
    }

    let outcome: {
      previousOwner: ShopMemberRow;
      newOwner: ShopMemberRow;
      targetPreviousRole: MemberRole;
    };
    try {
      outcome = await this.withTransaction(async (client) => {
        const { rows: owners } = await client.query<ShopMemberRow>(
          `SELECT * FROM shop_member
            WHERE shop_id = $1 AND role = 'OWNER' AND revoked_at IS NULL
            FOR UPDATE`,
          [shopId],
        );
        const owner = owners[0];
        if (!owner) throw new ConflictException('shop has no active Owner');
        if (owner.member_id !== actorId) {
          throw new ForbiddenException('only the current Owner can transfer ownership');
        }

        const { rows: targets } = await client.query<ShopMemberRow>(
          `SELECT * FROM shop_member
            WHERE shop_id = $1 AND member_id = $2
            FOR UPDATE`,
          [shopId, input.targetMemberId],
        );
        const target = targets[0];
        if (!target || target.revoked_at !== null) {
          throw new NotFoundException('target member not found');
        }
        if (target.auth_source !== 'SHOPIFY_STAFF') {
          // OVR-1: a native member can never become Owner.
          throw new ConflictException(
            'a NATIVE member can never be Owner (OVR-1)',
          );
        }

        // Demote first: the one-owner partial index then permits the promote
        // in the same transaction. Both updates carry the INV-22 check.
        const demote = await client.query<ShopMemberRow>(
          `UPDATE shop_member
              SET role = $3, version = version + 1
            WHERE shop_id = $1 AND member_id = $2
              AND role = 'OWNER' AND revoked_at IS NULL AND version = $4
            RETURNING *`,
          [shopId, owner.member_id, input.ownerNewRole, input.ownerVersion],
        );
        if (demote.rows.length === 0) {
          throw new ConflictException({
            message: 'version mismatch (INV-22)',
            current: owner,
          });
        }

        const promote = await client.query<ShopMemberRow>(
          `UPDATE shop_member
              SET role = 'OWNER', version = version + 1
            WHERE shop_id = $1 AND member_id = $2
              AND revoked_at IS NULL AND version = $3
            RETURNING *`,
          [shopId, target.member_id, input.targetVersion],
        );
        if (promote.rows.length === 0) {
          throw new ConflictException({
            message: 'version mismatch (INV-22)',
            current: target,
          });
        }

        return {
          previousOwner: demote.rows[0],
          newOwner: promote.rows[0],
          targetPreviousRole: target.role,
        };
      });
    } catch (err) {
      // The unique partial index is the final arbiter of a transfer race.
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'concurrent ownership change rejected by the one-owner invariant (§9.1.2)',
        );
      }
      throw err;
    }

    await this.sessions.invalidateMember(
      outcome.previousOwner.member_id,
      'OWNER_TRANSFER',
    );
    await this.sessions.invalidateMember(
      outcome.newOwner.member_id,
      'OWNER_TRANSFER',
    );
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId,
      action: 'OWNER_TRANSFERRED',
      objectType: 'shop_member',
      objectId: outcome.newOwner.member_id,
      before: {
        owner_member_id: outcome.previousOwner.member_id,
        owner_role: 'OWNER',
        target_role: outcome.targetPreviousRole,
      },
      after: {
        owner_member_id: outcome.newOwner.member_id,
        previous_owner_role: input.ownerNewRole,
      },
    });
    return outcome;
  }

  /**
   * Owner claim (§9.1.2): when the Owner is no longer a valid Shopify staff
   * user, the store's Shopify account owner claims Owner on next entry. The
   * shopify entry module DETECTS the situation and verifies the claimant is
   * the Shopify account owner; this method performs the data change:
   * revoke the old Owner row, create or promote the claimant as OWNER, audit
   * with the reason. OVR-1 keeps the Owner a Shopify identity: the claimant
   * row is always auth_source SHOPIFY_STAFF.
   */
  async claimOwnership(
    shopId: string,
    input: { claimantStaffUserId: string; reason: string },
  ): Promise<{ previousOwner: ShopMemberRow | null; newOwner: ShopMemberRow }> {
    let outcome: {
      previousOwner: ShopMemberRow | null;
      newOwner: ShopMemberRow;
    };
    try {
      outcome = await this.withTransaction(async (client) => {
        const { rows: owners } = await client.query<ShopMemberRow>(
          `SELECT * FROM shop_member
            WHERE shop_id = $1 AND role = 'OWNER' AND revoked_at IS NULL
            FOR UPDATE`,
          [shopId],
        );
        const oldOwner = owners[0] ?? null;
        if (
          oldOwner &&
          oldOwner.shopify_staff_user_id === input.claimantStaffUserId
        ) {
          throw new ConflictException('claimant is already the active Owner');
        }

        if (oldOwner) {
          await client.query(
            `UPDATE shop_member
                SET revoked_at = now(), version = version + 1
              WHERE shop_id = $1 AND member_id = $2 AND revoked_at IS NULL`,
            [shopId, oldOwner.member_id],
          );
        }

        // The claimant may already have a member row (active or revoked); the
        // shop_member_staff_key index covers both, so revive/promote in place.
        const { rows: claimantRows } = await client.query<ShopMemberRow>(
          `SELECT * FROM shop_member
            WHERE shop_id = $1 AND shopify_staff_user_id = $2
            FOR UPDATE`,
          [shopId, input.claimantStaffUserId],
        );
        const claimant = claimantRows[0];

        let newOwner: ShopMemberRow;
        if (claimant) {
          const { rows } = await client.query<ShopMemberRow>(
            `UPDATE shop_member
                SET role = 'OWNER', revoked_at = NULL,
                    granted_by = member_id, granted_at = now(),
                    version = version + 1
              WHERE shop_id = $1 AND member_id = $2
              RETURNING *`,
            [shopId, claimant.member_id],
          );
          newOwner = rows[0];
        } else {
          const { rows } = await client.query<ShopMemberRow>(
            `INSERT INTO shop_member
               (shop_id, shopify_staff_user_id, auth_source, role)
             VALUES ($1, $2, 'SHOPIFY_STAFF', 'OWNER')
             RETURNING *`,
            [shopId, input.claimantStaffUserId],
          );
          newOwner = rows[0];
        }
        return { previousOwner: oldOwner, newOwner };
      });
    } catch (err) {
      // Concurrent claim/transfer decided by the one-owner index.
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'concurrent ownership change rejected by the one-owner invariant (§9.1.2)',
        );
      }
      throw err;
    }

    if (outcome.previousOwner) {
      await this.sessions.invalidateMember(
        outcome.previousOwner.member_id,
        'OWNER_TRANSFER',
      );
    }
    // The claimant's sessions cache their previous role (if any).
    await this.sessions.invalidateMember(
      outcome.newOwner.member_id,
      'OWNER_TRANSFER',
    );
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: outcome.newOwner.member_id,
      action: 'OWNER_CLAIMED',
      objectType: 'shop_member',
      objectId: outcome.newOwner.member_id,
      before: outcome.previousOwner
        ? { owner_member_id: outcome.previousOwner.member_id, revoked: false }
        : null,
      after: { owner_member_id: outcome.newOwner.member_id },
      reason: input.reason,
    });
    return outcome;
  }
}
