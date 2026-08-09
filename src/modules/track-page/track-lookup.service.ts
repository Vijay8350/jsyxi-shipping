import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import { saltedPiiHash } from '../../common/crypto';
import { normalizeAwb } from '../booking/snapshot';
import { CAPTCHA_VERIFIER, CaptchaVerifier } from './captcha-verifier';
import { shopRefRedisKey } from './shop-ref';
import { TrackPageConfigService } from './track-page-config.service';
import {
  TrackPageDataService,
  TrackShipmentRow,
} from './track-page-data.service';
import {
  LOOKUP_GENERIC_ERROR,
  LOOKUP_THROTTLE,
  TrackLookupView,
} from './track-page.types';
import { TrackLookupDto } from './track-page.dto';

/**
 * Manual lookup path (§9.16 path 2, S-38, §5.7 control 4).
 *
 * - Match rule: (Order ID or AWB) AND (full normalized email or full
 *   normalized phone), matched against the shipment's §2.9 snapshot
 *   recipient, within ONE shop (INV-1). By Order ID every shipment on that
 *   order is listed, each with its own timeline; by AWB that shipment only.
 * - ONE generic failure body for every failure mode (wrong shop, unknown
 *   identifier, wrong contact) — no oracle. The only distinct responses are
 *   the throttle and CAPTCHA signals, which depend on attempt counts, never
 *   on whether the identifier exists.
 * - Throttle (S-38): 10 attempts / 10 min per IP (per shop — the abuse log
 *   is shop-scoped), 30 / hour per Shop, CAPTCHA required after 5
 *   consecutive failures. Counters live in Redis (fast path) and are
 *   corroborated from track_lookup_attempt (durable path).
 * - Every attempt, success and failure, writes track_lookup_attempt with
 *   salted hashes only — never raw identifiers or raw IPs (§5.7 control 4,
 *   §12: abuse logs never carry raw buyer PII).
 * - Redaction (§5.5): a nulled snapshot recipient can never match a contact,
 *   so a redacted order fails generic — buyer access is revoked while the
 *   token path keeps rendering from the timeline.
 */

interface LookupShipmentRow extends TrackShipmentRow {
  snapshot: (TrackShipmentRow['snapshot'] & {
    recipient?: { phone?: string | null; email?: string | null } | null;
  }) | null;
}

/** §9.16 contact normalization: full value only, never partial. */
export function normalizeContact(raw: string): {
  kind: 'email' | 'phone';
  value: string;
} {
  const v = raw.normalize('NFC').trim();
  if (v.includes('@')) return { kind: 'email', value: v.toLowerCase() };
  // Phone: digits only; an Indian number may arrive as 91XXXXXXXXXX or
  // 0XXXXXXXXXX — normalize both to the 10-digit national number.
  let digits = v.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return { kind: 'phone', value: digits };
}

function contactMatchesRecipient(
  contact: { kind: 'email' | 'phone'; value: string },
  recipient: { phone?: string | null; email?: string | null } | null | undefined,
): boolean {
  if (!recipient) return false; // redacted recipient never matches (§5.5)
  if (contact.kind === 'email') {
    if (!recipient.email) return false;
    return normalizeContact(recipient.email).value === contact.value;
  }
  if (!recipient.phone) return false;
  const stored = normalizeContact(recipient.phone);
  return stored.kind === 'phone' && stored.value === contact.value;
}

