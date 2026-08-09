import { describe, expect, it } from 'vitest';
import { ReconProcessingService } from '../../src/modules/recon-freight/recon-processing.service';
import { ReconSettingsService } from '../../src/modules/recon-freight/recon-settings.service';
import { NotificationService } from '../../src/modules/notifications/notification.service';
import { AuditService } from '../../src/audit/audit.service';
import { LocalFilesystemObjectStore } from '../../src/modules/booking-ops/object-store';
import { NOTIFICATION_EVENTS } from '../../src/modules/notifications/notifications.types';
import { BookingSnapshot } from '../../src/modules/booking/booking.types';
import {
  ACCOUNT_ID,
  BATCH_ID,
  FnPool,
  MAP_ID,
  SHIPMENT_ID,
  SHOP_ID,
  exampleSnapshot,
  fakeAudit,
  fakeNotifications,
  fakeStore,
} from './helpers';

/**
 * §9.17.2 processing: parse → match → insert with everything final in one
 * transaction (the §10.4 trigger forbids any post-insert fixup), the F-14
 * control total, and the §9.21 Finance notification.
 */

const HEADER = 'AWB,Amount,Weight,Charge Type';

function mapRow() {
  return {
    courier_id: 'courier-1',
    mappings_json: { awb: 'AWB', amount: 'Amount', weight: 'Weight' },
    charge_type_column: 'Charge Type',
    charge_type_value_map: { forward: 'FORWARD', adjustment: 'ADJUSTMENT', rto: 'RTO' },
  };
}

function batchRow(declared: string) {
  return {
    batch_id: BATCH_ID,
    shop_id: SHOP_ID,
    courier_account_id: ACCOUNT_ID,
    batch_reference: 'FREIGHT-20260731-1',
    content_hash: 'abc123',
    column_map_id: MAP_ID,
    declared_invoice_total: declared,
    state: 'UPLOADED',
    version: 1,
  };
}

function shipmentRow(snapshot: BookingSnapshot | null, awb = 'DL0087412391') {
  return {
    shipment_id: SHIPMENT_ID,
    awb_normalized: awb,
    expected_cost_basis: 'SNAPSHOT_QUOTE',
    provider_confirmed_charge: null,
    snapshot,
  };
}

interface HarnessOpts {
  csv: string;
  declared: string;
  shipments?: unknown[];
  tariff?: boolean;
  crossBatchTargets?: unknown[];
}

function harness(opts: HarnessOpts) {
  const pool = new FnPool();
  pool
    .on(/FROM recon_freight_batch WHERE batch_id/, [batchRow(opts.declared)])
    .on(/FROM import_column_map/, [mapRow()])
    .on(/UPDATE recon_freight_batch SET state = \$3/, [], 1) // PARSED
    .on(/INSERT INTO recon_settings/, [], 0)
    .on(/FROM recon_settings WHERE shop_id/, [
      {
        freight_enabled: true,
        freight_tolerance: '1.00',
        weight_tolerance_kg: '0.010',
        cod_enabled: true,
        cod_tolerance: '1.00',
        cod_due_days: 7,
        version: 1,
      },
    ])
    .on(/FROM courier_account/, [{ freight_tolerance: null, weight_tolerance_kg: null }])
    .on(/FROM shipment s/, opts.shipments ?? [])
    .on(/FROM recon_freight_row r\s+JOIN recon_freight_batch b/, opts.crossBatchTargets ?? []);
  if (opts.tariff !== false) {
    pool
      .on(/FROM rate_card_version v/, [
        {
          fuel_pct: '0.180000',
          cod_flat: '35.00',
          cod_pct: '0.020000',
          gst_pct: '0.180000',
          taxable_components: ['F-5', 'F-6', 'F-7', 'F-8'],
        },
      ])
      .on(/FROM rate_card_slab/, [
        {
          zone: 'C',
          baseWeightKg: '0.500',
          baseRate: '42.00',
          additionalStepKg: '0.500',
          additionalRate: '38.00',
        },
      ])
      .on(/FROM rate_card_component/, []);
  }
  pool.on(/SET state = 'MATCHED'/, [], 1);

  const store = fakeStore(() => 'sig');
  store.get.mockResolvedValue(Buffer.from(opts.csv, 'utf8'));
  const audit = fakeAudit();
  const notifications = fakeNotifications();
  const settings = new ReconSettingsService(pool.asPool(), audit as unknown as AuditService);
  const service = new ReconProcessingService(
    pool.asPool(),
    store as unknown as LocalFilesystemObjectStore,
    settings,
    notifications as unknown as NotificationService,
    audit as unknown as AuditService,
  );
  return { service, pool, store, audit, notifications };
}

/** Inserted-row param positions (see the processing service INSERT). */
const P = {
  rowId: 0, awb: 2, chargeType: 3, amount: 4, weight: 5,
  flagAwb: 14, flagWeight: 15, flagAmount: 16, flagReview: 17,
  expected: 18, audited: 19, shipmentId: 20, adjusts: 21,
};

