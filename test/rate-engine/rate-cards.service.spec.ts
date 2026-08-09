import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RateCardsService, type CreateRateCardVersionInput } from '../../src/modules/rate-engine/rate-cards.service';
import { mockPool, routeBySql } from '../team/helpers';
import type { Pool } from 'pg';

/**
 * Rate card persistence guards (§9.15, INV-11, INV-22) against a mocked Pool:
 * effective-interval overlap rejection, optimistic-concurrency rejection, the
 * INV-11 DB trigger surfacing as a clean 409 on child writes, and sealing.
 */

const SHOP_ID = '11111111-1111-1111-1111-111111111111';
const MEMBER_ID = '22222222-2222-2222-2222-222222222222';
const CARD_ID = '33333333-3333-3333-3333-333333333333';
const VERSION_ID = '44444444-4444-4444-4444-444444444444';

const VERSION_INPUT: CreateRateCardVersionInput = {
  effectiveFrom: '2026-06-01',
  effectiveTo: null,
  zoneMapId: '55555555-5555-5555-5555-555555555555',
  fuelPct: '0.180000',
  codFlat: '35.00',
  codPct: '0.020000',
  rtoBasis: 'SAME_AS_FORWARD',
  rtoPct: null,
  gstPct: '0.180000',
  taxableComponents: ['F-5', 'F-6', 'F-7', 'F-8'],
  slabs: [
    {
      zone: 'C',
      baseWeightKg: '0.500',
      baseRate: '42.00',
      additionalStepKg: '0.500',
      additionalRate: '38.00',
    },
  ],
  components: [],
  rateCardVersion: 1,
};

function auditMock() {
  return { record: vi.fn().mockResolvedValue(undefined) };
}

describe('createVersion — §9.15 non-overlapping intervals', () => {
  it('rejects an overlapping effective interval with 409 and rolls back', async () => {
    const { pool, client } = mockPool();
    routeBySql(client.query, [
      ['BEGIN', () => ({ rows: [] })],
      ['COMMIT', () => ({ rows: [] })],
      ['ROLLBACK', () => ({ rows: [] })],
      ['FOR UPDATE', () => ({ rows: [{ rate_card_id: CARD_ID, version: 1 }] })],
      ['FROM rate_card_version', () => ({
        rows: [{ rate_card_version_id: VERSION_ID, effective_from: '2026-01-01', effective_to: null }],
      })],
    ]);
    const service = new RateCardsService(pool as unknown as Pool, auditMock() as never);

    await expect(
      service.createVersion(SHOP_ID, MEMBER_ID, CARD_ID, VERSION_INPUT),
    ).rejects.toThrow(ConflictException);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('rejects a stale rate_card version (INV-22) with 409 and the current state', async () => {
    const { pool, client } = mockPool();
    routeBySql(client.query, [
      ['BEGIN', () => ({ rows: [] })],
      ['COMMIT', () => ({ rows: [] })],
      ['ROLLBACK', () => ({ rows: [] })],
      ['FOR UPDATE', () => ({ rows: [{ rate_card_id: CARD_ID, version: 2 }] })],
    ]);
    const service = new RateCardsService(pool as unknown as Pool, auditMock() as never);

    await expect(
      service.createVersion(SHOP_ID, MEMBER_ID, CARD_ID, VERSION_INPUT), // read version 1
    ).rejects.toThrow(ConflictException);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });
});

describe('INV-11 — sealed parents freeze child writes', () => {
  it('maps the DB seal-trigger error on a child insert to a clean 409', async () => {
    const { pool, client } = mockPool();
    routeBySql(client.query, [
      ['BEGIN', () => ({ rows: [] })],
      ['COMMIT', () => ({ rows: [] })],
      ['ROLLBACK', () => ({ rows: [] })],
      ['FOR UPDATE', () => ({ rows: [{ rate_card_id: CARD_ID, version: 1 }] })],
      ['FROM rate_card_version', () => ({ rows: [] })], // no overlap
      ['INSERT INTO rate_card_version', () => ({
        rows: [{ rate_card_version_id: VERSION_ID, rate_card_id: CARD_ID, is_sealed: true, version: 1 }],
      })],
      ['INSERT INTO rate_card_slab', () => {
        // Migration 0006 guard_sealed_children() trigger.
        throw new Error('INV-11: rate_card_slab rows are frozen because the parent version is sealed');
      }],
    ]);
    const service = new RateCardsService(pool as unknown as Pool, auditMock() as never);

    await expect(
      service.createVersion(SHOP_ID, MEMBER_ID, CARD_ID, VERSION_INPUT),
    ).rejects.toThrow(ConflictException);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });
});

describe('seal (INV-11, §12)', () => {
  it('flips is_sealed with the writer-read version and audits the seal', async () => {
    const { pool } = mockPool();
    const sealedRow = { rate_card_version_id: VERSION_ID, is_sealed: true, version: 2 };
    routeBySql(pool.query, [['UPDATE rate_card_version', () => ({ rows: [sealedRow] })]]);
    const audit = auditMock();
    const service = new RateCardsService(pool as unknown as Pool, audit as never);

    const row = await service.seal(SHOP_ID, MEMBER_ID, VERSION_ID, 1);
    expect(row).toEqual(sealedRow);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: SHOP_ID,
        actorKind: 'MEMBER',
        actorId: MEMBER_ID,
        action: 'rate_card_version.seal',
        objectType: 'rate_card_version',
        objectId: VERSION_ID,
      }),
    );
  });

  it('409s when the version is already sealed', async () => {
    const { pool } = mockPool();
    routeBySql(pool.query, [
      ['UPDATE rate_card_version', () => ({ rows: [] })],
      ['FROM rate_card_version', () => ({
        rows: [{ rate_card_version_id: VERSION_ID, is_sealed: true, version: 2 }],
      })],
    ]);
    const service = new RateCardsService(pool as unknown as Pool, auditMock() as never);

    await expect(service.seal(SHOP_ID, MEMBER_ID, VERSION_ID, 1)).rejects.toThrow(
      ConflictException,
    );
  });

  it('409s on an INV-22 version mismatch and returns the current state', async () => {
    const { pool } = mockPool();
    routeBySql(pool.query, [
      ['UPDATE rate_card_version', () => ({ rows: [] })],
      ['FROM rate_card_version', () => ({
        rows: [{ rate_card_version_id: VERSION_ID, is_sealed: false, version: 3 }],
      })],
    ]);
    const service = new RateCardsService(pool as unknown as Pool, auditMock() as never);

    await expect(service.seal(SHOP_ID, MEMBER_ID, VERSION_ID, 1)).rejects.toThrow(
      ConflictException,
    );
  });
});
