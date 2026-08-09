import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AuditService } from '../../audit/audit.service';
import {
  SUPPORT_CONTEXT_DEFAULT_MINUTES,
  SUPPORT_CONTEXT_MAX_MINUTES,
} from './admin.constants';
import { OpenSupportContextDto } from './support-context.dto';
import { AdminContext, SupportContextInfo } from './admin.types';
import { MerchantDirectoryService } from './merchant-directory.service';

/**
 * A1-07 / §10.3 support context: a separate, time-limited (≤ 60 min),
 * reason- or ticket-bound, read-only window over one merchant Shop.
 *
 * Enforcement shape:
 *   - time box: expires_at ≤ now() + 60 min; resolveAlive fails closed on
 *     expiry or early end — expired contexts are dead;
 *   - read-only + credential exclusion: SupportContextGuard rejects every
 *     non-GET and every credential-adjacent route while a context is active
 *     (by construction, not by endpoint discipline);
 *   - no PII export: the views below delegate to MerchantDirectoryService,
 *     which never selects credential or buyer columns;
 *   - §12: open, end and EVERY view is audit-logged with object ids only.
 */
@Injectable()
export class SupportContextService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly merchants: MerchantDirectoryService,
  ) {}

  async open(actor: AdminContext, dto: OpenSupportContextDto): Promise<SupportContextInfo> {
    if (!dto.ticketId && !dto.reason) {
      // Mirrors the table CHECK: reason- or ticket-bound, never anonymous.
      throw new BadRequestException('a support context needs a reason or a ticket');
    }
    const minutes = Math.min(
      Math.max(Math.floor(dto.ttlMinutes ?? SUPPORT_CONTEXT_DEFAULT_MINUTES), 1),
      SUPPORT_CONTEXT_MAX_MINUTES,
    );
    const shop = await this.pool.query(
      `SELECT 1 FROM shop WHERE shop_id = $1 AND uninstalled_at IS NULL`,
      [dto.shopId],
    );
    if (shop.rows.length === 0) throw new NotFoundException('shop not found');

    const { rows } = await this.pool.query<{
      context_id: string;
      started_at: Date;
      expires_at: Date;
    }>(
      `INSERT INTO support_context (shop_id, admin_id, ticket_id, reason, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval)
       RETURNING context_id, started_at, expires_at`,
      [dto.shopId, actor.adminId, dto.ticketId ?? null, dto.reason ?? '', String(minutes)],
    );
    // §12: "every admin support-context session with its reason or ticket".
    await this.audit.record({
      shopId: dto.shopId,
      actorKind: 'ADMIN',
      actorId: actor.adminId,
      action: 'support_context.opened',
      objectType: 'support_context',
      objectId: rows[0].context_id,
      after: {
        shop_id: dto.shopId,
        ticket_id: dto.ticketId ?? null,
        reason: dto.reason ?? null,
        ttl_minutes: minutes,
      },
    });
    return {
      contextId: rows[0].context_id,
      shopId: dto.shopId,
      adminId: actor.adminId,
      ticketId: dto.ticketId ?? null,
      reason: dto.reason ?? '',
      startedAt: rows[0].started_at,
      expiresAt: rows[0].expires_at,
    };
  }

  /** End early — the context dies immediately and can never be revived. */
  async end(actor: AdminContext, contextId: string): Promise<void> {
    const { rows, rowCount } = await this.pool.query<{ shop_id: string }>(
      `UPDATE support_context SET ended_at = now()
        WHERE context_id = $1 AND ended_at IS NULL AND expires_at > now()
        RETURNING shop_id`,
      [contextId],
    );
    if (!rowCount) throw new NotFoundException('support context not found or already dead');
    await this.audit.record({
      shopId: rows[0].shop_id,
      actorKind: 'ADMIN',
      actorId: actor.adminId,
      action: 'support_context.ended',
      objectType: 'support_context',
      objectId: contextId,
    });
  }

  /**
   * The guard's liveness check. Returns null for unknown, expired or ended
   * contexts — expired contexts are dead, and dead fails closed.
   */
  async resolveAlive(contextId: string): Promise<SupportContextInfo | null> {
    const { rows } = await this.pool.query<{
      context_id: string;
      shop_id: string;
      admin_id: string;
      ticket_id: string | null;
      reason: string;
      started_at: Date;
      expires_at: Date;
    }>(
      `SELECT context_id, shop_id, admin_id, ticket_id, reason, started_at, expires_at
         FROM support_context
        WHERE context_id = $1
          AND ended_at IS NULL
          AND expires_at > now()`,
      [contextId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      contextId: row.context_id,
      shopId: row.shop_id,
      adminId: row.admin_id,
      ticketId: row.ticket_id,
      reason: row.reason,
      startedAt: row.started_at,
      expiresAt: row.expires_at,
    };
  }

  // ------------------------------------------------------------------
  // Context-bound views. GET-only (the guard enforces it); every view is
  // audited with object ids only (§12), never with viewed content.
  // ------------------------------------------------------------------

  /** Merchant overview inside the context — read-only, no PII (§10.3). */
  async viewShopOverview(context: SupportContextInfo): Promise<unknown> {
    const detail = await this.merchants.merchantDetail(context.shopId);
    await this.recordView(context, 'shop', context.shopId);
    return detail;
  }

  /** ADD-31 health panel inside the context. */
  async viewSetupHealth(context: SupportContextInfo): Promise<unknown> {
    const { rows } = await this.pool.query(
      `SELECT item_key, state, detail, first_detected_at, updated_at
         FROM setup_health_item
        WHERE shop_id = $1
        ORDER BY (state = 'OK') ASC, item_key ASC`,
      [context.shopId],
    );
    await this.recordView(context, 'setup_health_item', context.shopId);
    return rows;
  }

  /**
   * Courier accounts inside the context: identity + health only. Credential
   * columns are never selected, and the guard blocks the credential routes
   * themselves by construction (INV-18, §10.3).
   */
  async viewCourierAccounts(context: SupportContextInfo): Promise<unknown> {
    const { rows } = await this.pool.query(
      `SELECT ca.courier_account_id, c.code AS courier_code, c.name AS courier_name,
              ca.mode, ca.health_state, ca.last_event_received_at
         FROM courier_account ca
         JOIN courier c ON c.courier_id = ca.courier_id
        WHERE ca.shop_id = $1 AND ca.disabled_at IS NULL
        ORDER BY c.code`,
      [context.shopId],
    );
    await this.recordView(context, 'courier_account', context.shopId);
    return rows;
  }

  /** §12: "everything viewed in it" — object ids only, never content. */
  async recordView(
    context: SupportContextInfo,
    objectType: string,
    objectId: string,
  ): Promise<void> {
    await this.audit.record({
      shopId: context.shopId,
      actorKind: 'ADMIN',
      actorId: context.adminId,
      action: 'support_context.viewed',
      objectType,
      objectId,
      after: { context_id: context.contextId },
    });
  }
}
