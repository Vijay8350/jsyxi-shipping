import { Pool } from 'pg';

/**
 * Test doubles for the recon-cod specs, following the test/ndr FnPool
 * pattern: regex-matched SQL handlers over a recorded call log, plus a stub
 * audit writer.
 */

export const SHOP_ID = '11111111-1111-1111-1111-111111111111';
export const MEMBER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
export const SHIPMENT_ID = '33333333-3333-3333-3333-333333333333';
export const COURIER_ACCOUNT_ID = '88888888-8888-8888-8888-888888888888';
export const EXPECTED_ID = '99999999-9999-9999-9999-999999999999';
export const BATCH_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const BATCH_ID_2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
export const COLUMN_MAP_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

export const AWB = 'DL123456789';

export interface RecordedCall {
  sql: string;
  params: unknown[];
}

type HandlerResult = { rows: unknown[]; rowCount: number };
type Handler = (sql: string, params: unknown[]) => HandlerResult | undefined;

export class FnPool {
  readonly calls: RecordedCall[] = [];
  private readonly handlers: Array<{ pattern: RegExp; fn: Handler }> = [];

  on(pattern: RegExp, rows: unknown[], rowCount?: number): this {
    this.handlers.push({
      pattern,
      fn: () => ({ rows, rowCount: rowCount ?? rows.length }),
    });
    return this;
  }

  onFn(pattern: RegExp, fn: Handler): this {
    this.handlers.push({ pattern, fn });
    return this;
  }

  readonly query = (sql: string, params?: unknown[]) => {
    this.calls.push({ sql, params: params ?? [] });
    for (const h of this.handlers) {
      if (h.pattern.test(sql)) {
        const r = h.fn(sql, params ?? []);
        if (r) return Promise.resolve({ rows: r.rows as never[], rowCount: r.rowCount });
      }
    }
    return Promise.resolve({ rows: [] as never[], rowCount: 0 });
  };

  matching(pattern: RegExp): RecordedCall[] {
    return this.calls.filter((c) => pattern.test(c.sql));
  }

  asPool(): Pool {
    return this as unknown as Pool;
  }
}

export function mockAudit() {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    record: (entry: Record<string, unknown>) => {
      entries.push(entry);
      return Promise.resolve();
    },
  };
}

// --- SQL routing patterns (kept close to the services' statements). ---
export const SQL = {
  shipmentForExpectation: /SELECT shipment_id, courier_account_id, is_test, collectible::text, snapshot\s+FROM shipment/,
  storeTimezone: /SELECT timezone FROM store_settings/,
  effectiveDueDays: /ca\.cod_due_days/,
  effectiveTolerance: /ca\.cod_tolerance/,
  insertExpected: /INSERT INTO recon_cod_expected/,
  selectExpectedByShipment: /FROM recon_cod_expected\s+WHERE shop_id = \$1 AND shipment_id = \$2/,
  updateExpectedRto: /SET state = 'RTO_UNCOLLECTED'/,
  batchByHash: /FROM recon_cod_batch WHERE shop_id = \$1 AND content_hash = \$2/,
  batchById: /FROM recon_cod_batch WHERE shop_id = \$1 AND cod_batch_id = \$2/,
  insertBatch: /INSERT INTO recon_cod_batch/,
  resetBatch: /SET state = 'UPLOADED', filename/,
  batchStateUpdate: /UPDATE recon_cod_batch\s+SET state = '(PARSED|MATCHED|FAILED)'/,
  batchFinalUpdate: /SET state = 'MATCHED', matched_count/,
  expectationForAwb: /FROM shipment s\s+JOIN recon_cod_expected e/,
  insertAllocation: /INSERT INTO recon_cod_allocation/,
  recomputeSelect: /FROM recon_cod_expected e\s+LEFT JOIN recon_cod_allocation a/,
  shipmentAccount: /SELECT courier_account_id FROM shipment/,
  recomputeUpdate: /UPDATE recon_cod_expected\s+SET state = \$2/,
  reconSettings: /FROM recon_settings WHERE shop_id = \$1/,
  upsertSettings: /INSERT INTO recon_settings/,
  columnMap: /FROM import_column_map/,
};

export function shipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    shipment_id: SHIPMENT_ID,
    courier_account_id: COURIER_ACCOUNT_ID,
    is_test: false,
    collectible: '1000.0000',
    snapshot: { formulaInputs: { collectible: '1000.00' } },
    ...overrides,
  };
}

export function expectedRow(overrides: Record<string, unknown> = {}) {
  return {
    expected_id: EXPECTED_ID,
    shop_id: SHOP_ID,
    shipment_id: SHIPMENT_ID,
    expected_amount: '1000.0000',
    delivered_at: '2026-08-01T10:00:00.000Z',
    due_at: '2026-08-08',
    state: 'AWAITING',
    version: 1,
    ...overrides,
  };
}

export function batchRow(overrides: Record<string, unknown> = {}) {
  return {
    cod_batch_id: BATCH_ID,
    shop_id: SHOP_ID,
    courier_account_id: COURIER_ACCOUNT_ID,
    batch_reference: 'COD-20260806-0001',
    filename: 'remittance.csv',
    content_hash: 'hash-1',
    column_map_id: null,
    remittance_reference: 'REM-1',
    remittance_date: '2026-08-05',
    declared_total: null,
    state: 'UPLOADED',
    matched_count: 0,
    unmatched_count: 0,
    unmatched_json: [],
    version: 1,
    ...overrides,
  };
}