describe('§4.8 worked example end-to-end (parse → match → insert)', () => {
  it('inserts the row with final flags: weight mismatch true, amount mismatch false, F-23 ₹211.50', async () => {
    const { service, pool, notifications, audit } = harness({
      csv: `${HEADER}\nDL0087412391,211.50,1.500,Forward`,
      declared: '211.50',
      shipments: [shipmentRow(exampleSnapshot())],
    });
    await service.processBatch(BATCH_ID);

    const inserts = pool.matching(/INSERT INTO recon_freight_row/);
    expect(inserts).toHaveLength(1);
    const params = inserts[0].params;
    expect(params[P.awb]).toBe('DL0087412391'); // F-19
    expect(params[P.chargeType]).toBe('FORWARD');
    expect(params[P.amount]).toBe('211.50');
    expect(params[P.flagAwb]).toBe(false);
    expect(params[P.flagWeight]).toBe(true); // |1.500 − 1.000| > 0.010
    expect(params[P.flagAmount]).toBe(false); // F-23 == invoiced
    expect(params[P.flagReview]).toBe(false);
    expect(params[P.expected]).toBe('211.50');
    expect(params[P.audited]).toBe('211.50'); // F-23 stored
    expect(params[P.shipmentId]).toBe(SHIPMENT_ID);

    // Everything landed inside ONE transaction (§10.4 makes post-insert
    // fixups impossible — flags/expectations are final at insert).
    const begin = pool.calls.findIndex((c) => c.sql === 'BEGIN');
    const commit = pool.calls.findIndex((c) => c.sql === 'COMMIT');
    const firstInsert = pool.calls.findIndex((c) => /INSERT INTO recon_freight_row/.test(c.sql));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(firstInsert).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(firstInsert);

    // Batch → MATCHED, residual ₹0.00 WITHIN_THRESHOLD (F-14).
    const matched = pool.matching(/SET state = 'MATCHED'/)[0];
    expect(matched.params[2]).toBe('0.00');
    expect(matched.params[3]).toBe('WITHIN_THRESHOLD');

    // §9.21: a flagged row ⇒ Finance is notified immediately.
    expect(notifications.notify).toHaveBeenCalledWith(
      SHOP_ID,
      NOTIFICATION_EVENTS.RECON_BATCH_DISPUTED,
      expect.objectContaining({ link: `/recon/freight/batches/${BATCH_ID}` }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'recon.freight_batch_processed',
        after: expect.objectContaining({ state: 'MATCHED', flaggedRows: 1 }),
      }),
    );
  });

  it('control-total MISMATCH (the §4.8 batch example shape) is stored and notified', async () => {
    const { service, pool, notifications } = harness({
      csv: `${HEADER}\nDL0087412391,211.50,1.500,Forward`,
      declared: '250000.00', // declared far above the parsed rows
      shipments: [shipmentRow(exampleSnapshot())],
    });
    await service.processBatch(BATCH_ID);
    const matched = pool.matching(/SET state = 'MATCHED'/)[0];
    expect(matched.params[3]).toBe('MISMATCH'); // residual 249,788.50 > ₹1,250
    expect(matched.params[2]).toBe('249788.50');
    expect(notifications.notify).toHaveBeenCalled();
  });
});

