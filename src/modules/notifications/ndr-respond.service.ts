import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL } from '../../database/database.module';
import { REDIS } from '../../redis/redis.module';
import { saltedPiiHash } from '../../common/crypto';
import { AuditService } from '../../audit/audit.service';
import { NdrTokenService } from './ndr-token.service';
import {
  NDR_RESPONSE_PROCESSOR,
  NdrResponseProcessor,
} from './ndr-seam';

/**
 * ADD-27: buyer self-serve NDR response. The tokenized link (single-purpose,
 * hashed) opens a page with the order ref, the address on file and the four
 * options; POSTing a response writes the durable, audited ndr_buyer_response
 * record and then calls the NDR action seam.
 *
 * The stated INV-21 exception, made explicit (addendum ADD-27): the response
 * DOES drive a business action, but the action is created FROM THE STORED
 * RECORD — never from message delivery. If the seam call fails, the record
 * stays in ndr_buyer_response, fully actionable by the NDR module later.
 *
 * Rate limiting reuses the track-page pattern (S-38): Redis counters keyed
 * on the salted IP hash, 10 POST attempts per 10 minutes.
 */

export const NDR_RESPONSE_TYPES = [
  'CONFIRM_ADDRESS',
  'CORRECT_ADDRESS',
  'CHOOSE_REATTEMPT_DATE',
  'COD_TO_PREPAID',
] as const;

export type NdrResponseType = (typeof NDR_RESPONSE_TYPES)[number];

const POST_THROTTLE = { attempts: 10, windowSeconds: 600 };

export interface NdrRespondPage {
  orderRef: string | null;
  addressOnFile: Record<string, unknown> | null;
  options: readonly NdrResponseType[];
}

export interface NdrSubmitResult {
  ok: boolean;
  code?: 'INVALID_TOKEN' | 'INVALID_RESPONSE' | 'THROTTLED';
  error?: string;
  responseId?: string;
}

@Injectable()
export class NdrRespondService {
  private readonly logger = new Logger(NdrRespondService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly tokens: NdrTokenService,
    private readonly audit: AuditService,
    @Inject(NDR_RESPONSE_PROCESSOR)
    private readonly processor: NdrResponseProcessor,
  ) {}

  private salt(): string {
    return this.config.get<string>('crypto.piiHashSalt') ?? '';
  }

  /** One generic failure for every invalid-token case — no oracle. */
  async getPage(token: string): Promise<NdrRespondPage | null> {
    const resolved = await this.tokens.resolve(token);
    if (!resolved) return null;
    return {
      orderRef: resolved.orderRef,
      addressOnFile: resolved.recipient,
      options: NDR_RESPONSE_TYPES,
    };
  }

  /** Minimal payload shape validation per response type. */
  private validPayload(type: NdrResponseType, payload: unknown): boolean {
    if (typeof payload !== 'object' || payload === null) return false;
    if (type === 'CORRECT_ADDRESS') {
      const address = (payload as Record<string, unknown>)['address'];
      if (typeof address !== 'object' || address === null) return false;
      const pincode = (address as Record<string, unknown>)['pincode'];
      return typeof pincode === 'string' && /^[0-9]{6}$/.test(pincode);
    }
    if (type === 'CHOOSE_REATTEMPT_DATE') {
      const date = (payload as Record<string, unknown>)['date'];
      return typeof date === 'string' && !Number.isNaN(Date.parse(date));
    }
    return true; // CONFIRM_ADDRESS and COD_TO_PREPAID need no fields
  }

  async submit(
    token: string,
    responseType: string,
    payload: unknown,
    ip: string,
  ): Promise<NdrSubmitResult> {
    // S-38-pattern throttle on the salted IP hash (§5.7 control 4).
    const ipHash = saltedPiiHash(this.salt(), ip || 'unknown');
    const key = `ndr:resp:thr:${ipHash}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, POST_THROTTLE.windowSeconds);
    if (count > POST_THROTTLE.attempts) {
      return {
        ok: false,
        code: 'THROTTLED',
        error: 'Too many attempts. Please try again later.',
      };
    }

    const resolved = await this.tokens.resolve(token);
    if (!resolved) {
      return { ok: false, code: 'INVALID_TOKEN', error: 'This link is no longer valid.' };
    }
    if (
      !NDR_RESPONSE_TYPES.includes(responseType as NdrResponseType) ||
      !this.validPayload(responseType as NdrResponseType, payload)
    ) {
      return { ok: false, code: 'INVALID_RESPONSE', error: 'Invalid response.' };
    }

    // The durable, audited record — this, not any message, is the source of
    // the business action (the INV-21 exception).
    const inserted = await this.pool.query<{ response_id: string }>(
      `INSERT INTO ndr_buyer_response
         (shop_id, ndr_case_id, response_type, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING response_id`,
      [
        resolved.shopId,
        resolved.ndrCaseId,
        responseType,
        JSON.stringify(payload ?? {}),
      ],
    );
    const responseId = inserted.rows[0].response_id;

    // Single-purpose: the token dies with the first successful response.
    await this.tokens.revoke(resolved.tokenId);

    await this.audit.record({
      shopId: resolved.shopId,
      actorKind: 'SYSTEM',
      action: 'ndr.buyer_response',
      objectType: 'ndr_buyer_response',
      objectId: responseId,
      after: { ndrCaseId: resolved.ndrCaseId, responseType },
      ipHash,
    });

    // Hand the RECORD to the NDR action seam. A failure here never loses the
    // response — the row remains for the NDR module to act on.
    try {
      await this.processor.processBuyerResponse(responseId);
    } catch (err) {
      this.logger.error(
        `NDR response processor failed: ${err instanceof Error ? err.name : 'Error'}`,
      );
    }

    return { ok: true, responseId };
  }
}
