import { describe, expect, it } from 'vitest';
import { ThrottleService } from '../../src/modules/notifications/throttle.service';
import { THROTTLE_WINDOW_SECONDS } from '../../src/modules/notifications/notifications.types';
import { FakeRedis, SHOP } from './helpers';
import Redis from 'ioredis';

describe('ThrottleService (S-46: 1 per recipient per hour, with a count)', () => {
  it('allows the first occurrence, suppresses and counts the rest of the hour', async () => {
    const throttle = new ThrottleService(new FakeRedis() as unknown as Redis);
    const t0 = new Date('2026-08-05T10:00:00Z');

    const first = await throttle.check(SHOP, 'courier.disconnected', 'member-1', t0);
    expect(first).toEqual({ allowed: true, previouslySuppressed: 0 });

    const second = await throttle.check(
      SHOP, 'courier.disconnected', 'member-1',
      new Date(t0.getTime() + 5 * 60_000),
    );
    expect(second.allowed).toBe(false);

    const third = await throttle.check(
      SHOP, 'courier.disconnected', 'member-1',
      new Date(t0.getTime() + 10 * 60_000),
    );
    expect(third.allowed).toBe(false);

    // The next window's first send is allowed AND reports the count.
    const nextWindow = await throttle.check(
      SHOP, 'courier.disconnected', 'member-1',
      new Date(t0.getTime() + (THROTTLE_WINDOW_SECONDS + 1) * 1000),
    );
    expect(nextWindow).toEqual({ allowed: true, previouslySuppressed: 2 });
  });

  it('throttles per recipient and per event independently', async () => {
    const throttle = new ThrottleService(new FakeRedis() as unknown as Redis);
    const t0 = new Date('2026-08-05T10:00:00Z');

    await throttle.check(SHOP, 'courier.disconnected', 'member-1', t0);
    const otherMember = await throttle.check(SHOP, 'courier.disconnected', 'member-2', t0);
    const otherEvent = await throttle.check(SHOP, 'billing.allowance_80', 'member-1', t0);
    expect(otherMember.allowed).toBe(true);
    expect(otherEvent.allowed).toBe(true);
  });
});
