import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { NotificationService } from '../notifications/notification.service';
import { NOTIFICATION_EVENTS } from '../notifications/notifications.types';
import { ComposeAnnouncementDto } from './support.dto';
import { AnnouncementRow } from './support.types';

/** Merchant-side view of a visible announcement (§9.19). */
export interface VisibleAnnouncement {
  announcement_id: string;
  title: string;
  body: string;
  type: string;
  /** Optional illustration (§9.19). http(s) only — validated at the DTO. */
  image_url: string | null;
  published_at: string;
  expires_at: string | null;
  /** announcement_read.read_at for this member (null = unread badge counts it). */
  read_at: string | null;
  /** announcement_read.dismissed_at for this member (null = banner-eligible). */
  dismissed_at: string | null;
}

interface AudienceRef {
  planCode?: string;
  shopIds?: string[];
}

/**
 * Announcements (§9.19, §3.29, §3.31). The announcement table is global;
 * merchant visibility is decided by audience matching:
 *   ALL            — every shop (audience_ref MUST be null, §2 CHECK)
 *   BY_PLAN        — the shop's current subscription plan code
 *   SPECIFIC_SHOPS — membership in the audience_ref shop id list
 * Dismissal is per Member (announcement_read); the unread badge counts
 * visible announcements with no announcement_read row for the member; the
 * banner is the latest undismissed one.
 *
 * Email rule (A2-09): only type WARNING emails Members, via
 * NotificationService ('announcement'); INFO/UPDATE are in-app only.
 * INV-21: a mail failure never gates a publish.
 */
@Injectable()
export class AnnouncementService {
  private readonly logger = new Logger(AnnouncementService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly notifications: NotificationService,
  ) {}

  /* ---------------------------- Admin side ---------------------------- */

  async compose(adminId: string, dto: ComposeAnnouncementDto): Promise<AnnouncementRow> {
    const ref = this.validateAudienceRef(dto);
    const { rows } = await this.pool.query<AnnouncementRow>(
      `INSERT INTO announcement (title, body, type, audience_kind, audience_ref, image_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING announcement_id, title, body, type, audience_kind,
                 audience_ref, image_url, published_at, expires_at, created_at`,
      [
        dto.title,
        dto.body,
        dto.type,
        dto.audienceKind,
        ref === null ? null : JSON.stringify(ref),
        dto.imageUrl ?? null,
      ],
    );
    return rows[0];
  }

  async listAll(): Promise<AnnouncementRow[]> {
    const { rows } = await this.pool.query<AnnouncementRow>(
      `SELECT announcement_id, title, body, type, audience_kind, audience_ref,
              image_url, published_at, expires_at, created_at
         FROM announcement
        ORDER BY created_at DESC`,
    );
    return rows;
  }

  /**
   * Publish (sets published_at = now). A WARNING announcement emails all
   * Members of every targeted shop through the notification matrix (A2-09);
   * other types stay in-app. Per-shop send failures are logged and skipped —
   * they never fail the publish (INV-21).
   */
  async publish(adminId: string, announcementId: string): Promise<AnnouncementRow> {
    const { rows } = await this.pool.query<AnnouncementRow>(
      `UPDATE announcement
          SET published_at = COALESCE(published_at, now())
        WHERE announcement_id = $1
        RETURNING announcement_id, title, body, type, audience_kind,
                  audience_ref, published_at, expires_at, created_at`,
      [announcementId],
    );
    const announcement = rows[0];
    if (!announcement) throw new NotFoundException('announcement not found');

    const shopIds = await this.targetShopIds(announcement);
    for (const shopId of shopIds) {
      try {
        // The matrix itself decides channels: email only when WARNING (A2-09).
        await this.notifications.notify(shopId, NOTIFICATION_EVENTS.ANNOUNCEMENT, {
          announcementType: announcement.type,
          subject: announcement.title,
          body: announcement.body,
          link: '/support/announcements',
        });
      } catch (err) {
        // INV-21 — class only, never payload (§5.7 control 4).
        this.logger.error(
          `announcement notify failed: ${err instanceof Error ? err.name : 'Error'}`,
        );
      }
    }
    return announcement;
  }

  /** Expire: the announcement stops being visible from now on. */
  async expire(adminId: string, announcementId: string): Promise<AnnouncementRow> {
    const { rows } = await this.pool.query<AnnouncementRow>(
      `UPDATE announcement
          SET expires_at = now()
        WHERE announcement_id = $1
        RETURNING announcement_id, title, body, type, audience_kind,
                  audience_ref, published_at, expires_at, created_at`,
      [announcementId],
    );
    if (!rows[0]) throw new NotFoundException('announcement not found');
    return rows[0];
  }

  /* --------------------------- Merchant side -------------------------- */

