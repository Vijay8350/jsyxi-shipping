import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackService } from '../../src/modules/support/feedback.service';
import { MEMBER_ID, mockPool, routeBySql, SHOP_ID } from './helpers';

describe('FeedbackService (§9.19)', () => {
  let pool: ReturnType<typeof mockPool>['pool'];
  let service: FeedbackService;

  beforeEach(() => {
    ({ pool } = mockPool());
    service = new FeedbackService(pool as never);
  });

  it('stores rating, comment and screenshot key, shop-scoped (INV-1)', async () => {
    routeBySql(pool.query, [
      [
        'INSERT INTO feedback',
        () => ({
          rows: [
            {
              feedback_id: 'f1',
              shop_id: SHOP_ID,
              member_id: MEMBER_ID,
              rating: 4,
              comment: 'Solid, labels could be faster.',
              screenshot_object_key: 'shops/x/feedback/shot.png',
              created_at: '2026-08-01T00:00:00.000Z',
            },
          ],
        }),
      ],
    ]);
    const row = await service.submit(SHOP_ID, MEMBER_ID, {
      rating: 4,
      comment: 'Solid, labels could be faster.',
      screenshot: { key: 'shops/x/feedback/shot.png', bytes: 1024 },
    });
    expect(row.rating).toBe(4);
    const [, params] = pool.query.mock.calls[0];
    expect(params).toEqual([
      SHOP_ID,
      MEMBER_ID,
      4,
      'Solid, labels could be faster.',
      'shops/x/feedback/shot.png',
    ]);
  });

  it('§5.1: the screenshot must be a PNG or JPEG', async () => {
    await expect(
      service.submit(SHOP_ID, MEMBER_ID, {
        rating: 5,
        screenshot: { key: 'shops/x/feedback/shot.gif', bytes: 1024 },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('accepts jpeg (case-insensitive extension)', async () => {
    routeBySql(pool.query, [
      ['INSERT INTO feedback', () => ({ rows: [{ feedback_id: 'f2' }] })],
    ]);
    await expect(
      service.submit(SHOP_ID, MEMBER_ID, {
        rating: 5,
        screenshot: { key: 'shops/x/feedback/SHOT.JPEG', bytes: 1024 },
      }),
    ).resolves.toEqual({ feedback_id: 'f2' });
  });

  it('§9.19 trends: average rating by week, count included', async () => {
    routeBySql(pool.query, [
      [
        "date_trunc('week'",
        () => ({
          rows: [
            { week: '2026-07-27T00:00:00.000Z', count: '3', avg: '4.33' },
            { week: '2026-07-20T00:00:00.000Z', count: '1', avg: '2.00' },
          ],
        }),
      ],
    ]);
    const trends = await service.trends();
    expect(trends).toEqual([
      { week: '2026-07-27T00:00:00.000Z', count: 3, avgRating: '4.33' },
      { week: '2026-07-20T00:00:00.000Z', count: 1, avgRating: '2.00' },
    ]);
  });
});
