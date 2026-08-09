import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../../redis/redis.module';

/**
 * ADD-18 health-strip counters: events received and signature failures in
 * the last 24h per courier account. Hour-bucketed Redis counters (48h TTL);
 * the durable `last_event_received_at` lives on courier_account (§8.5).
 */

function hourBucket(d: Date): string {
  // YYYYMMDDHH in UTC — bucket labels only, never user data.
  return d.toISOString().slice(0, 13).replace(/[-T]/g, '');
}

@Injectable()
export class WebhookStatsService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(accountId: string, kind: 'ev' | 'sigfail', bucket: string): string {
    return `cf:wh:${accountId}:${kind}:${bucket}`;
  }

  private async bump(accountId: string, kind: 'ev' | 'sigfail', now: Date): Promise<void> {
    const key = this.key(accountId, kind, hourBucket(now));
    await this.redis.incr(key);
    await this.redis.expire(key, 48 * 3600);
  }

  recordEventReceived(accountId: string, now = new Date()): Promise<void> {
    return this.bump(accountId, 'ev', now);
  }

  recordSignatureFailure(accountId: string, now = new Date()): Promise<void> {
    return this.bump(accountId, 'sigfail', now);
  }

  /** ADD-18 health strip: counts over the trailing 24 hour-buckets. */
  async last24h(
    accountId: string,
    now = new Date(),
  ): Promise<{ events24h: number; signatureFailures24h: number }> {
    const buckets: string[] = [];
    for (let i = 0; i < 24; i++) {
      buckets.push(hourBucket(new Date(now.getTime() - i * 3600_000)));
    }
    const keys = (kind: 'ev' | 'sigfail') => buckets.map((b) => this.key(accountId, kind, b));
    const [ev, sf] = await Promise.all([
      this.redis.mget(...keys('ev')),
      this.redis.mget(...keys('sigfail')),
    ]);
    const sum = (vals: (string | null)[]) =>
      vals.reduce((acc, v) => acc + (v ? Number(v) : 0), 0);
    return { events24h: sum(ev), signatureFailures24h: sum(sf) };
  }
}