  /** §9.19 Announcements section: every announcement visible to this shop. */
  async listVisible(
    shopId: string,
    memberId: string,
  ): Promise<VisibleAnnouncement[]> {
    const planCode = await this.shopPlanCode(shopId);
    const { rows } = await this.pool.query<VisibleAnnouncement>(
      `SELECT a.announcement_id, a.title, a.body, a.type, a.image_url, a.published_at,
              a.expires_at, r.read_at, r.dismissed_at
         FROM announcement a
         LEFT JOIN announcement_read r
           ON r.announcement_id = a.announcement_id AND r.member_id = $2
        WHERE a.published_at IS NOT NULL
          AND a.published_at <= now()
          AND (a.expires_at IS NULL OR a.expires_at > now())
          AND (
            a.audience_kind = 'ALL'
            OR (a.audience_kind = 'BY_PLAN'
                AND a.audience_ref ->> 'planCode' = $3)
            OR (a.audience_kind = 'SPECIFIC_SHOPS'
                AND a.audience_ref -> 'shopIds' ? $1)
          )
        ORDER BY a.published_at DESC`,
      [shopId, memberId, planCode],
    );
    return rows;
  }

  /** §9.19 unread badge: visible announcements with no announcement_read row. */
  async unreadCount(shopId: string, memberId: string): Promise<number> {
    const visible = await this.listVisible(shopId, memberId);
    return visible.filter((a) => a.read_at === null).length;
  }

  /** §9.19 dismissible banner: the latest undismissed visible announcement. */
  async banner(
    shopId: string,
    memberId: string,
  ): Promise<VisibleAnnouncement | null> {
    const visible = await this.listVisible(shopId, memberId);
    return visible.find((a) => a.dismissed_at === null) ?? null;
  }

  /**
   * §9.19 dismissal is per Member: upsert the member's announcement_read row.
   * Dismissing also marks read — a dismissed item leaves the unread badge.
   */
  async dismiss(
    shopId: string,
    memberId: string,
    announcementId: string,
  ): Promise<void> {
    // INV-1: a member may only dismiss what is visible to their shop.
    const visible = await this.listVisible(shopId, memberId);
    if (!visible.some((a) => a.announcement_id === announcementId)) {
      throw new NotFoundException('announcement not found');
    }
    await this.pool.query(
      `INSERT INTO announcement_read
         (announcement_id, shop_id, member_id, read_at, dismissed_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (announcement_id, member_id)
       DO UPDATE SET dismissed_at = now(),
                     read_at = COALESCE(announcement_read.read_at, now())`,
      [announcementId, shopId, memberId],
    );
  }

  /* ----------------------------- Internals ---------------------------- */

  /**
   * §3.29 audience_ref validation — mirrors the §2 CHECK (ALL ⇒ null) and
   * fixes the per-kind shapes so bad input is a 400, never a 500.
   */
  private validateAudienceRef(dto: ComposeAnnouncementDto): AudienceRef | null {
    const ref = (dto.audienceRef ?? null) as AudienceRef | null;
    if (dto.audienceKind === 'ALL') {
      if (ref !== null) {
        throw new BadRequestException(
          'audience_ref MUST be null when audience is ALL (§3.29)',
        );
      }
      return null;
    }
    if (dto.audienceKind === 'BY_PLAN') {
      if (typeof ref?.planCode !== 'string' || ref.planCode.trim() === '') {
        throw new BadRequestException(
          'BY_PLAN requires audience_ref {planCode} (§3.29)',
        );
      }
      return { planCode: ref.planCode };
    }
    // SPECIFIC_SHOPS
    if (
      !Array.isArray(ref?.shopIds) ||
      ref.shopIds.length === 0 ||
      ref.shopIds.some((id) => typeof id !== 'string')
    ) {
      throw new BadRequestException(
        'SPECIFIC_SHOPS requires audience_ref {shopIds: string[]} (§3.29)',
      );
    }
    return { shopIds: ref.shopIds };
  }

  /** The shop's current plan code — latest subscription row. */
  private async shopPlanCode(shopId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ code: string }>(
      `SELECT p.code
         FROM subscription s
         JOIN plan p ON p.plan_id = s.plan_id
        WHERE s.shop_id = $1
        ORDER BY s.created_at DESC
        LIMIT 1`,
      [shopId],
    );
    return rows[0]?.code ?? null;
  }

  /** §3.29 audience resolution to concrete shop ids (for WARNING mail). */
  private async targetShopIds(announcement: AnnouncementRow): Promise<string[]> {
    if (announcement.audience_kind === 'ALL') {
      const { rows } = await this.pool.query<{ shop_id: string }>(
        `SELECT shop_id FROM shop WHERE uninstalled_at IS NULL`,
      );
      return rows.map((r) => r.shop_id);
    }
    const ref = (announcement.audience_ref ?? {}) as AudienceRef;
    if (announcement.audience_kind === 'BY_PLAN') {
      const { rows } = await this.pool.query<{ shop_id: string }>(
        `SELECT DISTINCT s.shop_id
           FROM subscription s
           JOIN plan p ON p.plan_id = s.plan_id
          WHERE p.code = $1`,
        [ref.planCode ?? ''],
      );
      return rows.map((r) => r.shop_id);
    }
    return ref.shopIds ?? [];
  }
}
