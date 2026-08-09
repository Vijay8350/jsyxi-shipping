import { Pool } from 'pg';
import type { NdrCaseRow } from '../../src/modules/ndr/ndr.types';

/**
 * Test doubles for the NDR specs, following the test/tracking FnPool
 * pattern: regex-matched SQL handlers over a recorded call log, plus a stub
 * audit writer and a stub AdapterCallerService.
 */

export const SHOP_ID = '11111111-1111-1111-1111-111111111111';
export const MEMBER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
export const ORDER_ID = '22222222-2222-2222-2222-222222222222';
export const SHIPMENT_ID = '33333333-3333-3333-3333-333333333333';
export const COURIER_ACCOUNT_ID = '88888888-8888-8888-8888-888888888888';
export const NDR_CASE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
export const NDR_ACTION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
export const RESPONSE_ID = 'abababab-abab-abab-abab-abababababab';
export const TOKEN_ID = 'acacacac-acac-acac-acac-acacacacacac';

export const AWB = 'DL12345';
export const FIRST_NDR_AT = '2026-08-01T10:00:00.000Z';
export const ATTEMPT_2_AT = '2026-08-02T10:00:00.000Z';

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

export function caseRow(overrides: Record<string, unknown> = {}): NdrCaseRow {
  return {
    ndr_case_id: NDR_CASE_ID,
    shop_id: SHOP_ID,
    shipment_id: SHIPMENT_ID,
    attempt_count: 1,
    reason_code: 'OTHER',
    first_ndr_at: FIRST_NDR_AT,
    last_ndr_at: FIRST_NDR_AT,
    state: 'OPEN',
    auto_rto_warn_at: '2026-08-03T10:00:00.000Z',
    version: 1,
    created_at: FIRST_NDR_AT,
    updated_at: FIRST_NDR_AT,
    ...overrides,
  } as NdrCaseRow;
}

export function shipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    shipment_id: SHIPMENT_ID,
    awb_normalized: AWB,
    courier_account_id: COURIER_ACCOUNT_ID,
    movement_state: 'NDR',
    is_test: false,
    ...overrides,
  };
}

/**
 * Stub AdapterCallerService: records calls and invokes the configured fake
 * adapter, exactly like the real service's `call(shop, account, method, fn)`.
 */
export function stubAdapterCaller(result: {
  accepted?: boolean;
  providerAck?: string | null;
  throwError?: Error;
}) {
  const calls: Array<{ shopId: string; accountId: string; method: string; awb: string; action: string }> = [];
  return {
    calls,
    call: (
      shopId: string,
      accountId: string,
      method: string,
      invoke: (adapter: {
        ndrAction: (req: { awb: string; action: string }) => Promise<unknown>;
      }) => Promise<unknown>,
    ) =>
      invoke({
        ndrAction: (req: { awb: string; action: string }) => {
          calls.push({ shopId, accountId, method, awb: req.awb, action: req.action });
          if (result.throwError) return Promise.reject(result.throwError);
          return Promise.resolve({
            accepted: result.accepted ?? true,
            providerAck: result.providerAck ?? 'ack-1',
          });
        },
      }),
  };
}

// SQL patterns shared across specs.
export const SQL = {
  getCase: /SELECT \* FROM ndr_case\s+WHERE shop_id = \$1 AND ndr_case_id = \$2/,
  latestCase: /SELECT \* FROM ndr_case\s+WHERE shop_id = \$1 AND shipment_id = \$2\s+ORDER BY created_at/,
  openCase: /state <> 'CLOSED'/,
  attemptReason: /SELECT reason_text FROM tracking_event/,
  insertCase: /INSERT INTO ndr_case/,
  updateCase: /UPDATE ndr_case\s+SET/,
  insertAction: /INSERT INTO ndr_action/,
  loadShipment: /SELECT shipment_id, awb_normalized, courier_account_id/,
  capability: /JOIN courier_capability/,
  getSettings: /FROM ndr_settings WHERE shop_id/,
  upsertSettings: /INSERT INTO ndr_settings/,
  resolveToken: /FROM ndr_response_token/,
  insertResponse: /INSERT INTO ndr_buyer_response/,
  getResponse: /SELECT \* FROM ndr_buyer_response WHERE response_id/,
  linkResponseAction: /UPDATE ndr_buyer_response SET ndr_action_id/,
  flagPaymentLink: /UPDATE ndr_buyer_response\s+SET payload = payload/,
};
