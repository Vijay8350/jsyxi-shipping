import { describe, expect, it } from 'vitest';
import { REPORT_CATALOGUE } from '../../src/modules/reports/report-catalogue';
import { REPORT_GENERATORS } from '../../src/modules/reports/generators';
import { REPORT_CODES } from '../../src/modules/reports/reports.types';

/**
 * §11 catalogue conformance: all 14 codes, each with its §11 notable
 * columns, and a generator registered for every code.
 */

// The §11 "Notable columns" per code, transcribed from spec.md §11.
const SPEC_NOTABLE_COLUMNS: Record<string, string[]> = {
  ORDERS: [
    'order_number', 'created_at', 'order_amount', 'payment_mode',
    'derived_status', 'shipment_count', 'cod_outstanding', 'cod_assignment_state',
  ],
  SHIPMENTS: [
    'awb', 'service', 'booked_at', 'dead_weight_kg', 'billable_weight_kg',
    'expected_cost', 'expected_cost_basis', 'collectible', 'movement_state',
    'delivered_at', 'tat_hours',
  ],
  COURIER_PERF: ['delivery_rate', 'ndr_rate', 'rto_rate', 'avg_tat_hours', 'volume'],
  PINCODE_PERF: ['delivery_rate', 'ndr_rate', 'rto_rate', 'avg_tat_hours', 'volume', 'zone'],
  PAYMENT_MODE: ['payment_mode', 'volume', 'value', 'delivery_rate', 'rto_rate'],
  NDR: ['reason', 'case_state', 'attempts', 'action_taken', 'age_days', 'outcome'],
  RTO: ['rto_initiated_at', 'reason', 'rto_charge', 'rto_delivered_at'],
  SLA_DELAY: ['edd', 'actual', 'delay_hours', 'delayed_flag'],
  RECON_DISPUTES: [
    'awb', 'charge_type', 'invoiced_amount', 'expected_amount', 'audited_amount',
    'flag_awb_not_found', 'flag_weight_mismatch', 'flag_amount_mismatch', 'flag_review',
    'workflow_state', 'batch_residual', 'control_total_state',
  ],
  COD_PENDING: ['expected_amount', 'allocated_amount', 'balance', 'due_date', 'aging_days', 'state'],
  MANUAL_ASSIGNMENT: ['order_number', 'manual_assignment_reason', 'service_failure_reasons', 'age_days'],
  PROFITABILITY: ['order_amount', 'expected_freight', 'invoiced_freight', 'variance', 'margin'],
  INVOICE_PENDING: ['order_number', 'missing_fields', 'age_days'],
  COD_UNASSIGNED: ['order_number', 'cod_outstanding', 'shipments_booked', 'flagged_at', 'age_days'],
};

describe('§11 report catalogue', () => {
  it('contains exactly the 14 §11 codes', () => {
    expect([...REPORT_CODES].sort()).toEqual(
      [
        'COD_PENDING', 'COD_UNASSIGNED', 'COURIER_PERF', 'INVOICE_PENDING',
        'MANUAL_ASSIGNMENT', 'NDR', 'ORDERS', 'PAYMENT_MODE', 'PINCODE_PERF',
        'PROFITABILITY', 'RECON_DISPUTES', 'RTO', 'SHIPMENTS', 'SLA_DELAY',
      ].sort(),
    );
    expect(Object.keys(REPORT_CATALOGUE).sort()).toEqual([...REPORT_CODES].sort());
  });

  it.each(REPORT_CODES)('%s carries every §11 notable column', (code) => {
    const def = REPORT_CATALOGUE[code];
    for (const col of SPEC_NOTABLE_COLUMNS[code] ?? []) {
      expect(def.columns, `${code} missing §11 column '${col}'`).toContain(col);
    }
  });

  it.each(REPORT_CODES)('%s has a registered generator', (code) => {
    expect(REPORT_GENERATORS[code]).toBeTypeOf('function');
  });

  it.each(REPORT_CODES)('%s names its §5.2 attribution date and A2-06 counting unit', (code) => {
    const def = REPORT_CATALOGUE[code];
    expect(def.attribution.length).toBeGreaterThan(0);
    expect(def.countingUnit.length).toBeGreaterThan(0);
  });
});
