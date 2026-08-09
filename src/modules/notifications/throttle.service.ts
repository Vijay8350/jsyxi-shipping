import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../../redis/redis.module';
import { THROTTLE_WINDOW_SECONDS } from './notifications.types';

/**
 * S-46 (§7, §9.21): same-event alert throttle — 1 per recipient per hour,
 * WITH A COUNT. The first occurrence in a window sends; later occurrences in
 * the same window are suppressed but counted. When the window lapses and the
 * event recurs, the new send carries the suppressed count so the merchant
 * sees "1 alert, N occurrences" rather than a silent hour.
 *
 * State lives in Redis (durable nothing — a lost counter only loses the
 * count, never a business fact; INV-21).
 */

interface WindowState {
  windowStart: number; // epoch ms
  count: number; // total occurrences in the window, first included
}

export interface ThrottleDecision {
  allowed: boolean;
  /** Occurrences suppressed in the window that just lapsed (0 normally) —
   *  the sender appends this to the body (S-46 "with a count"). */
  previouslySuppressed: number;
}

@Injectable()
export class ThrottleService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(shopId: string, event: string, recipientKey: string): string {
    return `notif:thr:${shopId}:${event}:${recipientKey}`;
  }

  async check(
    shopId: string,
    event: string,
    recipientKey: string,
    now: Date = new Date(),
  ): Promise<ThrottleDecision> {
    const key = this.key(shopId, event, recipientKey);
    const raw = await this.redis.get(key);
    const state: WindowState | null = raw ? (JSON.parse(raw) as WindowState) : null;
    const nowMs = now.getTime();
    const windowMs = THROTTLE_WINDOW_SECONDS * 1000;

    if (state && nowMs - state.windowStart < windowMs) {
      // Inside an open window: suppress, but count.
      const next: WindowState = { windowStart: state.windowStart, count: state.count + 1 };
      const ttl = Math.ceil((windowMs - (nowMs - state.windowStart)) / 1000);
      // Keep the key alive one extra window so the NEXT send can read the
      // suppressed count after this window lapses.
      await this.redis.set(key, JSON.stringify(next), 'EX', ttl + THROTTLE_WINDOW_SECONDS);
      return { allowed: false, previouslySuppressed: 0 };
    }

    const previouslySuppressed = state ? Math.max(0, state.count - 1) : 0;
    const next: WindowState = { windowStart: nowMs, count: 1 };
    await this.redis.set(key, JSON.stringify(next), 'EX', THROTTLE_WINDOW_SECONDS * 2);
    return { allowed: true, previouslySuppressed };
  }
}
