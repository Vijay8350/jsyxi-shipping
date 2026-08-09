import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import { MemberRole } from '../../auth/session.types';
import { MessageDispatcherService } from './message-dispatcher.service';
import { NotificationSettingsService } from './notification-settings.service';

/**
 * §9.21 digests: items accumulate in Redis lists as events fire (S-42 NDR
 * digest; daily pickup/delayed digest; daily COD-unassigned/invoice-pending
 * digest) and a BullMQ repeatable job (notifications-queue.ts) calls
 * runDigestTick() every hour. A digest is due in SHOP-LOCAL time (§5.2):
 * daily/weekly digests go out at the shop's digestHourLocal (default 09:00,
 * weekly on Monday — §5.2 week starts Monday), hourly NDR digests every tick.
 *
 * Fire-and-observe (INV-21): tick errors are logged per shop, never thrown.
 */

export type DigestGroup = 'ndr' | 'ops' | 'finance';

const GROUP_EVENT: Record<DigestGroup, string> = {
  ndr: 'ndr.digest',
  ops: 'ops.digest',
  finance: 'finance.digest',
};

const GROUP_SUBJECT: Record<DigestGroup, string> = {
  ndr: 'NDR digest',
  ops: 'Operations digest: pickups and delayed shipments',
  finance: 'COD / invoice digest',
};

interface ShopRow {
  shop_id: string;
  iana_timezone: string;
}

interface MemberRow {
  member_id: string;
  role: MemberRole;
  email: string | null;
}

@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly dispatcher: MessageDispatcherService,
    private readonly settings: NotificationSettingsService,
  ) {}

  private key(shopId: string, group: DigestGroup): string {
    return `notif:digest:${shopId}:${group}`;
  }

  /** Append one line to a shop's pending digest (called by NotificationService). */
  async enqueue(shopId: string, group: DigestGroup, line: string): Promise<void> {
    await this.redis.rpush(this.key(shopId, group), line);
  }

  /** §5.2: the shop-local wall clock for a tick instant. */
  localTime(
    ianaTimezone: string,
    now: Date,
  ): { hour: number; monday: boolean } {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: ianaTimezone,
      hour: 'numeric',
      hour12: false,
      weekday: 'short',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
    const monday = parts.find((p) => p.type === 'weekday')?.value === 'Mon';
    return { hour, monday };
  }

  private async drain(shopId: string, group: DigestGroup): Promise<string[]> {
    const key = this.key(shopId, group);
    const lines = await this.redis.lrange(key, 0, -1);
    if (lines.length > 0) await this.redis.del(key);
    return lines;
  }

  private async recipients(
    shopId: string,
    group: DigestGroup,
  ): Promise<MemberRow[]> {
    if (group === 'ndr') {
      // S-41: explicit per-shop recipient list (member uuids); empty/absent
      // falls back to the Owner (S-41 default is "the Owner's email", §7).
      const ndr = await this.pool.query<{ recipients: string[] }>(
        `SELECT recipients FROM ndr_settings WHERE shop_id = $1`,
        [shopId],
      );
      const ids = Array.isArray(ndr.rows[0]?.recipients)
        ? ndr.rows[0].recipients
        : [];
      if (ids.length > 0) {
        const result = await this.pool.query<MemberRow>(
          `SELECT member_id, role, email FROM shop_member
            WHERE shop_id = $1 AND revoked_at IS NULL AND member_id = ANY($2::uuid[])`,
          [shopId, ids],
        );
        if (result.rows.length > 0) return result.rows;
      }
      return this.ownerFallback(shopId);
    }
    const roles: MemberRole[] =
      group === 'ops' ? ['OPERATOR'] : ['OWNER', 'FINANCE'];
    const result = await this.pool.query<MemberRow>(
      `SELECT member_id, role, email FROM shop_member
        WHERE shop_id = $1 AND revoked_at IS NULL AND role = ANY($2)`,
      [shopId, roles],
    );
    if (result.rows.length > 0) return result.rows;
    // §9.21: no Member holds the named role → fall back to the Owner.
    return this.ownerFallback(shopId);
  }

  private async ownerFallback(shopId: string): Promise<MemberRow[]> {
    const owner = await this.pool.query<MemberRow>(
      `SELECT member_id, role, email FROM shop_member
        WHERE shop_id = $1 AND revoked_at IS NULL AND role = 'OWNER'`,
      [shopId],
    );
    return owner.rows;
  }

  private async ndrDue(
    shopId: string,
    local: { hour: number; monday: boolean },
    digestHour: number,
  ): Promise<boolean> {
    // S-42: digest frequency from ndr_settings (default daily).
    const result = await this.pool.query<{ digest_frequency: string }>(
      `SELECT digest_frequency FROM ndr_settings WHERE shop_id = $1`,
      [shopId],
    );
    const frequency = result.rows[0]?.digest_frequency ?? 'daily';
    if (frequency === 'hourly') return true;
    if (frequency === 'weekly') return local.monday && local.hour === digestHour;
    return local.hour === digestHour;
  }

  private async sendGroup(
    shopId: string,
    group: DigestGroup,
  ): Promise<number> {
    const lines = await this.drain(shopId, group);
    if (lines.length === 0) return 0;
    const members = await this.recipients(shopId, group);
    const body = lines.map((l) => `• ${l}`).join('\n');
    let sent = 0;
    for (const member of members) {
      if (!member.email) continue;
      const result = await this.dispatcher.dispatch({
        shopId,
        channel: 'EMAIL',
        event: GROUP_EVENT[group],
        to: member.email,
        subject: `${GROUP_SUBJECT[group]} (${lines.length} item(s))`,
        body,
      });
      if (result.state !== 'FAILED') sent += 1;
    }
    return sent;
  }

  /** One hourly tick across all shops — plain injectable, unit-testable. */
  async runDigestTick(now: Date = new Date()): Promise<void> {
    const shops = await this.pool.query<ShopRow>(
      `SELECT shop_id, iana_timezone FROM shop WHERE uninstalled_at IS NULL`,
    );
    for (const shop of shops.rows) {
      try {
        const local = this.localTime(shop.iana_timezone, now);
        const digestHour = await this.settings.digestHourLocal(shop.shop_id);
        if (await this.ndrDue(shop.shop_id, local, digestHour)) {
          await this.sendGroup(shop.shop_id, 'ndr');
        }
        if (local.hour === digestHour) {
          await this.sendGroup(shop.shop_id, 'ops');
          await this.sendGroup(shop.shop_id, 'finance');
        }
      } catch (err) {
        // INV-21: one shop's digest failure must not affect the others.
        this.logger.error(
          `digest tick failed for a shop: ${err instanceof Error ? err.name : 'Error'}`,
        );
      }
    }
  }
}