describe('§4.8 group and RW-24 behaviour in the pipeline', () => {
  it('same-type rows are summed before comparison (100.00 + 111.50 = 211.50)', async () => {
    const { service, pool } = harness({
      csv: `${HEADER}\nDL0087412391,100.00,1.500,Forward\nDL0087412391,111.50,1.500,Forward`,
      declared: '211.50',
      shipments: [shipmentRow(exampleSnapshot())],
    });
    await service.processBatch(BATCH_ID);
    const inserts = pool.matching(/INSERT INTO recon_freight_row/);
    expect(inserts).toHaveLength(2);
    for (const call of inserts) {
      expect(call.params[P.flagAmount]).toBe(false); // compared as a ₹211.50 group
      expect(call.params[P.expected]).toBe('211.50');
    }
  });

  it('RW-24 same-batch: the adjustment links and re-compares the target (append-only link row)', async () => {
    // Forward at booked weight ⇒ F-23 ₹158.59; 108.59 + 50.00 adjustment matches.
    const { service, pool } = harness({
      csv: `${HEADER}\nDL0087412391,108.59,1.000,Forward\nDL0087412391,50.00,1.000,Adjustment`,
      declared: '158.59',
      shipments: [shipmentRow(exampleSnapshot())],
    });
    await service.processBatch(BATCH_ID);

    const inserts = pool.matching(/INSERT INTO recon_freight_row/);
    expect(inserts).toHaveLength(2);
    const forward = inserts.find((c) => c.params[P.chargeType] === 'FORWARD')!;
    const adjustment = inserts.find((c) => c.params[P.chargeType] === 'ADJUSTMENT')!;
    expect(forward.params[P.flagAmount]).toBe(false); // 108.59 + 50.00 = 158.59
    expect(adjustment.params[P.adjusts]).toBe(forward.params[P.rowId]);
    expect(adjustment.params[P.flagAmount]).toBe(false);

    const links = pool.matching(/INSERT INTO recon_freight_adjustment/);
    expect(links).toHaveLength(1);
    expect(links[0].params[0]).toBe(forward.params[P.rowId]); // append-only link
    expect(links[0].params[2]).toBe('50.00');
  });

  it('RW-24 cross-batch: the adjustment compares target invoiced + Σ adjustments vs the stored expectation', async () => {
    const { service, pool } = harness({
      csv: `${HEADER}\nDL0099999999,50.00,,Adjustment`,
      declared: '50.00',
      shipments: [], // AWB has no shipment row of its own in this shop lookup
      crossBatchTargets: [
        {
          row_id: 'target-row-1',
          invoiced_amount: '158.59',
          expected_amount: '158.59',
          prior_adjustments: '0',
        },
      ],
    });
    await service.processBatch(BATCH_ID);
    const insert = pool.matching(/INSERT INTO recon_freight_row/)[0];
    expect(insert.params[P.adjusts]).toBe('target-row-1');
    expect(insert.params[P.expected]).toBe('158.59');
    expect(insert.params[P.flagAmount]).toBe(true); // 158.59 + 50.00 ≠ 158.59
    expect(insert.params[P.flagReview]).toBe(false);
    const link = pool.matching(/INSERT INTO recon_freight_adjustment/)[0];
    expect(link.params[0]).toBe('target-row-1');
  });

  it('an adjustment with no identifiable target → flag_review, no link (§4.8)', async () => {
    const { service, pool } = harness({
      csv: `${HEADER}\nDL0099999999,50.00,,Adjustment`,
      declared: '50.00',
      shipments: [],
      crossBatchTargets: [],
    });
    await service.processBatch(BATCH_ID);
    const insert = pool.matching(/INSERT INTO recon_freight_row/)[0];
    expect(insert.params[P.flagReview]).toBe(true);
    expect(insert.params[P.flagAwb]).toBe(true);
    expect(insert.params[P.adjusts]).toBeNull();
    expect(pool.matching(/INSERT INTO recon_freight_adjustment/)).toHaveLength(0);
  });
});

describe('INV-20 surfacing and §3.18 failure', () => {
  it('an unknown AWB is stored with flag_awb_not_found — never dropped', async () => {
    const { service, pool } = harness({
      csv: `${HEADER}\nXXUNKNOWN,75.00,0.500,Forward`,
      declared: '75.00',
      shipments: [],
    });
    await service.processBatch(BATCH_ID);
    const insert = pool.matching(/INSERT INTO recon_freight_row/)[0];
    expect(insert.params[P.flagAwb]).toBe(true);
    expect(insert.params[P.expected]).toBeNull();
    expect(insert.params[P.shipmentId]).toBeNull();
  });

  it('an unmapped courier charge value lands as OTHER + flag_review', async () => {
    const { service, pool } = harness({
      csv: `${HEADER}\nDL0087412391,25.00,1.000,Fuel Correction Levy`,
      declared: '25.00',
      shipments: [shipmentRow(exampleSnapshot())],
    });
    await service.processBatch(BATCH_ID);
    const insert = pool.matching(/INSERT INTO recon_freight_row/)[0];
    expect(insert.params[P.chargeType]).toBe('OTHER');
    expect(insert.params[P.flagReview]).toBe(true);
    expect(insert.params[P.flagAmount]).toBe(false); // never a false mismatch
  });

  it('a file the map cannot read fails the batch (§3.18 FAILED, holds no rows) + DLQ + audit', async () => {
    const { service, pool, audit } = harness({
      csv: 'X,Y\n1,2', // no AWB/Amount columns
      declared: '2.00',
      shipments: [],
    });
    await service.processBatch(BATCH_ID);
    expect(pool.matching(/INSERT INTO recon_freight_row/)).toHaveLength(0);
    const failed = pool.matching(/SET state = 'FAILED'/)[0];
    expect(failed).toBeDefined();
    const dlq = pool.matching(/INSERT INTO dlq_item/)[0];
    expect(dlq.sql).toContain("'recon-processing'");
    expect(dlq.params[0]).toBe(SHOP_ID);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'recon.freight_batch_failed' }),
    );
  });

  it('a re-run over an already-processed batch is a no-op (queue retry safety)', async () => {
    const pool = new FnPool();
    pool.on(/FROM recon_freight_batch WHERE batch_id/, [
      { ...batchRow('10.00'), state: 'MATCHED' },
    ]);
    const store = fakeStore(() => 'sig');
    const audit = fakeAudit();
    const notifications = fakeNotifications();
    const settings = new ReconSettingsService(pool.asPool(), audit as unknown as AuditService);
    const service = new ReconProcessingService(
      pool.asPool(),
      store as unknown as LocalFilesystemObjectStore,
      settings,
      notifications as unknown as NotificationService,
      audit as unknown as AuditService,
    );
    await service.processBatch(BATCH_ID);
    expect(pool.matching(/INSERT INTO recon_freight_row/)).toHaveLength(0);
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});