@Injectable()
export class TrackLookupService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
    @Inject(CAPTCHA_VERIFIER) private readonly captcha: CaptchaVerifier,
    private readonly pageConfig: TrackPageConfigService,
    private readonly pageData: TrackPageDataService,
  ) {}

  private salt(): string {
    return this.config.get<string>('crypto.piiHashSalt') ?? '';
  }

  /** shopPublicRef → shop_id via the reverse map (see shop-ref.ts). */
  async resolveShopRef(shopRef: string): Promise<string | null> {
    return this.redis.get(shopRefRedisKey(shopRef));
  }

  private async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, ttlSeconds);
    return count;
  }

  /** §5.7 control 4: the abuse log row carries salted hashes only. */
  private async logAttempt(
    shopId: string,
    ipHash: string,
    identifierHash: string,
    success: boolean,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO track_lookup_attempt (shop_id, ip_hash, identifier_hash, success)
       VALUES ($1, $2, $3, $4)`,
      [shopId, ipHash, identifierHash, success],
    );
  }

  /**
   * Consecutive failures for (shop, ip): Redis fast path corroborated by the
   * durable track_lookup_attempt tail (S-38 — CAPTCHA after 5).
   */
  private async consecutiveFailures(
    shopId: string,
    ipHash: string,
  ): Promise<number> {
    const redisCount = Number(
      (await this.redis.get(`track:fail:${shopId}:${ipHash}`)) ?? 0,
    );
    const recent = await this.pool.query<{ success: boolean }>(
      `SELECT success FROM track_lookup_attempt
        WHERE shop_id = $1 AND ip_hash = $2
        ORDER BY created_at DESC
        LIMIT ${LOOKUP_THROTTLE.captchaAfterFailures}`,
      [shopId, ipHash],
    );
    let dbCount = 0;
    for (const row of recent.rows) {
      if (row.success) break;
      dbCount += 1;
    }
    return Math.max(redisCount, dbCount);
  }

  private async recordFailure(shopId: string, ipHash: string): Promise<void> {
    await this.incrWithTtl(`track:fail:${shopId}:${ipHash}`, 3600);
  }

  private async recordSuccess(shopId: string, ipHash: string): Promise<void> {
    await this.redis.del(`track:fail:${shopId}:${ipHash}`);
  }

  private async findByAwb(
    shopId: string,
    awb: string,
  ): Promise<LookupShipmentRow[]> {
    const result = await this.pool.query<LookupShipmentRow>(
      `SELECT s.shipment_id, s.shop_id, s.order_id, s.movement_state,
              s.awb_raw, s.is_test, s.snapshot, c.name AS courier_name
         FROM shipment s
         LEFT JOIN courier_account ca
           ON ca.courier_account_id = s.courier_account_id
         LEFT JOIN courier c ON c.courier_id = ca.courier_id
        WHERE s.shop_id = $1 AND s.awb_normalized = $2`,
      [shopId, awb],
    );
    return result.rows;
  }

  private async findByOrderNumber(
    shopId: string,
    orderNumber: string,
  ): Promise<LookupShipmentRow[]> {
    const result = await this.pool.query<LookupShipmentRow>(
      `SELECT s.shipment_id, s.shop_id, s.order_id, s.movement_state,
              s.awb_raw, s.is_test, s.snapshot, c.name AS courier_name
         FROM shipment s
         JOIN "order" o ON o.order_id = s.order_id
         LEFT JOIN courier_account ca
           ON ca.courier_account_id = s.courier_account_id
         LEFT JOIN courier c ON c.courier_id = ca.courier_id
        WHERE s.shop_id = $1
          AND upper(trim(both '#' from o.shopify_order_number)) = $2
        ORDER BY s.created_at ASC`,
      [shopId, orderNumber],
    );
    return result.rows;
  }

  async lookup(dto: TrackLookupDto, ip: string): Promise<TrackLookupView> {
    const generic: TrackLookupView = { ok: false, error: LOOKUP_GENERIC_ERROR };
    const ipHash = saltedPiiHash(this.salt(), ip || 'unknown');
    const awb = normalizeAwb(dto.identifier);
    const orderNumber = dto.identifier
      .normalize('NFC')
      .trim()
      .replace(/^#+/, '')
      .toUpperCase();
    // The log correlates abuse on the normalized identifier, never the raw
    // value (§5.7 control 4).
    const identifierHash = saltedPiiHash(this.salt(), awb || orderNumber);

    // 1. Resolve the shop. An unknown ref fails generic; the IP still counts
    //    against a shop-less bucket so ref brute-forcing is throttled too.
    const shopId = await this.resolveShopRef(dto.shopRef);
    if (!shopId) {
      await this.incrWithTtl(
        `track:thr:ip:unknown:${ipHash}`,
        LOOKUP_THROTTLE.ipWindowSeconds,
      );
      return generic;
    }

    // 2. Uninstall revokes buyer access (§5.5, §9.16).
    const shop = await this.pool.query<{ account_state: string }>(
      `SELECT account_state FROM shop WHERE shop_id = $1`,
      [shopId],
    );
    if (!shop.rows[0] || shop.rows[0].account_state === 'UNINSTALLED') {
      await this.logAttempt(shopId, ipHash, identifierHash, false);
      return generic;
    }

    // 3. S-38 throttle counters (Redis, per window).
    const ipCount = await this.incrWithTtl(
      `track:thr:ip:${shopId}:${ipHash}`,
      LOOKUP_THROTTLE.ipWindowSeconds,
    );
    const shopCount = await this.incrWithTtl(
      `track:thr:shop:${shopId}`,
      LOOKUP_THROTTLE.shopWindowSeconds,
    );
    if (
      ipCount > LOOKUP_THROTTLE.ipAttempts ||
      shopCount > LOOKUP_THROTTLE.shopAttempts
    ) {
      await this.logAttempt(shopId, ipHash, identifierHash, false);
      await this.recordFailure(shopId, ipHash);
      return {
        ok: false,
        error: 'Too many attempts. Please try again later.',
      };
    }

    // 4. S-38 CAPTCHA escalation after 5 consecutive failures.
    const failures = await this.consecutiveFailures(shopId, ipHash);
    if (failures >= LOOKUP_THROTTLE.captchaAfterFailures) {
      const solved =
        dto.captchaToken !== undefined &&
        (await this.captcha.verify(dto.captchaToken, ipHash));
      if (!solved) {
        await this.logAttempt(shopId, ipHash, identifierHash, false);
        await this.recordFailure(shopId, ipHash);
        return { ok: false, error: LOOKUP_GENERIC_ERROR, captchaRequired: true };
      }
    }

    // 5. Match — AWB first (one shipment), then Order ID (every shipment on
    //    the order). Contact verified against the §2.9 snapshot recipient.
    const contact = normalizeContact(dto.contact);
    const byAwb = await this.findByAwb(shopId, awb);
    let matched: LookupShipmentRow[] = [];
    if (byAwb.length > 0) {
      const hit = byAwb.find((row) =>
        contactMatchesRecipient(contact, row.snapshot?.recipient),
      );
      if (hit) matched = [hit];
    } else {
      const onOrder = await this.findByOrderNumber(shopId, orderNumber);
      if (
        onOrder.length > 0 &&
        onOrder.some((row) =>
          contactMatchesRecipient(contact, row.snapshot?.recipient),
        )
      ) {
        matched = onOrder; // §9.16: EVERY shipment on the order
      }
    }

    if (matched.length === 0) {
      await this.logAttempt(shopId, ipHash, identifierHash, false);
      await this.recordFailure(shopId, ipHash);
      return generic;
    }

    // 6. Success — reset the consecutive-failure counter and render.
    await this.logAttempt(shopId, ipHash, identifierHash, true);
    await this.recordSuccess(shopId, ipHash);

    const config = await this.pageConfig.getForRender(shopId);
    const shipments = await Promise.all(
      matched.map(async (row) =>
        this.pageData.buildShipmentData(
          row,
          await this.pageData.loadTimeline(shopId, row.shipment_id),
          config,
        ),
      ),
    );
    return {
      ok: true,
      branding: this.pageData.branding(config),
      shipments,
    };
  }
}
