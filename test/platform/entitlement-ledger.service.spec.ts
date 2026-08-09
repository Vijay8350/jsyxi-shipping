import { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { EntitlementLedgerService } from '../../src/modules/platform/ledger/entitlement-ledger.service';

const SHOP = '11111111-1111-1111-1111-111111111111';
const SUB = '33333333-3333-3333-3333-333333333333';
const SHIPMENT = '44444444-4444-4444-4444-4444444444';
const INTENT = '55555555-5555-5555-5555-555555555555';
const CYCLE = '2026-07-01T00:00:00.000Z';

function uniqueViolation(constraint: string) {
  return Object.assign(new Error('duplicate key'), {
    code: '23505',
    constraint,
  });
}

describe('EntitlementLedgerService (INV-12, §9.5.6)', () => {
  let query: ReturnType<typeof vi.fn>;
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: EntitlementLedgerService;

  beforeEach(() => {
    query = vi.fn();
    audit = { record: vi.fn().mockResolvedValue(undefined) };
    service = new EntitlementLedgerService(
      { query } as unknown as Pool,
      audit as unknown as AuditService,
    );
  });

  it('debits once and audits the debit (§12)', async () => {
    query.mockResolvedValueOnce({ rows: [{ entry_id: 'entry-1' }] });
    const result = await service.debit({
      shopId: SHOP,
      subscriptionId: SUB,
      cycleStartAt: CYCLE,
      shipmentId: SHIPMENT,
      bookingIntentId: INTENT,
      isTest: false,
    });

    expect(result).toEqual({ debited: true, entryId: 'entry-1' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO awb_entitlement_ledger');
    expect(sql).toContain("'DEBIT'");
    expect(params).toEqual([SHOP, SUB, CYCLE, SHIPMENT, INTENT]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorKind: 'SYSTEM', action: 'entitlement.debit' }),
    );
  });

  it('treats the one-DEBIT unique violation as idempotent success, not an error', async () => {
    query.mockRejectedValueOnce(uniqueViolation('awb_ledger_one_debit'));
    const result = await service.debit({
      shopId: SHOP,
      subscriptionId: SUB,
      cycleStartAt: CYCLE,
      shipmentId: SHIPMENT,
      bookingIntentId: INTENT,
      isTest: false,
    });

    expect(result).toEqual({ debited: false, reason: 'ALREADY_DEBITED' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rethrows non-unique insert failures', async () => {
    query.mockRejectedValueOnce(new Error('connection reset'));
    await expect(
      service.debit({
        shopId: SHOP,
        subscriptionId: SUB,
        cycleStartAt: CYCLE,
        shipmentId: SHIPMENT,
        bookingIntentId: INTENT,
        isTest: false,
      }),
    ).rejects.toThrow('connection reset');
  });

  it('never writes a ledger entry for a test shipment (INV-19)', async () => {
    const result = await service.debit({
      shopId: SHOP,
      subscriptionId: SUB,
      cycleStartAt: CYCLE,
      shipmentId: SHIPMENT,
      bookingIntentId: INTENT,
      isTest: true,
    });

    expect(result).toEqual({ debited: false, reason: 'TEST_SHIPMENT' });
    expect(query).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('reverses after courier-confirmed pre-pickup cancellation and audits it', async () => {
    query.mockResolvedValueOnce({ rows: [{ entry_id: 'entry-2' }] });
    const result = await service.reverse({
      shopId: SHOP,
      subscriptionId: SUB,
      cycleStartAt: CYCLE,
      shipmentId: SHIPMENT,
      bookingIntentId: INTENT,
      courierConfirmedPrePickup: true,
    });

    expect(result).toEqual({ reversed: true, entryId: 'entry-2' });
    expect(query.mock.calls[0][0]).toContain("'REVERSAL'");
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'entitlement.reversal' }),
    );
  });

  it('refuses to reverse without courier-confirmed pre-pickup and flags for review (§9.5.6)', async () => {
    const result = await service.reverse({
      shopId: SHOP,
      subscriptionId: SUB,
      cycleStartAt: CYCLE,
      shipmentId: SHIPMENT,
      bookingIntentId: INTENT,
      courierConfirmedPrePickup: false,
    });

    expect(result).toEqual({
      reversed: false,
      reason: 'NOT_COURIER_CONFIRMED_PRE_PICKUP',
      flaggedForReview: true,
    });
    expect(query).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('allows at most one reversal — a repeat is an idempotent no-op', async () => {
    query.mockRejectedValueOnce(uniqueViolation('awb_ledger_one_reversal'));
    const result = await service.reverse({
      shopId: SHOP,
      subscriptionId: SUB,
      cycleStartAt: CYCLE,
      shipmentId: SHIPMENT,
      bookingIntentId: INTENT,
      courierConfirmedPrePickup: true,
    });

    expect(result).toEqual({
      reversed: false,
      reason: 'ALREADY_REVERSED',
      flaggedForReview: false,
    });
  });

  it('computes the cycle balance as debits minus reversals', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { direction: 'DEBIT', n: '10' },
        { direction: 'REVERSAL', n: '3' },
      ],
    });
    const balance = await service.allowanceBalance(SUB, CYCLE);

    expect(balance).toEqual({ debits: 10, reversals: 3, consumed: 7 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('WHERE subscription_id = $1 AND cycle_start_at = $2');
    expect(params).toEqual([SUB, CYCLE]);
  });

  it('returns a zero balance for a cycle with no entries', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await service.allowanceBalance(SUB, CYCLE)).toEqual({
      debits: 0,
      reversals: 0,
      consumed: 0,
    });
  });
});
