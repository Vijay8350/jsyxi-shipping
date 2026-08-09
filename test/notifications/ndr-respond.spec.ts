import { Pool } from 'pg';
import Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { tokenHash } from '../../src/common/crypto';
import { AuditService } from '../../src/audit/audit.service';
import { NdrTokenService } from '../../src/modules/notifications/ndr-token.service';
import { NdrRespondService } from '../../src/modules/notifications/ndr-respond.service';
import { NdrResponseProcessor } from '../../src/modules/notifications/ndr-seam';
import { NDR_CASE, SHIPMENT, SHOP, FakeRedis, fakeConfig, routedQuery } from './helpers';

/**
 * ADD-27: the tokenized buyer self-serve flow — page data, the audited
 * response record, the NDR action seam, single-purpose tokens, throttling,
 * and the INV-21 exception (seam failure never loses the record).
 */

const TOKEN_ROW = {
  token_id: 'tok-1',
  shop_id: SHOP,
  ndr_case_id: NDR_CASE,
  revoked_at: null,
  account_state: 'ACTIVE',
  shipment_id: SHIPMENT,
  shopify_order_number: '#1042',
  snapshot: {
    recipient: {
      name: 'Riya',
      addressLines: ['12 MG Road'],
      city: 'Bengaluru',
      pincode: '560001',
    },
  },
};

function build(opts: { tokenRow?: Record<string, unknown> | null; processor?: NdrResponseProcessor }) {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const query = routedQuery([
    [
      'FROM ndr_response_token',
      () => ({ rows: opts.tokenRow === null ? [] : [opts.tokenRow ?? TOKEN_ROW] }),
    ],
    [
      'INSERT INTO ndr_buyer_response',
      (_sql: string, params: unknown[]) => {
        inserts.push({ sql: _sql, params });
        return { rows: [{ response_id: 'resp-1' }] };
      },
    ],
    ['UPDATE ndr_response_token', () => ({ rows: [], rowCount: 1 })],
    ['INSERT INTO audit_log', () => ({ rows: [] })],
  ]);
  const pool = { query } as unknown as Pool;
  const redis = new FakeRedis();
  const audit = new AuditService(pool);
  const tokens = new NdrTokenService(pool, fakeConfig() as never);
  const processor = opts.processor ?? { processBuyerResponse: vi.fn(async () => undefined) };
  const service = new NdrRespondService(
    pool,
    redis as unknown as Redis,
    fakeConfig() as never,
    tokens,
    audit,
    processor,
  );
  return { service, redis, processor, inserts, query };
}

describe('NdrRespondService (ADD-27)', () => {
  it('GET page data: order ref, address on file, the four options', async () => {
    const { service } = build({});
    const page = await service.getPage('raw-token');
    expect(page).toEqual({
      orderRef: '#1042',
      addressOnFile: TOKEN_ROW.snapshot.recipient,
      options: ['CONFIRM_ADDRESS', 'CORRECT_ADDRESS', 'CHOOSE_REATTEMPT_DATE', 'COD_TO_PREPAID'],
    });
  });

  it('unknown or revoked tokens fail with one uniform null (no oracle)', async () => {
    const unknown = build({ tokenRow: null });
    expect(await unknown.service.getPage('nope')).toBeNull();

    const revoked = build({ tokenRow: { ...TOKEN_ROW, revoked_at: '2026-08-01T00:00:00Z' } });
    expect(await revoked.service.getPage('nope')).toBeNull();
  });

  it('a valid response writes the audited record, revokes the token and calls the seam', async () => {
    const processor = { processBuyerResponse: vi.fn(async () => undefined) };
    const { service, inserts, query } = build({ processor });

    const result = await service.submit(
      'raw-token',
      'CORRECT_ADDRESS',
      { address: { addressLines: ['5 New Lane'], city: 'Pune', pincode: '411001' } },
      '203.0.113.9',
    );

    expect(result).toEqual({ ok: true, responseId: 'resp-1' });
    // The durable record — shop-scoped, typed, payload preserved.
    expect(inserts[0].params).toEqual([
      SHOP,
      NDR_CASE,
      'CORRECT_ADDRESS',
      JSON.stringify({ address: { addressLines: ['5 New Lane'], city: 'Pune', pincode: '411001' } }),
    ]);
    // Single-purpose: token revoked.
    expect(
      query.mock.calls.some((c: unknown[]) =>
        String(c[0]).includes('UPDATE ndr_response_token SET revoked_at'),
      ),
    ).toBe(true);
    // The seam is called with the RECORD id — the action is created from the
    // stored record, not from any message (INV-21 exception).
    expect(processor.processBuyerResponse).toHaveBeenCalledWith('resp-1');
    // Audited (§12).
    expect(
      query.mock.calls.some((c: unknown[]) => String(c[0]).includes('INSERT INTO audit_log')),
    ).toBe(true);
  });

  it('seam failure still leaves the response recorded and ok (INV-21 exception)', async () => {
    const processor = {
      processBuyerResponse: vi.fn(async () => {
        throw new Error('ndr module not ready');
      }),
    };
    const { service, inserts } = build({ processor });
    const result = await service.submit('raw-token', 'CONFIRM_ADDRESS', {}, '203.0.113.9');
    expect(result.ok).toBe(true);
    expect(inserts).toHaveLength(1); // the record exists regardless
  });

  it('rejects bad response types and malformed payloads without writing', async () => {
    const { service, inserts } = build({});
    expect(
      (await service.submit('raw-token', 'REFUND_ME', {}, '1.1.1.1')).ok,
    ).toBe(false);
    expect(
      (
        await service.submit(
          'raw-token',
          'CORRECT_ADDRESS',
          { address: { city: 'Pune' } }, // no pincode
          '1.1.1.1',
        )
      ).ok,
    ).toBe(false);
    expect(inserts).toHaveLength(0);
  });

  it('rate-limits POSTs like the track page (S-38 pattern)', async () => {
    const { service } = build({});
    let last = { ok: true } as Awaited<ReturnType<typeof service.submit>>;
    for (let i = 0; i < 12; i += 1) {
      last = await service.submit('raw-token', 'CONFIRM_ADDRESS', {}, '198.51.100.7');
    }
    expect(last.ok).toBe(false);
    expect(last.code).toBe('THROTTLED');
  });

  it('token lookup is by hash — the raw token never reaches the database', async () => {
    const { service, query } = build({});
    await service.getPage('raw-token');
    expect(query.mock.calls[0][1]).toEqual([tokenHash('raw-token')]);
  });
});
