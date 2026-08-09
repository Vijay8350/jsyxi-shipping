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
import { MemberRole } from '../../auth/session.types';
import {
  AccessRequestRow,
  isUniqueViolation,
  ShopMemberRow,
} from './team.types';

/**
 * Access requests (§9.1.2, §3.19). A Shopify staff user with a valid entry
 * but no role ("No access" — the absence of a shop_member row, §10.1) gets
 * exactly one action behind the deny-by-default boundary: request access.
 * That creates a PENDING access_request; the access_request_one_pending
 * unique partial index allows one pending request per (shop, staff user).
 *
 * Resolution (§3.19, all audited per §12):
 * - Owner grants → GRANTED implies the shop_member row is created in the
 *   SAME transaction (RW-17). OWNER is never the granted role (OVR-1, §9.1.2).
 * - Owner denies → DENIED.
 * - Requester withdraws → WITHDRAWN. Only the requesting staff user may
 *   withdraw their own request.
 * All resolution writes carry the INV-22 version check.
 */
@Injectable()
export class AccessRequestsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
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

  async findRequest(
    shopId: string,
    requestId: string,
  ): Promise<AccessRequestRow | null> {
    const { rows } = await this.pool.query<AccessRequestRow>(
      `SELECT request_id, shop_id, shopify_staff_user_id, requested_at,
              resolved_at, resolved_by, resolution, version
         FROM access_request
        WHERE shop_id = $1 AND request_id = $2`,
      [shopId, requestId],
    );
    return rows[0] ?? null;
  }

  private async conflictWithCurrentRequest(
    shopId: string,
    requestId: string,
  ): Promise<never> {
    const current = await this.findRequest(shopId, requestId);
    throw new ConflictException({
      message: 'version mismatch (INV-22)',
      current: current ?? null,
    });
  }

  /**
   * Create a PENDING access_request (§9.1.2 one-click "request access").
   * The caller (shopify entry module, or the session-authenticated variant)
   * supplies the shop_id + shopify_staff_user_id the entry layer verified.
   */
  async create(
    shopId: string,
    staffUserId: string,
  ): Promise<AccessRequestRow> {
    // A staff user who already has a role has nothing to request (§10.1).
    const { rows: members } = await this.pool.query<ShopMemberRow>(
      `SELECT member_id FROM shop_member
        WHERE shop_id = $1 AND shopify_staff_user_id = $2
          AND revoked_at IS NULL`,
      [shopId, staffUserId],
    );
    if (members.length > 0) {
      throw new ConflictException('staff user already has a role');
    }

    let request: AccessRequestRow;
    try {
      const { rows } = await this.pool.query<AccessRequestRow>(
        `INSERT INTO access_request (shop_id, shopify_staff_user_id)
         VALUES ($1, $2)
         RETURNING *`,
        [shopId, staffUserId],
      );
      request = rows[0];
    } catch (err) {
      // access_request_one_pending: one pending request per (shop, staff).
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'a pending access request already exists for this staff user',
        );
      }
      throw err;
    }

    // §12. The requester has no member row (deny-by-default), so actor_id is
    // null; the staff identity is recorded in the payload, never a secret.
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: null,
      action: 'ACCESS_REQUEST_CREATED',
      objectType: 'access_request',
      objectId: request.request_id,
      after: {
        shopify_staff_user_id: staffUserId,
        resolution: 'PENDING',
      },
    });
    return request;
  }

  /** Owner lists requests (default: pending) — §9.1.2. */
  async list(
    shopId: string,
    resolution?: AccessRequestRow['resolution'],
  ): Promise<AccessRequestRow[]> {
    const params: unknown[] = [shopId];
    let filter = '';
    if (resolution) {
      params.push(resolution);
      filter = 'AND resolution = $2';
    }
    const { rows } = await this.pool.query<AccessRequestRow>(
      `SELECT request_id, shop_id, shopify_staff_user_id, requested_at,
              resolved_at, resolved_by, resolution, version
         FROM access_request
        WHERE shop_id = $1 ${filter}
        ORDER BY requested_at ASC`,
      params,
    );
    return rows;
  }

  /**
   * Owner grants a pending request (§3.19). GRANTED implies the shop_member
   * row is created in the SAME transaction (RW-17) — the request resolution
   * and the member insert/revive commit or roll back together.
   */
  async grant(
    shopId: string,
    ownerId: string,
    requestId: string,
    input: { role: MemberRole; version: number },
  ): Promise<{ request: AccessRequestRow; member: ShopMemberRow }> {
    if (input.role === 'OWNER') {
      throw new BadRequestException(
        'OWNER is not grantable via an access request (§9.1.2, OVR-1)',
      );
    }

    let outcome: { request: AccessRequestRow; member: ShopMemberRow };
    try {
      outcome = await this.withTransaction(async (client) => {
        const { rows: requests } = await client.query<AccessRequestRow>(
          `SELECT * FROM access_request
            WHERE shop_id = $1 AND request_id = $2
            FOR UPDATE`,
          [shopId, requestId],
        );
        const request = requests[0];
        if (!request) throw new NotFoundException('access request not found');
        if (request.resolution !== 'PENDING') {
          // §3.19: terminal states are never re-resolved.
          throw new ConflictException({
            message: `access request already ${request.resolution}`,
            current: request,
          });
        }

        const resolved = await client.query<AccessRequestRow>(
          `UPDATE access_request
              SET resolution = 'GRANTED', resolved_at = now(),
                  resolved_by = $3, version = version + 1
            WHERE shop_id = $1 AND request_id = $2
              AND resolution = 'PENDING' AND version = $4
            RETURNING *`,
          [shopId, requestId, ownerId, input.version],
        );
        if (resolved.rows.length === 0) {
          throw new ConflictException({
            message: 'version mismatch (INV-22)',
            current: request,
          });
        }

        // RW-17: create the member row in the same transaction. A revoked row
        // for this staff user is revived in place (shop_member_staff_key is
        // not partial); an active row means the request raced a direct grant.
        const { rows: members } = await client.query<ShopMemberRow>(
          `SELECT * FROM shop_member
            WHERE shop_id = $1 AND shopify_staff_user_id = $2
            FOR UPDATE`,
          [shopId, request.shopify_staff_user_id],
        );
        const existing = members[0];
        let member: ShopMemberRow;
        if (existing && existing.revoked_at === null) {
          throw new ConflictException('staff user is already an active member');
        } else if (existing) {
          const { rows } = await client.query<ShopMemberRow>(
            `UPDATE shop_member
                SET role = $3, granted_by = $4, granted_at = now(),
                    revoked_at = NULL, version = version + 1
              WHERE shop_id = $1 AND member_id = $2
              RETURNING *`,
            [shopId, existing.member_id, input.role, ownerId],
          );
          member = rows[0];
        } else {
          const { rows } = await client.query<ShopMemberRow>(
            `INSERT INTO shop_member
               (shop_id, shopify_staff_user_id, auth_source, role, granted_by)
             VALUES ($1, $2, 'SHOPIFY_STAFF', $3, $4)
             RETURNING *`,
            [shopId, request.shopify_staff_user_id, input.role, ownerId],
          );
          member = rows[0];
        }
        return { request: resolved.rows[0], member };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('staff user is already a member');
      }
      throw err;
    }

    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: ownerId,
      action: 'ACCESS_REQUEST_GRANTED',
      objectType: 'access_request',
      objectId: requestId,
      after: { resolution: 'GRANTED', member_id: outcome.member.member_id },
    });
    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: ownerId,
      action: 'MEMBER_ROLE_GRANTED',
      objectType: 'shop_member',
      objectId: outcome.member.member_id,
      after: {
        role: outcome.member.role,
        auth_source: outcome.member.auth_source,
        via_access_request: requestId,
      },
    });
    return outcome;
  }

  /** Owner denies a pending request (§3.19 DENIED, terminal). */
  async deny(
    shopId: string,
    ownerId: string,
    requestId: string,
    input: { version: number; reason?: string },
  ): Promise<AccessRequestRow> {
    const request = await this.findRequest(shopId, requestId);
    if (!request) throw new NotFoundException('access request not found');
    if (request.resolution !== 'PENDING') {
      throw new ConflictException({
        message: `access request already ${request.resolution}`,
        current: request,
      });
    }

    const { rows } = await this.pool.query<AccessRequestRow>(
      `UPDATE access_request
          SET resolution = 'DENIED', resolved_at = now(),
              resolved_by = $3, version = version + 1
        WHERE shop_id = $1 AND request_id = $2
          AND resolution = 'PENDING' AND version = $4
        RETURNING *`,
      [shopId, requestId, ownerId, input.version],
    );
    if (rows.length === 0) {
      await this.conflictWithCurrentRequest(shopId, requestId);
    }

    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: ownerId,
      action: 'ACCESS_REQUEST_DENIED',
      objectType: 'access_request',
      objectId: requestId,
      after: { resolution: 'DENIED' },
      reason: input.reason ?? null,
    });
    return rows[0];
  }

  /**
   * Requester withdraws their own pending request (§3.19 WITHDRAWN,
   * terminal). staffUserId is the requester's verified identity — from the
   * entry layer (internal variant) or the session's member row.
   */
  async withdraw(
    shopId: string,
    staffUserId: string,
    requestId: string,
    input: { version: number },
  ): Promise<AccessRequestRow> {
    const request = await this.findRequest(shopId, requestId);
    if (!request) throw new NotFoundException('access request not found');
    if (request.shopify_staff_user_id !== staffUserId) {
      throw new ForbiddenException('only the requester can withdraw');
    }
    if (request.resolution !== 'PENDING') {
      throw new ConflictException({
        message: `access request already ${request.resolution}`,
        current: request,
      });
    }

    const { rows } = await this.pool.query<AccessRequestRow>(
      `UPDATE access_request
          SET resolution = 'WITHDRAWN', resolved_at = now(),
              version = version + 1
        WHERE shop_id = $1 AND request_id = $2
          AND resolution = 'PENDING' AND version = $3
        RETURNING *`,
      [shopId, requestId, input.version],
    );
    if (rows.length === 0) {
      await this.conflictWithCurrentRequest(shopId, requestId);
    }

    await this.audit.record({
      shopId,
      actorKind: 'MEMBER',
      actorId: null,
      action: 'ACCESS_REQUEST_WITHDRAWN',
      objectType: 'access_request',
      objectId: requestId,
      after: { resolution: 'WITHDRAWN' },
    });
    return rows[0];
  }
}
