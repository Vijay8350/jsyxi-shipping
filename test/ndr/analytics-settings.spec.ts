import { describe, expect, it } from 'vitest';
import { NdrAnalyticsService } from '../../src/modules/ndr/ndr-analytics.service';
import { NdrSettingsService } from '../../src/modules/ndr/ndr-settings.service';
import { NDR_SETTINGS_DEFAULTS } from '../../src/modules/ndr/ndr-settings.service';
import { FnPool, MEMBER_ID, mockAudit, SHOP_ID, SQL } from './helpers';

const RANGE = { from: '2026-07-01', to: '2026-08-01' };

/**
 * §9.8.3 analytics — F-16.b / F-16.c definitions and INV-19 test exclusion —
 * plus §9.8.2 settings (S-41–S-43) with §12 audit.
 */

describe('NdrAnalyticsService.ndrRates (F-16.b)', () => {
  it('NDR rate = shipments with ≥1 NDR ÷ picked-up shipments, by service', async () => {
    const pool = new FnPool();
    pool.on(/WITH cohort AS/, [
      { key: 'Delhivery Surface', ndr_shipments: '2', picked_up_shipments: '10' },
      { key: 'Blue Dart Air', ndr_shipments: '0', picked_up_shipments: '4' },
    ]);
    const svc = new NdrAnalyticsService(pool.asPool());

    const rows = await svc.ndrRates(SHOP_ID, RANGE, 'service');

    expect(rows).toEqual([
      { key: 'Delhivery Surface', ndrShipments: 2, pickedUpShipments: 10, ndrRate: 0.2 },
      { key: 'Blue Dart Air', ndrShipments: 0, pickedUpShipments: 4, ndrRate: 0 },
    ]);
    // INV-19: test shipments excluded from both terms.
    expect(pool.calls[0].sql).toContain('s.is_test = false');
    // Picked-up is evidenced by a PICKED_UP event (F-16.b denominator).
    expect(pool.calls[0].sql).toContain("'PICKED_UP'");
  });

  it('null rate when the picked-up denominator is zero (never ÷0)', async () => {
    const pool = new FnPool();
    pool.on(/WITH cohort AS/, [{ key: '(unknown)', ndr_shipments: '0', picked_up_shipments: '0' }]);
    const svc = new NdrAnalyticsService(pool.asPool());

    const rows = await svc.ndrRates(SHOP_ID, RANGE, 'pincode');
    expect(rows[0].ndrRate).toBeNull();
  });

  it('reason breakdown splits the numerator by the §3.10 reason over the cohort denominator', async () => {
    const pool = new FnPool();
    pool.on(/FROM ndr_case nc/, [
      { key: 'CUSTOMER_REFUSED', ndr_shipments: '3', picked_up_shipments: '20' },
      { key: 'OTHER', ndr_shipments: '1', picked_up_shipments: '20' },
    ]);
    const svc = new NdrAnalyticsService(pool.asPool());

    const rows = await svc.ndrRates(SHOP_ID, RANGE, 'reason');

    expect(rows).toEqual([
      { key: 'CUSTOMER_REFUSED', ndrShipments: 3, pickedUpShipments: 20, ndrRate: 0.15 },
      { key: 'OTHER', ndrShipments: 1, pickedUpShipments: 20, ndrRate: 0.05 },
    ]);
    expect(pool.calls[0].sql).toContain('nc.reason_code::text');
  });
});

describe('NdrAnalyticsService.rtoRates (F-16.c)', () => {
  it('RTO rate = RTO Delivered ÷ terminal shipments', async () => {
    const pool = new FnPool();
    pool.on(/FROM shipment s/, [
      { key: 'Delhivery Surface', rto_delivered: '5', terminal_shipments: '25' },
      { key: '560001', rto_delivered: '1', terminal_shipments: '3' },
    ]);
    const svc = new NdrAnalyticsService(pool.asPool());

    const byService = await svc.rtoRates(SHOP_ID, RANGE, 'service');
    expect(byService[0]).toEqual({
      key: 'Delhivery Surface',
      rtoDelivered: 5,
      terminalShipments: 25,
      rtoRate: 0.2,
    });
    // The terminal-shipment denominator is exactly §3.4's four terminal states.
    expect(pool.calls[0].sql).toContain(
      "('DELIVERED', 'RTO_DELIVERED', 'LOST_OR_DAMAGED', 'CANCELLED_BY_COURIER')",
    );
    expect(pool.calls[0].sql).toContain('s.is_test = false'); // INV-19
  });
});

describe('NdrSettingsService (§9.8.2, S-41–S-43)', () => {
  it('returns the spec defaults when no row exists', async () => {
    const pool = new FnPool();
    const audit = mockAudit();
    const svc = new NdrSettingsService(pool.asPool(), audit as never);

    const settings = await svc.get(SHOP_ID);

    expect(settings).toMatchObject({
      recipients: [], // S-41 (Owner's email resolved by the UI)
      channel: 'email', // S-42
      digest_frequency: 'daily', // S-42
      auto_reattempt_once: false, // S-43 default off
    });
    expect(NDR_SETTINGS_DEFAULTS.auto_reattempt_once).toBe(false);
  });

  it('upserts and audits the change (§12: every S-value)', async () => {
    const pool = new FnPool();
    pool.on(SQL.upsertSettings, [
      {
        shop_id: SHOP_ID,
        recipients: ['ops@merchant.in'],
        channel: 'email',
        digest_frequency: 'weekly',
        auto_reattempt_once: true,
        escalation_templates: [],
        version: 2,
      },
    ]);
    const audit = mockAudit();
    const svc = new NdrSettingsService(pool.asPool(), audit as never);

    const after = await svc.update(
      SHOP_ID,
      { recipients: ['ops@merchant.in'], digestFrequency: 'weekly', autoReattemptOnce: true },
      MEMBER_ID,
    );

    expect(after.auto_reattempt_once).toBe(true);
    const upsert = pool.matching(SQL.upsertSettings)[0];
    expect(upsert.params[1]).toBe(JSON.stringify(['ops@merchant.in']));
    expect(upsert.params[3]).toBe('weekly');
    expect(upsert.params[4]).toBe(true);
    expect(audit.entries[0]).toMatchObject({
      action: 'ndr_settings.update',
      actorKind: 'MEMBER',
      actorId: MEMBER_ID,
    });
  });

  it('rejects values outside the S-42 lists', async () => {
    const pool = new FnPool();
    const svc = new NdrSettingsService(pool.asPool(), mockAudit() as never);

    await expect(
      svc.update(SHOP_ID, { digestFrequency: 'monthly' as never }, MEMBER_ID),
    ).rejects.toThrow(/S-42/);
    await expect(
      svc.update(SHOP_ID, { channel: 'pigeon' as never }, MEMBER_ID),
    ).rejects.toThrow(/S-42/);
  });
});
