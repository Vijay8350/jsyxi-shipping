import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it } from 'vitest';
import {
  AttachmentRefDto,
  CreateTicketDto,
  SubmitFeedbackDto,
} from '../../src/modules/support/support.dto';
import {
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  TICKET_ATTACHMENT_MAX_BYTES,
} from '../../src/modules/support/support.types';

/**
 * DTO-level validation (§5.1 envelopes, §9.19 rating range). The service
 * specs cover behaviour; these cover the input boundary the controllers rely
 * on (ValidationPipe).
 */
describe('support DTOs (§5.1, §9.19)', () => {
  it('ticket attachments: at most 5 files', async () => {
    const dto = plainToInstance(CreateTicketDto, {
      category: 'BUG',
      subject: 's',
      description: 'd',
      attachments: Array.from({ length: 6 }, (_, i) => ({
        key: `shops/x/tickets/${i}.png`,
        bytes: 100,
      })),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'attachments')).toBe(true);
  });

  it('ticket attachments: 10 MB per file ceiling', async () => {
    const ok = plainToInstance(AttachmentRefDto, {
      key: 'shops/x/tickets/a.png',
      bytes: TICKET_ATTACHMENT_MAX_BYTES,
    });
    expect(await validate(ok)).toHaveLength(0);

    const tooBig = plainToInstance(AttachmentRefDto, {
      key: 'shops/x/tickets/a.png',
      bytes: TICKET_ATTACHMENT_MAX_BYTES + 1,
    });
    expect(await validate(tooBig)).not.toHaveLength(0);
  });

  it('ticket category/priority are the §3.16 value lists', async () => {
    const bad = plainToInstance(CreateTicketDto, {
      category: 'URGENT_THING',
      priority: 'P1',
      subject: 's',
      description: 'd',
    });
    const errors = await validate(bad);
    expect(errors.map((e) => e.property).sort()).toEqual([
      'category',
      'priority',
    ]);
  });

  it('feedback rating is 1–5 (§9.19)', async () => {
    for (const rating of [0, 6, 2.5]) {
      const dto = plainToInstance(SubmitFeedbackDto, { rating });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'rating')).toBe(true);
    }
    const ok = plainToInstance(SubmitFeedbackDto, { rating: 3 });
    expect(await validate(ok)).toHaveLength(0);
  });

  it('feedback screenshot shares the 10 MB ceiling (§5.1)', async () => {
    const dto = plainToInstance(SubmitFeedbackDto, {
      rating: 5,
      screenshot: {
        key: 'shops/x/feedback/s.png',
        bytes: FEEDBACK_SCREENSHOT_MAX_BYTES + 1,
      },
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'screenshot')).toBe(true);
  });
});
